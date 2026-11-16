-- Phase 2 (slice 2A): "No preference" / "None for me" answers.
--
-- A pass is how someone answers a question without choosing an option:
--   * 'no_preference' on a Group choice ("I'm happy with whatever the group picks")
--   * 'none_for_me'   on an Own choice  ("I don't want any of these")
-- Without it, a person with nothing to choose stays on "Needs your answer"
-- forever. The table holds no other state. A pass is cleared by the client
-- when the person gives a real answer (and vice versa); nothing here enforces
-- that, it is a read-time union (src/lib/answers/answers.ts).
--
-- Additive only: one new table, two new functions, one trigger on the NEW table.
-- Nothing existing is altered. Re-runnable (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS before CREATE).
--
-- ASSUMPTIONS (verify with the matching section of supabase/PRE_APPLY_CHECKS.sql):
--   1. public.users(id) and public.planning_sections(id, trip_id, status) exist
--      with status of type public.section_status ('completed' = closed).
--   2. Live helpers, all SECURITY DEFINER, signatures exactly:
--        public.is_admin(uuid)                    -> boolean
--        public.is_trip_organizer(uuid, uuid)     -> boolean   (trip_id, user_id)
--        public.is_trip_participant(uuid, uuid)   -> boolean   (trip_id, user_id)
--      Neither trip helper filters on trip_participants.active (same as the
--      option_votes policies), so a deactivated member can still read/answer.
--   3. No object named question_passes, question_pass_trip_id or
--      guard_question_passes_closed_question exists yet.
--   4. The role names `anon` and `authenticated` exist (Supabase).
--   5. The Phase 1 guard on option_votes (20261116100000) uses the message
--      'Voting is closed for this question' and HINT 'voting_closed'; this guard
--      raises the SAME message so the client shows one wording for both tables.
--   6. Realtime: no migration in this repo adds option_votes / selections to the
--      supabase_realtime publication (that was done outside migrations), so the
--      table is added to the publication ONLY IF option_votes is already in it.
--      The client does not subscribe to this table yet (it must not before this
--      migration is applied); passes refresh on the user's own mutations, on
--      window focus and on reconnect.

CREATE TABLE IF NOT EXISTS public.question_passes (
  section_id uuid NOT NULL REFERENCES public.planning_sections (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('no_preference', 'none_for_me')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (section_id, user_id)
);

COMMENT ON TABLE public.question_passes IS
  'A person''s "No preference" (group choice) or "None for me" (own choice) answer to a question. Counts as answered.';

-- Lookups by person (cascade on user delete, "my passes").
CREATE INDEX IF NOT EXISTS question_passes_user_id_idx ON public.question_passes (user_id);

-- Trip of a question. SECURITY DEFINER so the policies below do not depend on
-- the caller being able to read planning_sections directly (admins, organisers).
CREATE OR REPLACE FUNCTION public.question_pass_trip_id(p_section_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ps.trip_id FROM public.planning_sections ps WHERE ps.id = p_section_id
$$;

-- Guard: no passes written or withdrawn on a closed (completed) question.
-- Same carve-outs as guard_option_votes_closed_question: service role / SQL
-- editor (auth.uid() IS NULL) is allowed, and so is a write whose parent
-- question row is already gone (delete cascade).
CREATE OR REPLACE FUNCTION public.guard_question_passes_closed_question()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status public.section_status;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT ps.status
    INTO v_status
    FROM public.planning_sections ps
   WHERE ps.id = COALESCE(NEW.section_id, OLD.section_id);

  IF FOUND AND v_status = 'completed' THEN
    RAISE EXCEPTION 'Voting is closed for this question'
      USING ERRCODE = 'P0001',
            HINT = 'voting_closed';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS question_passes_guard_closed_question ON public.question_passes;
CREATE TRIGGER question_passes_guard_closed_question
  BEFORE INSERT OR DELETE ON public.question_passes
  FOR EACH ROW EXECUTE FUNCTION public.guard_question_passes_closed_question();

ALTER TABLE public.question_passes ENABLE ROW LEVEL SECURITY;

-- Read: trip members (so "N of M answered" works), organisers and admins.
DROP POLICY IF EXISTS question_passes_select ON public.question_passes;
CREATE POLICY question_passes_select ON public.question_passes
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.is_trip_participant(public.question_pass_trip_id(section_id), auth.uid())
    OR public.is_trip_organizer(public.question_pass_trip_id(section_id), auth.uid())
  );

-- Write: only your OWN pass, only on a question of a trip you are in.
DROP POLICY IF EXISTS question_passes_insert_own ON public.question_passes;
CREATE POLICY question_passes_insert_own ON public.question_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_trip_participant(public.question_pass_trip_id(section_id), auth.uid())
  );

DROP POLICY IF EXISTS question_passes_delete_own ON public.question_passes;
CREATE POLICY question_passes_delete_own ON public.question_passes
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    AND public.is_trip_participant(public.question_pass_trip_id(section_id), auth.uid())
  );
-- No UPDATE policy on purpose: the kind follows the question's shape, so
-- changing it is delete + insert.

-- Least privilege: no anonymous access; signed-in users read/insert/delete
-- (row access is then narrowed by the policies above); nobody updates.
REVOKE ALL ON TABLE public.question_passes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.question_passes TO authenticated;
GRANT ALL ON TABLE public.question_passes TO service_role;

-- Trigger function: not callable as an RPC. The trip lookup is only used by
-- the policies (evaluated as the caller), so authenticated keeps EXECUTE on it.
REVOKE ALL ON FUNCTION public.guard_question_passes_closed_question() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.question_pass_trip_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.question_pass_trip_id(uuid) TO authenticated, service_role;

-- Realtime: only when the other answer table is already published.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'option_votes'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'question_passes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.question_passes;
  END IF;
END
$$;
