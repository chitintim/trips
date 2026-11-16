-- To-dos "Who" modes (UX redesign 2.3, slice 2E). NOT APPLIED by the agent that wrote it.
--
-- A to-do's Who is one of three modes, whichever table stores it:
--   Everyone  each person ticks for themselves   (trip_actions, assigned_to NULL, who_mode NULL)
--   [Person]  only that person (or an organizer)  (trip_actions assigned_to set; trip_checklists assigned_to set)
--   Anyone    the first person to claim it owns it (trip_actions who_mode = 'anyone';
--                                                   trip_checklists assigned_to NULL, as today)
--
-- Existing rows keep their CURRENT meaning, with no data change:
--   trip_actions    assigned_to NULL = Everyone, set = a person  (who_mode starts NULL)
--   trip_checklists assigned_to NULL = Anyone,   set = a person
-- trip_actions had no way to say "Anyone", hence who_mode. Claiming sets assigned_to; giving it
-- back clears it. Everyone for a checklist item is NOT stored: those are created as trip_actions.
--
-- Also: a to-do's due date is now optional ("Deadlines are always optional", 3.2), so the
-- "fixed needs a due date" check (trip_actions_due_when_fixed) goes. deadline_kind stays
-- NOT NULL DEFAULT 'fixed'; fixed with no date means "no due date", which the app already labels
-- and ignores for overdue.
--
-- Claiming, giving back and ticking a claimed / Anyone to-do goes through the SECURITY DEFINER
-- RPC public.claim_todo below, NOT through row policies. An earlier draft added permissive UPDATE
-- policies for claim / give-back; those let any participant rewrite or take over an unclaimed row
-- (permissive policies are OR-ed, and WITH CHECK only needs to pass SOME policy). They are removed,
-- and the DROP POLICY IF EXISTS lines below clean up any earlier partial apply. No UPDATE policy is
-- added or changed here; the existing "creator, assignee or organizer" policies stay as they are.
--
-- Update guard: the existing assignee UPDATE policies would otherwise let a claimer (who becomes the
-- assignee) rewrite the whole row. BEFORE UPDATE triggers public.guard_todo_update on trip_actions
-- and trip_checklists (both have trip_id, created_by NOT NULL, assigned_to, all uuid) refuse, for
-- signed-in callers (auth.uid() not NULL; service role / SQL editor are unaffected):
--   * changing trip_id or created_by, and
--   * setting assigned_to to somebody else, unless the caller is the to-do's creator, an admin, the
--     trip creator or an active organizer of the trip. Claiming (assigned_to = self) and clearing
--     (NULL) stay open to anyone the row policies already let update. claim_todo's own updates pass.
-- Assumes trip_participants.role = 'organizer' (as claim_todo already does) and public.is_admin(uuid).
-- claim is idempotent: claiming a to-do already assigned to the caller returns the success payload.
--
-- Safe to re-run.

-- Fail loudly if the due-date constraint is not the one we expect to drop. If it is already gone
-- AND who_mode exists, this is a re-run and we carry on.
DO $$
DECLARE
  v_has_constraint boolean;
  v_has_column boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trip_actions'::regclass AND conname = 'trip_actions_due_when_fixed'
  ) INTO v_has_constraint;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trip_actions' AND column_name = 'who_mode'
  ) INTO v_has_column;

  IF NOT v_has_constraint AND NOT v_has_column THEN
    RAISE EXCEPTION 'Constraint public.trip_actions.trip_actions_due_when_fixed not found and who_mode not yet added: the live constraint name differs from the repo. Find it (see PRE_APPLY_CHECKS 12b/12c) before applying.';
  END IF;
END $$;

ALTER TABLE public.trip_actions ADD COLUMN IF NOT EXISTS who_mode text;

ALTER TABLE public.trip_actions DROP CONSTRAINT IF EXISTS trip_actions_who_mode_check;
ALTER TABLE public.trip_actions
  ADD CONSTRAINT trip_actions_who_mode_check CHECK (who_mode IS NULL OR who_mode IN ('everyone', 'person', 'anyone'));

COMMENT ON COLUMN public.trip_actions.who_mode IS
  'NULL = derive from assigned_to (NULL: Everyone, set: a person). ''anyone'' = up for grabs: assigned_to NULL until someone claims it.';

ALTER TABLE public.trip_actions DROP CONSTRAINT IF EXISTS trip_actions_due_when_fixed;

-- Remove the permissive claim / give-back policies of the earlier draft (no-ops on a clean database).
DROP POLICY IF EXISTS "Participants can claim an up-for-grabs to-do" ON public.trip_actions;
DROP POLICY IF EXISTS "Claimer can give an up-for-grabs to-do back" ON public.trip_actions;
DROP POLICY IF EXISTS "Participants can claim an up-for-grabs checklist item" ON public.trip_checklists;
DROP POLICY IF EXISTS "Claimer can give an up-for-grabs checklist item back" ON public.trip_checklists;

-- ---------------------------------------------------------------------------
-- claim_todo(p_source, p_id, p_action) -> jsonb
--
--   p_source  'action' (trip_actions) | 'checklist' (trip_checklists)
--   p_action  'claim' | 'give_back' | 'tick' | 'untick'
--
-- Returns the resulting state: {"ok": true, "assigned_to": uuid|null, "done": boolean}.
-- Raises (errcode P0001 = rule violated, 42501 = not allowed) with a message safe to show.
--
-- It changes ONLY the assignee and the done columns:
--   trip_actions    assigned_to, completed_at, completed_by
--   trip_checklists assigned_to, done, done_at, done_by
-- (per-person "Everyone" completions in trip_action_completions are not touched: they are
--  own-row inserts under their own policy.)
--
-- Who may call: an ACTIVE participant of the row's trip, an active organizer, the trip creator,
-- or an admin. Rules:
--   claim      only while unassigned and not done; trip_actions only when who_mode = 'anyone'.
--   give_back  the current claimer (or an organizer / admin), and only while not done.
--   tick       trip_actions only when who_mode = 'anyone' and claimed; checklist item only when
--              assigned. By the claimer / assignee, or an organizer / admin.
--   untick     as tick; additionally the person who ticked (done_by / completed_by), which covers
--              a done bring item that has no assignee.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_todo(p_source text, p_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_trip uuid;
  v_assigned uuid;
  v_done boolean;
  v_done_by uuid;
  v_who text;
  v_active boolean;
  v_privileged boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('claim', 'give_back', 'tick', 'untick') THEN
    RAISE EXCEPTION 'Unknown action' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the row so two simultaneous claims resolve cleanly: the second sees the first's result.
  IF p_source = 'action' THEN
    SELECT a.trip_id, a.assigned_to, (a.completed_at IS NOT NULL), a.completed_by, a.who_mode
      INTO v_trip, v_assigned, v_done, v_done_by, v_who
      FROM public.trip_actions a WHERE a.id = p_id FOR UPDATE;
  ELSIF p_source = 'checklist' THEN
    SELECT c.trip_id, c.assigned_to, c.done, c.done_by, NULL::text
      INTO v_trip, v_assigned, v_done, v_done_by, v_who
      FROM public.trip_checklists c WHERE c.id = p_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unknown to-do type' USING ERRCODE = 'P0001';
  END IF;

  IF v_trip IS NULL THEN
    RAISE EXCEPTION 'This to-do no longer exists' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.trip_participants tp
    WHERE tp.trip_id = v_trip AND tp.user_id = v_uid AND tp.active
  ) INTO v_active;

  v_privileged := public.is_admin(v_uid)
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = v_trip AND t.created_by = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.trip_participants tp
      WHERE tp.trip_id = v_trip AND tp.user_id = v_uid AND tp.active AND tp.role = 'organizer'
    );

  IF NOT v_active AND NOT v_privileged THEN
    RAISE EXCEPTION 'You are not on this trip' USING ERRCODE = '42501';
  END IF;

  IF p_source = 'action' AND v_who IS DISTINCT FROM 'anyone' THEN
    RAISE EXCEPTION 'This to-do is not up for grabs' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'claim' THEN
    IF NOT v_active THEN
      RAISE EXCEPTION 'Only people on the trip can take this one' USING ERRCODE = '42501';
    END IF;
    IF v_assigned IS NOT NULL AND v_assigned = v_uid THEN
      -- Already yours (double tap, retry): succeed with the current state.
      RETURN jsonb_build_object('ok', true, 'assigned_to', v_assigned, 'done', v_done);
    END IF;
    IF v_assigned IS NOT NULL THEN
      RAISE EXCEPTION 'Someone else just took this one' USING ERRCODE = 'P0001';
    END IF;
    IF v_done THEN
      RAISE EXCEPTION 'This one is already done' USING ERRCODE = 'P0001';
    END IF;
    v_assigned := v_uid;

  ELSIF p_action = 'give_back' THEN
    IF v_assigned IS NULL THEN
      RAISE EXCEPTION 'Nobody has taken this one' USING ERRCODE = 'P0001';
    END IF;
    IF v_assigned <> v_uid AND NOT v_privileged THEN
      RAISE EXCEPTION 'Only the person who took this can give it back' USING ERRCODE = '42501';
    END IF;
    IF v_done THEN
      RAISE EXCEPTION 'This one is already done' USING ERRCODE = 'P0001';
    END IF;
    v_assigned := NULL;

  ELSIF p_action = 'tick' THEN
    IF v_assigned IS NULL THEN
      RAISE EXCEPTION 'Take this one first' USING ERRCODE = 'P0001';
    END IF;
    IF v_assigned <> v_uid AND NOT v_privileged THEN
      RAISE EXCEPTION 'Only the person who took this can tick it off' USING ERRCODE = '42501';
    END IF;
    v_done := true;
    v_done_by := v_uid;

  ELSE -- untick
    IF NOT (
      v_privileged
      OR (v_assigned IS NOT NULL AND v_assigned = v_uid)
      OR (v_done_by IS NOT NULL AND v_done_by = v_uid)
    ) THEN
      RAISE EXCEPTION 'Only the person who ticked this off can undo it' USING ERRCODE = '42501';
    END IF;
    v_done := false;
    v_done_by := NULL;
  END IF;

  IF p_source = 'action' THEN
    UPDATE public.trip_actions a
       SET assigned_to  = v_assigned,
           completed_at = CASE WHEN v_done THEN COALESCE(a.completed_at, now()) ELSE NULL END,
           completed_by = v_done_by
     WHERE a.id = p_id;
  ELSE
    UPDATE public.trip_checklists c
       SET assigned_to = v_assigned,
           done        = v_done,
           done_at     = CASE WHEN v_done THEN COALESCE(c.done_at, now()) ELSE NULL END,
           done_by     = v_done_by
     WHERE c.id = p_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'assigned_to', v_assigned, 'done', v_done);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_todo(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_todo(text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- guard_todo_update() -> trigger  (see header). SECURITY DEFINER so the organizer / trip-creator
-- lookups are not hidden by RLS; auth.uid() still reflects the caller.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_todo_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A to-do cannot be moved or re-owned' USING ERRCODE = '42501';
  END IF;

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     AND NEW.assigned_to IS NOT NULL
     AND NEW.assigned_to <> v_uid
     AND OLD.created_by IS DISTINCT FROM v_uid
     AND NOT public.is_admin(v_uid)
     AND NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = OLD.trip_id AND t.created_by = v_uid)
     AND NOT EXISTS (
       SELECT 1 FROM public.trip_participants tp
       WHERE tp.trip_id = OLD.trip_id AND tp.user_id = v_uid AND tp.active AND tp.role = 'organizer'
     ) THEN
    RAISE EXCEPTION 'Only the creator or an organizer can assign this to someone else' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_todo_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trip_actions_guard_update ON public.trip_actions;
CREATE TRIGGER trip_actions_guard_update
  BEFORE UPDATE ON public.trip_actions
  FOR EACH ROW EXECUTE FUNCTION public.guard_todo_update();

DROP TRIGGER IF EXISTS trip_checklists_guard_update ON public.trip_checklists;
CREATE TRIGGER trip_checklists_guard_update
  BEFORE UPDATE ON public.trip_checklists
  FOR EACH ROW EXECUTE FUNCTION public.guard_todo_update();
