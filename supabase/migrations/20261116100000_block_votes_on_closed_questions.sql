-- Additive server-side guard: no votes can be cast, changed or withdrawn on a
-- closed question (planning_sections.status = 'completed').
--
-- The UI already stops this, but the existing option_votes RLS policies only
-- check membership/ownership (and are not in this repo, so they are NOT
-- replaced here). A BEFORE trigger is purely additive: it can only reject
-- writes the policies would otherwise have allowed.
--
-- Assumptions about the live schema (see scratchpad schema.txt):
--   option_votes(id, option_id -> options.id, user_id, rank, created_at)
--   options(id, section_id -> planning_sections.id)
--   planning_sections(id, status section_status in not_started|in_progress|completed)
--
-- Deliberate carve-outs:
--   * auth.uid() IS NULL (service role / edge functions / SQL editor) is allowed,
--     so admin tooling and the AI apply path keep working.
--   * If the parent option/section row no longer exists (cascade from deleting
--     an option or section) the write is allowed, so those cascades are never
--     blocked. NOTE: this also means deleting an option/section on a closed
--     question still works. Deleting a USER is NOT covered by this carve-out
--     (the options still exist, so the guard would reject the vote cascade
--     for a signed-in caller); it is only unaffected in practice because user
--     deletion runs as GoTrue admin where auth.uid() IS NULL (allowed above).
--   * `selections` is intentionally NOT guarded: it holds personal-order picks
--     (and legacy committed choices), not votes.
--
-- Re-runnable: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION public.guard_option_votes_closed_question()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_option_id uuid;
  v_status    public.section_status;
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
    SELECT ps.status
      INTO v_status
      FROM public.options o
      JOIN public.planning_sections ps ON ps.id = o.section_id
     WHERE o.id = v_option_id;

    IF FOUND AND v_status = 'completed' THEN
      RAISE EXCEPTION 'Voting is closed for this question'
        USING ERRCODE = 'P0001',
              HINT = 'voting_closed';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS option_votes_guard_closed_question ON public.option_votes;
CREATE TRIGGER option_votes_guard_closed_question
  BEFORE INSERT OR UPDATE OR DELETE ON public.option_votes
  FOR EACH ROW EXECUTE FUNCTION public.guard_option_votes_closed_question();

-- Trigger function: must not be callable as an RPC.
REVOKE ALL ON FUNCTION public.guard_option_votes_closed_question() FROM PUBLIC, anon, authenticated;
