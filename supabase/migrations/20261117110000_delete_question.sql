-- Phase 2: delete a whole question in ONE transaction, and enforce "answers
-- closed" on the `selections` table.
--
-- ADDITIVE ONLY: one new function, one new trigger function, one new trigger.
-- Nothing existing is altered. Re-runnable (CREATE OR REPLACE / DROP TRIGGER
-- IF EXISTS).
--
-- (a) public.delete_question(p_section_id uuid) RETURNS jsonb
--     Replaces the old client-side multi-step delete (which could remove every
--     option and answer and THEN fail on a later foreign key, leaving a
--     question with no options). Organiser / trip creator / admin only (same
--     rule as reset_trip_confirmations, 20261116090000).
--
--     Removed:  the question, its options, everyone's answers (option_votes,
--               selections, question_passes), comments and reactions on it,
--               and the to-dos that exist only to ask people to answer it.
--     KEPT:     bookings, timeline events and expenses made from its options
--               (their option link is cleared; they are never deleted), and
--               any to-do that is not an "answer this question" to-do.
--
--     Which to-dos are "answer this question" to-dos? There is NO marker
--     column or kind. In the app every trip_actions row with a section_id is
--     completed by answering that section (src/features/actions/lib/
--     actionStatus.ts hasVotedInSectionId; computeTodos.ts answeredLinked;
--     auto-chase outstandingTargets). Bookings are in the separate `bookings`
--     table and there is no 'org_book' action kind anywhere in the repo, so
--     there is no follow-up to-do shape linked by section_id. Rule chosen:
--     DELETE every trip_actions row whose section_id is this question (their
--     completions/reminders are deleted explicitly). Any row that somehow
--     still references the section afterwards would be un-linked
--     (section_id := NULL), so todos_kept is expected to be 0.
--
--     FK delete actions for options/selections/comments/reactions/expenses/
--     trip_timeline_events/planning_sections referrers are NOT confirmed in
--     supabase/PRE_APPLY_CHECKS.sql section 12 / live-checks, so every step is
--     explicit and ordered to be safe whichever action the live FK has.
--     Confirmed live: option_votes.option_id CASCADE, bookings.option_id SET
--     NULL, trip_actions.section_id SET NULL, question_passes.section_id CASCADE.
--
--     Interaction with the closed-question guards: option_votes and
--     question_passes guards (20261116100000 / 20261117090000) allow a write
--     only when the parent option/section row is gone, so options are deleted
--     BEFORE votes and the section BEFORE passes and the cascades are then
--     allowed. `selections` may use NO ACTION, so selections are deleted while
--     the option still exists; the new selections guard below honours a
--     transaction-local flag app.deleting_question = '<section id>' which only
--     this SECURITY DEFINER function sets (set_config(..., true)); PostgREST
--     cannot call set_config (it is not in the public schema), and the flag is
--     matched to the option's own section so it cannot open any other question.
--
-- (b) guard_selections_closed_question (C3 of the Phase 2 review): "Close
--     answers" said it stops anyone changing their answer, but the Phase 1
--     guard deliberately left `selections` out. This adds the same BEFORE
--     trigger on `selections`, with EXACTLY the carve-outs of
--     guard_option_votes_closed_question: auth.uid() IS NULL is allowed
--     (service role, edge functions, SQL editor); a missing parent option or
--     section is allowed (cascades work); organisers and admins are NOT
--     exempt (they are not exempt on option_votes either; reopen the question
--     to change answers).
--
--     LEGACY RISK (read before applying): `selections` also holds personal /
--     "own choice" answers (decision_shape 'personal'; see
--     20260707160000_legacy_sections_to_personal.sql), and live has 18
--     completed sections (6 completed trips). Any completed section that still
--     has selections becomes read-only for signed-in users, including people
--     who used to keep editing their own order after a section was marked
--     completed. The current UI treats completed sections as closed and
--     finished trips as read-only, so this matches the UI, but run
--     PRE_APPLY_CHECKS.sql section 13 first and decide whether any section
--     should be reopened. Edge functions using the service role are unaffected.
--
-- Messages: 'Answers are closed for this question', HINT 'answers_closed'
-- (describeAnswerError in the client recognises it).

-- ---------------------------------------------------------------------------
-- (b) selections guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_selections_closed_question()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_option_id  uuid;
  v_section_id uuid;
  v_status     public.section_status;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOR v_option_id IN
    SELECT DISTINCT x
    FROM unnest(ARRAY[
      CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.option_id END,
      CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.option_id END
    ]) AS x
    WHERE x IS NOT NULL
  LOOP
    SELECT ps.id, ps.status
      INTO v_section_id, v_status
      FROM public.options o
      JOIN public.planning_sections ps ON ps.id = o.section_id
     WHERE o.id = v_option_id;

    IF FOUND AND v_status = 'completed' THEN
      -- delete_question() (SECURITY DEFINER, below) sets this for its own
      -- transaction only, naming the one section it is deleting.
      IF TG_OP = 'DELETE'
         AND COALESCE(current_setting('app.deleting_question', true), '') = v_section_id::text THEN
        CONTINUE;
      END IF;

      RAISE EXCEPTION 'Answers are closed for this question'
        USING ERRCODE = 'P0001',
              HINT = 'answers_closed';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS selections_guard_closed_question ON public.selections;
CREATE TRIGGER selections_guard_closed_question
  BEFORE INSERT OR UPDATE OR DELETE ON public.selections
  FOR EACH ROW EXECUTE FUNCTION public.guard_selections_closed_question();

-- Trigger function: must not be callable as an RPC.
REVOKE ALL ON FUNCTION public.guard_selections_closed_question() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (a) delete_question
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_question(p_section_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_trip_id      uuid;
  v_title        text;
  v_option_ids   uuid[];
  v_options      integer := 0;
  v_votes        integer := 0;
  v_selections   integer := 0;
  v_passes       integer := 0;
  v_todo_ids     uuid[];
  v_todos_del    integer := 0;
  v_todos_kept   integer := 0;
  v_bookings     integer := 0;
  v_events       integer := 0;
  v_expenses     integer := 0;
  v_comment_ids  uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Find and lock the question.
  SELECT ps.trip_id, ps.title
    INTO v_trip_id, v_title
    FROM public.planning_sections ps
   WHERE ps.id = p_section_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.is_admin(v_uid)
    -- Inline (not is_trip_organizer(), which has no active filter) so that
    -- removed/inactive organisers are excluded.
    OR EXISTS (
      SELECT 1 FROM public.trip_participants o
      WHERE o.trip_id = v_trip_id AND o.user_id = v_uid
        AND o.role = 'organizer'::public.participant_role AND o.active
    )
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = v_trip_id AND t.created_by = v_uid)
  ) THEN
    RAISE EXCEPTION 'Only trip organizers and admins can delete a question'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(o.id), '{}'::uuid[]) INTO v_option_ids
    FROM public.options o WHERE o.section_id = p_section_id;
  v_options := COALESCE(array_length(v_option_ids, 1), 0);

  -- Let the selections guard allow deleting answers of this one question.
  PERFORM set_config('app.deleting_question', p_section_id::text, true);

  -- Counts of what is kept / removed (before anything changes).
  SELECT count(*) INTO v_votes FROM public.option_votes WHERE option_id = ANY (v_option_ids);
  SELECT count(*) INTO v_selections FROM public.selections WHERE option_id = ANY (v_option_ids);
  SELECT count(*) INTO v_bookings FROM public.bookings WHERE option_id = ANY (v_option_ids);
  SELECT count(*) INTO v_events FROM public.trip_timeline_events WHERE source_option_id = ANY (v_option_ids);
  SELECT count(*) INTO v_expenses FROM public.expenses WHERE option_id = ANY (v_option_ids);
  IF to_regclass('public.question_passes') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.question_passes WHERE section_id = $1'
      INTO v_passes USING p_section_id;
  END IF;

  -- 1. "Answer this question" to-dos: every to-do linked to the section (see
  --    header). Completions and reminders go first (explicit, FK-agnostic).
  SELECT COALESCE(array_agg(a.id), '{}'::uuid[]) INTO v_todo_ids
    FROM public.trip_actions a WHERE a.section_id = p_section_id;
  v_todos_del := COALESCE(array_length(v_todo_ids, 1), 0);
  DELETE FROM public.trip_action_completions WHERE action_id = ANY (v_todo_ids);
  DELETE FROM public.trip_action_reminders WHERE action_id = ANY (v_todo_ids);
  DELETE FROM public.trip_actions WHERE id = ANY (v_todo_ids);
  -- Defensive: nothing should be left, but never leave a dangling link.
  UPDATE public.trip_actions SET section_id = NULL WHERE section_id = p_section_id;
  GET DIAGNOSTICS v_todos_kept = ROW_COUNT;

  -- 2. Things that are KEPT lose their link to the options (never deleted).
  UPDATE public.bookings SET option_id = NULL WHERE option_id = ANY (v_option_ids);
  UPDATE public.trip_timeline_events SET source_option_id = NULL WHERE source_option_id = ANY (v_option_ids);
  UPDATE public.expenses SET option_id = NULL WHERE option_id = ANY (v_option_ids);

  -- 3. Comments and reactions on the question or its options (reactions on
  --    those comments first).
  SELECT COALESCE(array_agg(c.id), '{}'::uuid[]) INTO v_comment_ids
    FROM public.comments c
   WHERE c.section_id = p_section_id OR c.option_id = ANY (v_option_ids);
  DELETE FROM public.reactions
   WHERE option_id = ANY (v_option_ids) OR comment_id = ANY (v_comment_ids);
  DELETE FROM public.comments WHERE id = ANY (v_comment_ids);

  -- 4. Answers. Selections first, while the options still exist (the flag
  --    above lets the guard through). Then the options: option_votes cascade
  --    from them, and their guard allows it because the option is gone.
  DELETE FROM public.selections WHERE option_id = ANY (v_option_ids);
  DELETE FROM public.options WHERE section_id = p_section_id;

  -- 5. The question. question_passes cascade from it (guard allows: section gone).
  DELETE FROM public.planning_sections WHERE id = p_section_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_trip_id,
    v_uid,
    'question_deleted',
    jsonb_build_object('type', 'question', 'label', v_title),
    jsonb_build_object(
      'title', v_title,
      'options', v_options,
      'votes', v_votes,
      'selections', v_selections,
      'passes', v_passes,
      'todos_deleted', v_todos_del,
      'todos_kept', v_todos_kept,
      'bookings_kept', v_bookings,
      'events_kept', v_events,
      'expenses_kept', v_expenses
    )
  );

  RETURN jsonb_build_object(
    'title', v_title,
    'options', v_options,
    'votes', v_votes,
    'selections', v_selections,
    'passes', v_passes,
    'todos_deleted', v_todos_del,
    'todos_kept', v_todos_kept,
    'bookings_kept', v_bookings,
    'events_kept', v_events,
    'expenses_kept', v_expenses
  );
END;
$$;

COMMENT ON FUNCTION public.delete_question(uuid) IS
  'Organizer/admin-only (checked inside): deletes a question with its options, answers (votes, selections, passes), comments/reactions and its "answer this question" to-dos in one transaction. Bookings, timeline events and expenses are kept (option link cleared). Logs a question_deleted activity row.';

REVOKE ALL ON FUNCTION public.delete_question(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_question(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_question(uuid) TO authenticated;
