-- Phase 4A: decide a question in ONE step, decide it automatically at its
-- deadline, and mark an option booked / un-booked. NOT APPLIED by the agent
-- that wrote it.
--
-- ADDITIVE ONLY: new functions only. No table, column, policy or trigger is
-- created or changed. Re-runnable (CREATE OR REPLACE).
--
--   public.decide_question(section, option, put_on_plan, book_todo)  authenticated
--   public.auto_decide_question(section)                              service_role ONLY
--   public.mark_booked(option, booking)                               authenticated
--   public.unmark_booked(option, cancel_booking, reopen_question)     authenticated
--   public.question_vote_tally(section, in_scope_only)                internal (nobody)
--   public.assert_can_manage_trip(trip, user)                         internal (nobody)
--
-- WHO MAY CALL (copied from reset_trip_confirmations 20261116090000 and
-- delete_question 20261117110000): an ACTIVE organizer of the trip, the trip
-- creator, or a site admin. SECURITY DEFINER, pinned search_path, REVOKEd from
-- PUBLIC/anon, GRANTed to authenticated. The check is the same inline rule (not
-- is_trip_organizer(), which has no active filter) in assert_can_manage_trip.
--
-- ASSUMPTIONS (verify on live with PRE_APPLY_CHECKS group 14):
--   * planning_sections.status enum section_status = not_started|in_progress|
--     completed; "open" = anything but completed; "Reopen" sets in_progress
--     (ReopenDecisionDialog / buildReopenUpdate).
--   * Decision stamp = planning_sections.metadata {decided_option_id,
--     followup_action_id}, merged never overwritten (closeDecision.ts).
--   * Own choice = metadata.decision_shape = 'personal' (getDecisionShape).
--   * Group-choice answers live in option_votes (selections are not tallied,
--     exactly like resolveDecision.ts).
--   * trips.chase_settings is JSONB (nullable). The per-trip switch is the
--     key chase_settings.auto_decide: ABSENT or anything but false/"false" =
--     ON (owner default Q1). It only ever matters to auto_decide_question,
--     which only acts on questions whose vote_deadline has PASSED.
--   * activity_feed has no verb CHECK; actor may be NULL; this code inserts as
--     the function owner so the participant-only INSERT policy does not apply.
--   * trip_actions columns as in schema.txt (+ who_mode if 20261117100000 is
--     applied; this migration never writes who_mode). If the old constraint
--     trip_actions_due_when_fixed still exists a "Book it" to-do with no due
--     date is stored as deadline_kind='before_trip' instead of fixed+NULL; if
--     it is gone (2E applied) it is stored fixed + NULL ("no due date").
--   * bookings.status text; the app uses reserved|paid|cancelled.
--
-- THE "BOOK:" TO-DO (IMPORTANT, read before touching the to-dos engine)
--   The to-do created by decide_question has section_id = NULL ON PURPOSE.
--   A trip_actions row WITH a section_id means "answer this question": the
--   engine marks it done when the assignee has voted (isActionDoneFor ->
--   answeredLinked) and shows "No longer needed - the question is closed"
--   as soon as the question completes (todoModel noLongerNeeded). A "Book it"
--   to-do must survive the question closing, so it is NOT linked that way.
--   Its link is the existing stamp: planning_sections.metadata.followup_action_id
--   (+ decided_option_id names the option). The to-do title is
--   "Book: <option title>" (same string as copy.orgBookTitle) so the synthetic
--   org_book to-do and the real one read identically. The engine must NOT show
--   both: see phase4-interfaces.md ("real Book: replaces synthetic org_book").
--
-- WINNER RULE FOR auto_decide_question (mirrors resolveDecision.resolveWinner)
--   live options = options.status <> 'cancelled'
--   score: single / approval (any non-'ranked' method) = number of option_votes
--          rows; ranked = sum over votes of (voter's max rank - rank + 1)
--          (tallyVotes' Borda count, effective rank = stored rank)
--   only votes from people in scope (active, not declined/cancelled) count
--   top score 0 -> nobody answered -> not decided
--   fewer distinct in-scope voters than planning_sections.quorum (when set), or
--   else than ceil(in-scope people / 2) -> not_enough_answers (answered, needed)
--   more than one option shares the top score -> TIED -> not decided
--   else the single top option wins.
--   resolveWinner would apply tie-breaks (ranked first choices, earliest
--   date range, order_index, created_at, id) to a tie and flag tied=true; the
--   SQL deliberately never decides a tie, so it needs none of them: whenever it
--   decides, resolveWinner returns the same option with tied=false (checked by
--   the fixture table in src/features/decisions/lib/autoDecideRule.test.ts).
--   NARROWER than the client rule: (1) ranked questions where any live vote has
--   a NULL rank (legacy ranked votes; the client orders them by created_at and
--   array order, which SQL cannot reproduce) are skipped as 'ranked_null_rank'
--   (live had none); (2) date polls (an option has metadata.date_range, or the
--   question is titled "Trip dates") and Own-choice questions are never
--   auto-decided; (3) finished trips are not touched. A recorded stamp is
--   ignored for an open question, as in the client.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_manage_trip(p_trip_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    public.is_admin(p_user_id)
    OR EXISTS (
      SELECT 1 FROM public.trip_participants o
      WHERE o.trip_id = p_trip_id AND o.user_id = p_user_id
        AND o.role = 'organizer'::public.participant_role AND o.active
    )
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.created_by = p_user_id)
  ) THEN
    RAISE EXCEPTION 'Only trip organizers and admins can do this'
      USING ERRCODE = '42501', HINT = 'not_organizer';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_can_manage_trip(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Per-option score of a question's live options (see header for the rule).
-- null_rank_votes is the number of live ranked votes with a NULL rank (the same
-- value on every row; 0 for non-ranked questions).
CREATE OR REPLACE FUNCTION public.question_vote_tally(p_section_id uuid, p_in_scope_only boolean DEFAULT false)
RETURNS TABLE (opt_id uuid, score integer, first_places integer, null_rank_votes integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_method  text;
  v_trip_id uuid;
BEGIN
  SELECT ps.voting_method, ps.trip_id INTO v_method, v_trip_id FROM public.planning_sections ps WHERE ps.id = p_section_id;

  IF v_method = 'ranked' THEN
    RETURN QUERY
    WITH lv AS (
      SELECT v.option_id AS oid, v.user_id AS uid, v.rank AS rk
      FROM public.option_votes v
      JOIN public.options o ON o.id = v.option_id
      WHERE o.section_id = p_section_id AND o.status <> 'cancelled'
        AND (NOT p_in_scope_only OR EXISTS (
          SELECT 1 FROM public.trip_participants tp
           WHERE tp.trip_id = v_trip_id AND tp.user_id = v.user_id AND tp.active
             AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')))
    ),
    vm AS (
      SELECT lv.uid AS uid, max(lv.rk) AS mr FROM lv WHERE lv.rk IS NOT NULL GROUP BY lv.uid
    ),
    nul AS (
      SELECT count(*)::integer AS n FROM lv WHERE lv.rk IS NULL
    )
    SELECT o.id,
           COALESCE(sum(vm.mr - lv.rk + 1) FILTER (WHERE lv.rk IS NOT NULL), 0)::integer,
           (count(*) FILTER (WHERE lv.rk = 1))::integer,
           (SELECT nul.n FROM nul)
    FROM public.options o
    LEFT JOIN lv ON lv.oid = o.id
    LEFT JOIN vm ON vm.uid = lv.uid
    WHERE o.section_id = p_section_id AND o.status <> 'cancelled'
    GROUP BY o.id;
  ELSE
    RETURN QUERY
    SELECT o.id,
           count(v.id)::integer,
           0,
           0
    FROM public.options o
    LEFT JOIN public.option_votes v ON v.option_id = o.id
      AND (NOT p_in_scope_only OR EXISTS (
        SELECT 1 FROM public.trip_participants tp
         WHERE tp.trip_id = v_trip_id AND tp.user_id = v.user_id AND tp.active
           AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')))
    WHERE o.section_id = p_section_id AND o.status <> 'cancelled'
    GROUP BY o.id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.question_vote_tally(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- decide_question
-- ---------------------------------------------------------------------------
-- p_put_on_plan: {"date":"YYYY-MM-DD","start_time":"HH:MM"?,"end_time":"HH:MM"?,"all_day":bool?}
--   -> trip_timeline_events row with source_option_id (title = option title,
--      description = option description, place_id = option place_id; category
--      from the question type). Skipped (existing event reused) when an event
--      already has this option as its source_option_id. Group choice only.
-- p_book_todo: {"assigned_to":uuid?,"due_date":"YYYY-MM-DD"?,"title":text?}
--   -> trip_actions row "Book: <option>" assigned to assigned_to (default: the
--      caller; must be an active participant), section_id NULL (see header),
--      its id stamped into the section metadata as followup_action_id. An
--      existing followup_action_id that still points at a to-do is reused.
-- Returns {section_id, option_id, event_id, action_id, tied, already_decided}.
-- Errors (P0001, HINT in brackets): question not found (P0002), not organizer
-- (42501), already decided with another winner [already_decided], option
-- required [option_required] / not on this question or removed [invalid_option],
-- Own choice given an option or plan/to-do [own_choice], bad date/assignee.

CREATE OR REPLACE FUNCTION public.decide_question(
  p_section_id   uuid,
  p_option_id    uuid  DEFAULT NULL,
  p_put_on_plan  jsonb DEFAULT NULL,
  p_book_todo    jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_trip_id       uuid;
  v_title         text;
  v_status        public.section_status;
  v_meta          jsonb;
  v_section_type  text;
  v_own           boolean;
  v_stamp         text;
  v_opt_title     text;
  v_opt_desc      text;
  v_opt_place     uuid;
  v_opt_status    public.option_status;
  v_top           integer;
  v_top_n         integer;
  v_tied          boolean := false;
  v_event_id      uuid;
  v_event_reused  boolean := false;
  v_action_id     uuid;
  v_action_reused boolean := false;
  v_event_date    date;
  v_start         time;
  v_end           time;
  v_all_day       boolean;
  v_category      public.timeline_event_category;
  v_assignee      uuid;
  v_due           date;
  v_kind          text;
  v_todo_title    text;
  v_followup      text;
  v_new_meta      jsonb;
  v_already       boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Permission BEFORE the row lock, so a non-organizer can neither take the
  -- lock nor probe it.
  SELECT ps.trip_id INTO v_trip_id FROM public.planning_sections ps WHERE ps.id = p_section_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.assert_can_manage_trip(v_trip_id, v_uid);

  SELECT ps.trip_id, ps.title, ps.status, ps.metadata, ps.section_type::text
    INTO v_trip_id, v_title, v_status, v_meta, v_section_type
    FROM public.planning_sections ps
   WHERE ps.id = p_section_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;

  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    v_meta := '{}'::jsonb;
  END IF;
  v_own := COALESCE((v_meta ->> 'decision_shape') = 'personal', false);
  v_stamp := v_meta ->> 'decided_option_id';

  -- Already closed: idempotent success only for the same outcome.
  IF v_status = 'completed' THEN
    IF v_own AND p_option_id IS NULL THEN
      RETURN jsonb_build_object(
        'section_id', p_section_id, 'option_id', NULL, 'event_id', NULL,
        'action_id', NULLIF(v_meta ->> 'followup_action_id', ''), 'tied', false, 'already_decided', true);
    END IF;
    IF NOT v_own AND p_option_id IS NOT NULL AND v_stamp = p_option_id::text THEN
      IF p_put_on_plan IS NULL AND p_book_todo IS NULL THEN
        SELECT e.id INTO v_event_id FROM public.trip_timeline_events e
         WHERE e.source_option_id = p_option_id ORDER BY e.created_at LIMIT 1;
        RETURN jsonb_build_object(
          'section_id', p_section_id, 'option_id', p_option_id, 'event_id', v_event_id,
          'action_id', NULLIF(v_meta ->> 'followup_action_id', ''), 'tied', false, 'already_decided', true);
      END IF;
      -- Same winner, but a plan event / Book: to-do was asked for: create what
      -- does not exist yet (an organizer and the job can race), decide nothing new.
      v_already := true;
    ELSE
      RAISE EXCEPTION 'This question has already been decided. Reopen it to change the answer.'
        USING ERRCODE = 'P0001', HINT = 'already_decided';
    END IF;
  END IF;

  -- ---- Own choice: just stop taking answers --------------------------------
  IF v_own THEN
    IF p_option_id IS NOT NULL OR p_put_on_plan IS NOT NULL OR p_book_todo IS NOT NULL THEN
      RAISE EXCEPTION 'An own-choice question has no single winner, so it cannot be put on the plan or booked from here'
        USING ERRCODE = 'P0001', HINT = 'own_choice';
    END IF;

    UPDATE public.planning_sections SET status = 'completed' WHERE id = p_section_id;

    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_trip_id, v_uid, 'poll_closed',
            jsonb_build_object('type', 'section', 'id', p_section_id, 'label', v_title),
            jsonb_build_object('own_choice', true));

    RETURN jsonb_build_object(
      'section_id', p_section_id, 'option_id', NULL, 'event_id', NULL, 'action_id', NULL,
      'tied', false, 'already_decided', false);
  END IF;

  -- ---- Group choice: validate the winner -----------------------------------
  IF p_option_id IS NULL THEN
    RAISE EXCEPTION 'Choose the winning option' USING ERRCODE = 'P0001', HINT = 'option_required';
  END IF;

  SELECT o.title, o.description, o.place_id, o.status
    INTO v_opt_title, v_opt_desc, v_opt_place, v_opt_status
    FROM public.options o
   WHERE o.id = p_option_id AND o.section_id = p_section_id;

  IF NOT FOUND OR (v_opt_status = 'cancelled' AND NOT v_already) THEN
    RAISE EXCEPTION 'That option is not on this question any more'
      USING ERRCODE = 'P0001', HINT = 'invalid_option';
  END IF;

  -- Informational: was the vote tied at the top? (the caller may still override)
  SELECT max(t.score) INTO v_top FROM public.question_vote_tally(p_section_id) t;
  IF COALESCE(v_top, 0) > 0 THEN
    SELECT count(*) INTO v_top_n FROM public.question_vote_tally(p_section_id) t WHERE t.score = v_top;
    v_tied := v_top_n > 1;
  END IF;

  -- ---- Optional: put it on the plan ----------------------------------------
  IF p_put_on_plan IS NOT NULL AND jsonb_typeof(p_put_on_plan) = 'object' THEN
    SELECT e.id INTO v_event_id
      FROM public.trip_timeline_events e
     WHERE e.source_option_id = p_option_id ORDER BY e.created_at LIMIT 1;

    IF FOUND THEN
      v_event_reused := true;
    ELSE
      BEGIN
        v_event_date := NULLIF(btrim(COALESCE(p_put_on_plan ->> 'date', '')), '')::date;
        v_start := NULLIF(btrim(COALESCE(p_put_on_plan ->> 'start_time', '')), '')::time;
        v_end := NULLIF(btrim(COALESCE(p_put_on_plan ->> 'end_time', '')), '')::time;
        v_all_day := COALESCE((p_put_on_plan ->> 'all_day')::boolean, v_start IS NULL);
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
        RAISE EXCEPTION 'The day or time for the plan is not valid' USING ERRCODE = 'P0001', HINT = 'invalid_plan_date';
      END;
      IF v_event_date IS NULL THEN
        RAISE EXCEPTION 'Pick a day to put this on the plan' USING ERRCODE = 'P0001', HINT = 'invalid_plan_date';
      END IF;

      v_category := (CASE v_section_type
        WHEN 'accommodation' THEN 'accommodation'
        WHEN 'flights'       THEN 'flight'
        WHEN 'transport'     THEN 'transport'
        WHEN 'activities'    THEN 'activity'
        WHEN 'lessons'       THEN 'activity'
        ELSE 'other'
      END)::public.timeline_event_category;

      INSERT INTO public.trip_timeline_events
        (trip_id, created_by, title, description, category, event_date, all_day, start_time, end_time, place_id, source_option_id)
      VALUES
        (v_trip_id, v_uid, left(v_opt_title, 200), v_opt_desc, v_category, v_event_date, v_all_day, v_start, v_end, v_opt_place, p_option_id)
      RETURNING id INTO v_event_id;
    END IF;
  END IF;

  -- ---- Optional: the "Book: <option>" to-do ----------------------------------
  v_followup := NULLIF(v_meta ->> 'followup_action_id', '');
  IF p_book_todo IS NOT NULL AND jsonb_typeof(p_book_todo) = 'object' THEN
    IF v_followup IS NOT NULL THEN
      SELECT a.id INTO v_action_id FROM public.trip_actions a
       WHERE a.id::text = v_followup AND a.trip_id = v_trip_id;
      IF FOUND THEN v_action_reused := true; END IF;
    END IF;

    IF NOT v_action_reused THEN
      BEGIN
        v_assignee := COALESCE(NULLIF(btrim(COALESCE(p_book_todo ->> 'assigned_to', '')), '')::uuid, v_uid);
        v_due := NULLIF(btrim(COALESCE(p_book_todo ->> 'due_date', '')), '')::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
        RAISE EXCEPTION 'The person or due date for the to-do is not valid' USING ERRCODE = 'P0001', HINT = 'invalid_todo';
      END;

      IF NOT EXISTS (
        SELECT 1 FROM public.trip_participants tp
         WHERE tp.trip_id = v_trip_id AND tp.user_id = v_assignee AND tp.active
      ) THEN
        RAISE EXCEPTION 'The person doing the booking has to be on the trip'
          USING ERRCODE = 'P0001', HINT = 'assignee_not_on_trip';
      END IF;

      v_kind := 'fixed';
      IF v_due IS NULL AND EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.trip_actions'::regclass AND conname = 'trip_actions_due_when_fixed'
      ) THEN
        v_kind := 'before_trip';  -- old schema cannot store "fixed, no date"
      END IF;

      v_todo_title := left(COALESCE(NULLIF(btrim(COALESCE(p_book_todo ->> 'title', '')), ''), 'Book: ' || v_opt_title), 120);

      INSERT INTO public.trip_actions (trip_id, title, notes, created_by, assigned_to, deadline_kind, due_date, section_id)
      VALUES (
        v_trip_id, v_todo_title,
        left('From the question "' || v_title || '" - decided: ' || v_opt_title || '.', 400),
        v_uid, v_assignee, v_kind, v_due, NULL)
      RETURNING id INTO v_action_id;
    END IF;
  END IF;

  -- ---- Same winner as before: only the missing extras were created ---------------
  IF v_already THEN
    IF v_action_id IS NOT NULL AND v_action_id::text IS DISTINCT FROM v_followup THEN
      UPDATE public.planning_sections
         SET metadata = v_meta || jsonb_build_object('followup_action_id', v_action_id)
       WHERE id = p_section_id;
    END IF;
    IF v_event_id IS NULL THEN
      SELECT e.id INTO v_event_id FROM public.trip_timeline_events e
       WHERE e.source_option_id = p_option_id ORDER BY e.created_at LIMIT 1;
    END IF;
    IF v_action_id IS NULL AND v_followup IS NOT NULL THEN
      SELECT a.id INTO v_action_id FROM public.trip_actions a WHERE a.id::text = v_followup AND a.trip_id = v_trip_id;
    END IF;
    RETURN jsonb_build_object(
      'section_id', p_section_id, 'option_id', p_option_id, 'event_id', v_event_id,
      'action_id', v_action_id, 'tied', false, 'already_decided', true);
  END IF;

  -- ---- Close + stamp (merge, never overwrite) --------------------------------
  v_new_meta := v_meta || jsonb_build_object('decided_option_id', p_option_id);
  IF v_action_id IS NOT NULL THEN
    v_new_meta := v_new_meta || jsonb_build_object('followup_action_id', v_action_id);
  END IF;
  UPDATE public.planning_sections SET status = 'completed', metadata = v_new_meta WHERE id = p_section_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_trip_id, v_uid, 'poll_closed',
    jsonb_build_object('type', 'section', 'id', p_section_id, 'label', v_title),
    jsonb_build_object(
      'decided_option_id', p_option_id,
      'decided_option_title', v_opt_title,
      'tied', v_tied,
      'event_id', v_event_id,
      'event_reused', v_event_reused,
      'action_id', v_action_id,
      'action_reused', v_action_reused));

  RETURN jsonb_build_object(
    'section_id', p_section_id, 'option_id', p_option_id, 'event_id', v_event_id,
    'action_id', v_action_id, 'tied', v_tied, 'already_decided', false);
END;
$$;

COMMENT ON FUNCTION public.decide_question(uuid, uuid, jsonb, jsonb) IS
  'Organizer/admin-only (checked inside): closes a question, stamps the winner, optionally puts it on the plan and creates a "Book: <option>" to-do, in one transaction. Logs one poll_closed activity row.';

REVOKE ALL ON FUNCTION public.decide_question(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_question(uuid, uuid, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.decide_question(uuid, uuid, jsonb, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- auto_decide_question  (scheduled job only: service role, auth.uid() IS NULL)
-- ---------------------------------------------------------------------------
-- Returns one of
--   {decided:true,  section_id, option_id, option_title, trip_id, title, auto:true, answers}
--   {decided:false, tied:true,  tied_option_ids:[...], section_id, trip_id, title}
--   {decided:false, skipped:'<reason>', ...}   reasons: not_found, already_decided,
--      trip_finished, auto_decide_off, own_choice, no_deadline, deadline_not_passed,
--      no_options, date_poll, ranked_null_rank, no_answers, ideas_bucket,
--      already_booked, not_enough_answers (+ answered, needed)
-- It never creates a plan event or to-do (no date/assignee is known); the
-- engine's synthetic org_book to-do covers "book it" for the organizer.

CREATE OR REPLACE FUNCTION public.auto_decide_question(p_section_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trip_id     uuid;
  v_title       text;
  v_status      public.section_status;
  v_meta        jsonb;
  v_deadline    timestamptz;
  v_trip_status text;
  v_cs          jsonb;
  v_top         integer;
  v_leaders     uuid[];
  v_nulls       integer;
  v_winner      uuid;
  v_win_title   text;
  v_answers     integer;
  v_base        jsonb;
  v_quorum      integer;
  v_in_scope    integer;
  v_needed      integer;
BEGIN
  -- Belt and braces on top of the grants: only the service role (the scheduled
  -- job) may run this; a signed-in user or the anon role never can.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'auto_decide_question is for the scheduled job only' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'auto_decide_question is for the scheduled job only' USING ERRCODE = '42501';
  END IF;

  SELECT ps.trip_id, ps.title, ps.status, ps.metadata, ps.vote_deadline, ps.quorum
    INTO v_trip_id, v_title, v_status, v_meta, v_deadline, v_quorum
    FROM public.planning_sections ps
   WHERE ps.id = p_section_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('decided', false, 'skipped', 'not_found', 'section_id', p_section_id);
  END IF;

  v_base := jsonb_build_object('section_id', p_section_id, 'trip_id', v_trip_id, 'title', v_title);

  IF v_status = 'completed' THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'already_decided');
  END IF;

  SELECT t.status::text, t.chase_settings INTO v_trip_status, v_cs FROM public.trips t WHERE t.id = v_trip_id;
  IF v_trip_status = 'trip_completed' THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'trip_finished');
  END IF;

  IF jsonb_typeof(v_cs) = 'object'
     AND COALESCE(lower(v_cs ->> 'auto_decide') IN ('false', 'off', 'no', '0'), false) THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'auto_decide_off');
  END IF;

  IF jsonb_typeof(v_meta) = 'object' AND (v_meta ->> 'decision_shape') = 'personal' THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'own_choice');
  END IF;

  -- The Ideas list is a place to collect suggestions, never a decision.
  IF jsonb_typeof(v_meta) = 'object' AND (v_meta ->> 'ideas_bucket') = 'true' THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'ideas_bucket');
  END IF;

  -- An option already marked booked IS the outcome; never stamp another winner.
  IF EXISTS (SELECT 1 FROM public.options o WHERE o.section_id = p_section_id AND o.status = 'booked') THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'already_booked');
  END IF;

  IF v_deadline IS NULL THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'no_deadline');
  END IF;
  IF v_deadline > now() THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'deadline_not_passed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.options o WHERE o.section_id = p_section_id AND o.status <> 'cancelled') THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'no_options');
  END IF;

  -- The "Trip dates" poll feeds the date-setting flow; an organizer decides it.
  IF lower(btrim(v_title)) = 'trip dates' OR EXISTS (
    SELECT 1 FROM public.options o
     WHERE o.section_id = p_section_id AND o.status <> 'cancelled'
       AND jsonb_typeof(o.metadata -> 'date_range') = 'object'
  ) THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'date_poll');
  END IF;

  -- Only answers from people still in scope (active, not declined/cancelled) count.
  SELECT max(t.score), max(t.null_rank_votes) INTO v_top, v_nulls FROM public.question_vote_tally(p_section_id, true) t;

  IF COALESCE(v_nulls, 0) > 0 THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'ranked_null_rank');
  END IF;
  IF COALESCE(v_top, 0) <= 0 THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'no_answers');
  END IF;

  SELECT count(DISTINCT v.user_id) INTO v_answers
    FROM public.option_votes v JOIN public.options o ON o.id = v.option_id
   WHERE o.section_id = p_section_id AND o.status <> 'cancelled'
     AND EXISTS (SELECT 1 FROM public.trip_participants tp
                  WHERE tp.trip_id = v_trip_id AND tp.user_id = v.user_id AND tp.active
                    AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled'));
  SELECT count(*) INTO v_in_scope FROM public.trip_participants tp
   WHERE tp.trip_id = v_trip_id AND tp.active
     AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled');

  -- Enough people must have answered: the question's own quorum when it has
  -- one, otherwise at least half of the people in scope (rounded up).
  v_needed := CASE WHEN COALESCE(v_quorum, 0) > 0 THEN v_quorum ELSE GREATEST(1, ceil(v_in_scope / 2.0)::integer) END;
  IF v_answers < v_needed THEN
    RETURN v_base || jsonb_build_object('decided', false, 'skipped', 'not_enough_answers',
                                        'answered', v_answers, 'needed', v_needed);
  END IF;

  SELECT array_agg(t.opt_id ORDER BY t.opt_id) INTO v_leaders
    FROM public.question_vote_tally(p_section_id, true) t WHERE t.score = v_top;

  IF array_length(v_leaders, 1) > 1 THEN
    RETURN v_base || jsonb_build_object('decided', false, 'tied', true, 'tied_option_ids', to_jsonb(v_leaders));
  END IF;

  v_winner := v_leaders[1];
  SELECT o.title INTO v_win_title FROM public.options o WHERE o.id = v_winner;

  UPDATE public.planning_sections
     SET status = 'completed',
         metadata = (CASE WHEN jsonb_typeof(v_meta) = 'object' THEN v_meta ELSE '{}'::jsonb END)
                    || jsonb_build_object('decided_option_id', v_winner)
   WHERE id = p_section_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_trip_id, NULL, 'poll_closed',
    jsonb_build_object('type', 'section', 'id', p_section_id, 'label', v_title),
    jsonb_build_object(
      'auto', true,
      'reason', 'deadline_passed',
      'deadline', v_deadline,
      'decided_option_id', v_winner,
      'decided_option_title', v_win_title,
      'answers', v_answers,
      'needed', v_needed,
      'in_scope', v_in_scope));

  RETURN v_base || jsonb_build_object(
    'decided', true, 'auto', true, 'option_id', v_winner, 'option_title', v_win_title, 'answers', v_answers);
END;
$$;

COMMENT ON FUNCTION public.auto_decide_question(uuid) IS
  'Service role only (scheduled job). Decides an open Group-choice question whose deadline has passed when there is exactly one top option; never decides ties or unanswered questions; honours trips.chase_settings.auto_decide = false. Logs poll_closed with auto=true and a NULL actor. Reversible with Reopen.';

REVOKE ALL ON FUNCTION public.auto_decide_question(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_decide_question(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- mark_booked / unmark_booked
-- ---------------------------------------------------------------------------
-- p_booking (all keys optional; only keys PRESENT are written on update):
--   {title, vendor, confirmation_ref, amount, currency, booking_date,
--    cancellation_deadline, refundable, status ('reserved'|'paid'),
--    document_url, notes, place_id, timeline_event_id, expense_id}
-- Without p_booking only the legacy options.status = 'booked' flag is set.
-- With p_booking: updates the newest non-cancelled bookings row linked by
-- option_id, else inserts one (booked_by = caller; title defaults to the option
-- title; currency to the option's, else the trip base currency; timeline_event_id
-- defaults to the plan event made from this option).
-- Also completes the "Book:" to-do (the section's followup_action_id, only when
-- the section's decided option is this one).
-- Returns {option_id, section_id, booking_id, booking_created, action_id}.

CREATE OR REPLACE FUNCTION public.mark_booked(
  p_option_id uuid,
  p_booking   jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_section_id   uuid;
  v_trip_id      uuid;
  v_meta         jsonb;
  v_opt_title    text;
  v_opt_status   public.option_status;
  v_opt_cur      text;
  v_opt_place    uuid;
  v_base_cur     text;
  v_booking_id   uuid;
  v_created      boolean := false;
  v_action_id    uuid;
  v_followup     text;
  v_status       text;
  v_amount       numeric;
  v_booking_date date;
  v_cancel_dl    timestamptz;
  v_refundable   boolean;
  v_event_id     uuid;
  v_expense_id   uuid;
  v_place_id     uuid;
  v_title        text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT o.section_id, ps.trip_id, ps.metadata, o.title, o.status, o.currency, o.place_id
    INTO v_section_id, v_trip_id, v_meta, v_opt_title, v_opt_status, v_opt_cur, v_opt_place
    FROM public.options o JOIN public.planning_sections ps ON ps.id = o.section_id
   WHERE o.id = p_option_id
   FOR UPDATE OF o;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Option not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.assert_can_manage_trip(v_trip_id, v_uid);

  IF v_opt_status = 'cancelled' THEN
    RAISE EXCEPTION 'That option was cancelled, so it cannot be marked booked'
      USING ERRCODE = 'P0001', HINT = 'invalid_option';
  END IF;

  UPDATE public.options SET status = 'booked' WHERE id = p_option_id AND status <> 'booked';

  IF p_booking IS NOT NULL AND jsonb_typeof(p_booking) = 'object' THEN
    SELECT t.base_currency INTO v_base_cur FROM public.trips t WHERE t.id = v_trip_id;

    BEGIN
      v_status := NULLIF(btrim(COALESCE(p_booking ->> 'status', '')), '');
      v_amount := NULLIF(btrim(COALESCE(p_booking ->> 'amount', '')), '')::numeric;
      v_booking_date := NULLIF(btrim(COALESCE(p_booking ->> 'booking_date', '')), '')::date;
      v_cancel_dl := NULLIF(btrim(COALESCE(p_booking ->> 'cancellation_deadline', '')), '')::timestamptz;
      v_refundable := (p_booking ->> 'refundable')::boolean;
      v_event_id := NULLIF(btrim(COALESCE(p_booking ->> 'timeline_event_id', '')), '')::uuid;
      v_expense_id := NULLIF(btrim(COALESCE(p_booking ->> 'expense_id', '')), '')::uuid;
      v_place_id := NULLIF(btrim(COALESCE(p_booking ->> 'place_id', '')), '')::uuid;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Some of the booking details are not valid' USING ERRCODE = 'P0001', HINT = 'invalid_booking';
    END;

    IF v_status IS NOT NULL AND v_status NOT IN ('reserved', 'paid') THEN
      RAISE EXCEPTION 'A booking is reserved or paid; use unmark_booked to cancel it'
        USING ERRCODE = 'P0001', HINT = 'invalid_booking';
    END IF;
    IF v_amount IS NOT NULL AND v_amount < 0 THEN
      RAISE EXCEPTION 'The amount cannot be negative' USING ERRCODE = 'P0001', HINT = 'invalid_booking';
    END IF;
    IF v_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.trip_timeline_events e WHERE e.id = v_event_id AND e.trip_id = v_trip_id) THEN
      RAISE EXCEPTION 'That plan item is not on this trip' USING ERRCODE = 'P0001', HINT = 'invalid_booking';
    END IF;
    IF v_expense_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expenses x WHERE x.id = v_expense_id AND x.trip_id = v_trip_id) THEN
      RAISE EXCEPTION 'That expense is not on this trip' USING ERRCODE = 'P0001', HINT = 'invalid_booking';
    END IF;

    SELECT b.id INTO v_booking_id FROM public.bookings b
     WHERE b.option_id = p_option_id AND b.trip_id = v_trip_id AND b.status <> 'cancelled'
     ORDER BY b.created_at DESC LIMIT 1;

    IF FOUND THEN
      UPDATE public.bookings b SET
        title = CASE WHEN p_booking ? 'title' THEN COALESCE(left(NULLIF(btrim(p_booking ->> 'title'), ''), 200), b.title) ELSE b.title END,
        vendor = CASE WHEN p_booking ? 'vendor' THEN NULLIF(btrim(p_booking ->> 'vendor'), '') ELSE b.vendor END,
        confirmation_ref = CASE WHEN p_booking ? 'confirmation_ref' THEN NULLIF(btrim(p_booking ->> 'confirmation_ref'), '') ELSE b.confirmation_ref END,
        amount = CASE WHEN p_booking ? 'amount' THEN v_amount ELSE b.amount END,
        currency = CASE WHEN p_booking ? 'currency' THEN COALESCE(NULLIF(btrim(p_booking ->> 'currency'), ''), b.currency) ELSE b.currency END,
        booking_date = CASE WHEN p_booking ? 'booking_date' THEN v_booking_date ELSE b.booking_date END,
        cancellation_deadline = CASE WHEN p_booking ? 'cancellation_deadline' THEN v_cancel_dl ELSE b.cancellation_deadline END,
        refundable = CASE WHEN p_booking ? 'refundable' THEN COALESCE(v_refundable, b.refundable) ELSE b.refundable END,
        status = COALESCE(v_status, b.status),
        document_url = CASE WHEN p_booking ? 'document_url' THEN NULLIF(btrim(p_booking ->> 'document_url'), '') ELSE b.document_url END,
        notes = CASE WHEN p_booking ? 'notes' THEN NULLIF(btrim(p_booking ->> 'notes'), '') ELSE b.notes END,
        place_id = CASE WHEN p_booking ? 'place_id' THEN v_place_id ELSE b.place_id END,
        timeline_event_id = CASE WHEN p_booking ? 'timeline_event_id' THEN v_event_id ELSE b.timeline_event_id END,
        expense_id = CASE WHEN p_booking ? 'expense_id' THEN v_expense_id ELSE b.expense_id END,
        updated_at = now()
      WHERE b.id = v_booking_id;
    ELSE
      v_title := left(COALESCE(NULLIF(btrim(COALESCE(p_booking ->> 'title', '')), ''), v_opt_title), 200);
      IF v_event_id IS NULL AND NOT (p_booking ? 'timeline_event_id') THEN
        SELECT e.id INTO v_event_id FROM public.trip_timeline_events e
         WHERE e.source_option_id = p_option_id ORDER BY e.created_at LIMIT 1;
      END IF;
      INSERT INTO public.bookings
        (trip_id, option_id, title, vendor, confirmation_ref, booked_by, amount, currency, booking_date,
         cancellation_deadline, refundable, status, document_url, expense_id, timeline_event_id, place_id, notes)
      VALUES
        (v_trip_id, p_option_id, v_title,
         NULLIF(btrim(COALESCE(p_booking ->> 'vendor', '')), ''),
         NULLIF(btrim(COALESCE(p_booking ->> 'confirmation_ref', '')), ''),
         v_uid, v_amount,
         COALESCE(NULLIF(btrim(COALESCE(p_booking ->> 'currency', '')), ''), v_opt_cur, v_base_cur),
         v_booking_date, v_cancel_dl, COALESCE(v_refundable, false),
         COALESCE(v_status, 'reserved'),
         NULLIF(btrim(COALESCE(p_booking ->> 'document_url', '')), ''),
         v_expense_id, v_event_id,
         COALESCE(v_place_id, v_opt_place),
         NULLIF(btrim(COALESCE(p_booking ->> 'notes', '')), ''))
      RETURNING id INTO v_booking_id;
      v_created := true;
    END IF;
  END IF;

  -- Complete the "Book:" to-do made by decide_question (only for the decided option).
  IF jsonb_typeof(v_meta) = 'object' THEN
    v_followup := NULLIF(v_meta ->> 'followup_action_id', '');
    IF v_followup IS NOT NULL AND (v_meta ->> 'decided_option_id') = p_option_id::text THEN
      UPDATE public.trip_actions a
         SET completed_at = now(), completed_by = v_uid
       WHERE a.id::text = v_followup AND a.trip_id = v_trip_id AND a.completed_at IS NULL
      RETURNING a.id INTO v_action_id;

      -- A to-do for Everyone (no assignee) is done per person: record the caller's tick.
      IF v_action_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.trip_actions a WHERE a.id = v_action_id AND a.assigned_to IS NULL) THEN
        INSERT INTO public.trip_action_completions (action_id, user_id, trip_id)
        VALUES (v_action_id, v_uid, v_trip_id)
        ON CONFLICT (action_id, user_id) DO NOTHING;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_trip_id, v_uid,
    CASE WHEN v_booking_id IS NOT NULL AND NOT v_created THEN 'booking_updated' ELSE 'booking_added' END,
    jsonb_build_object('type', 'option', 'id', p_option_id, 'label', v_opt_title),
    jsonb_build_object('booking_id', v_booking_id, 'booking_created', v_created, 'todo_completed', v_action_id));

  RETURN jsonb_build_object(
    'option_id', p_option_id, 'section_id', v_section_id, 'booking_id', v_booking_id,
    'booking_created', v_created, 'action_id', v_action_id);
END;
$$;

COMMENT ON FUNCTION public.mark_booked(uuid, jsonb) IS
  'Organizer/admin-only (checked inside): sets options.status = booked, optionally creates/updates the bookings row linked by option_id, and completes the Book: to-do.';

REVOKE ALL ON FUNCTION public.mark_booked(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_booked(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_booked(uuid, jsonb) TO authenticated;

-- "Booking cancelled - needs rebooking": clears the legacy booked flag (the to-dos
-- engine treats options.status = 'booked' as booked even when the booking row is
-- cancelled), cancels every live booking linked to the option, re-opens the
-- "Book:" to-do (so the work shows as needed again; when the question is reopened
-- the to-do is deleted instead), and optionally reopens the
-- question (same effect as ReopenDecisionDialog: in_progress, decided_option_id
-- and followup_action_id cleared, answers kept).
-- With reopen the Book: to-do is DELETED (action_removed:true); without it the to-do
-- is re-opened and stays linked.
-- Returns {option_id, section_id, bookings_cancelled, reopened, action_id, action_removed}.

CREATE OR REPLACE FUNCTION public.unmark_booked(
  p_option_id        uuid,
  p_cancel_booking   boolean DEFAULT true,
  p_reopen_question  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_section_id  uuid;
  v_trip_id     uuid;
  v_title       text;
  v_status      public.section_status;
  v_meta        jsonb;
  v_opt_title   text;
  v_cancelled   integer := 0;
  v_reopened    boolean := false;
  v_followup    text;
  v_action_id   uuid;
  v_action_removed boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT o.section_id, ps.trip_id, ps.title, ps.status, ps.metadata, o.title
    INTO v_section_id, v_trip_id, v_title, v_status, v_meta, v_opt_title
    FROM public.options o JOIN public.planning_sections ps ON ps.id = o.section_id
   WHERE o.id = p_option_id
   FOR UPDATE OF o;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Option not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.assert_can_manage_trip(v_trip_id, v_uid);

  UPDATE public.options SET status = 'available' WHERE id = p_option_id AND status = 'booked';

  IF p_cancel_booking THEN
    UPDATE public.bookings SET status = 'cancelled', updated_at = now()
     WHERE option_id = p_option_id AND trip_id = v_trip_id AND status <> 'cancelled';
    GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  END IF;

  IF jsonb_typeof(v_meta) = 'object' THEN
    v_followup := NULLIF(v_meta ->> 'followup_action_id', '');
    IF v_followup IS NOT NULL AND (v_meta ->> 'decided_option_id') = p_option_id::text THEN
      IF p_reopen_question AND v_status = 'completed' THEN
        -- The question is open again, so the "Book:" to-do for the old winner no
        -- longer means anything: delete it (completions and reminders cascade)
        -- rather than leave an orphan that nothing links to.
        DELETE FROM public.trip_actions a
         WHERE a.id::text = v_followup AND a.trip_id = v_trip_id AND a.section_id IS NULL
        RETURNING a.id INTO v_action_id;
        v_action_removed := v_action_id IS NOT NULL;
        v_action_id := NULL;
      ELSE
        -- Only un-booking: the work is needed again. Re-open the to-do and keep it linked.
        UPDATE public.trip_actions a SET completed_at = NULL, completed_by = NULL
         WHERE a.id::text = v_followup AND a.trip_id = v_trip_id AND a.completed_at IS NOT NULL
        RETURNING a.id INTO v_action_id;
        IF v_action_id IS NOT NULL THEN
          DELETE FROM public.trip_action_completions WHERE action_id = v_action_id;
        END IF;
      END IF;
    END IF;
  END IF;

  IF p_reopen_question AND v_status = 'completed' THEN
    UPDATE public.planning_sections
       SET status = 'in_progress',
           metadata = (CASE WHEN jsonb_typeof(v_meta) = 'object' THEN v_meta ELSE '{}'::jsonb END)
                      - 'decided_option_id' - 'followup_action_id'
     WHERE id = v_section_id;
    v_reopened := true;
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_trip_id, v_uid, 'decision_reopened',
            jsonb_build_object('type', 'section', 'id', v_section_id, 'label', v_title),
            jsonb_build_object('previous_option', v_opt_title, 'because', 'booking_cancelled'));
  END IF;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (v_trip_id, v_uid, 'booking_updated',
          jsonb_build_object('type', 'option', 'id', p_option_id, 'label', v_opt_title),
          jsonb_build_object('cancelled', true, 'bookings_cancelled', v_cancelled, 'reopened', v_reopened, 'action_removed', v_action_removed));

  RETURN jsonb_build_object(
    'option_id', p_option_id, 'section_id', v_section_id,
    'bookings_cancelled', v_cancelled, 'reopened', v_reopened, 'action_id', v_action_id,
    'action_removed', v_action_removed);
END;
$$;

COMMENT ON FUNCTION public.unmark_booked(uuid, boolean, boolean) IS
  'Organizer/admin-only (checked inside): clears the booked flag, cancels live bookings for the option, re-opens its Book: to-do and optionally reopens the question.';

REVOKE ALL ON FUNCTION public.unmark_booked(uuid, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unmark_booked(uuid, boolean, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.unmark_booked(uuid, boolean, boolean) TO authenticated;
