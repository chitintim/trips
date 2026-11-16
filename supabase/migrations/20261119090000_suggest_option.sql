-- Phase 5A: "Suggest an option". Participants can add an option to an OPEN
-- question of their trip (and ideas to the Ideas bucket) and withdraw their own
-- suggestion while nobody has answered with it. NOT APPLIED by the agent that
-- wrote it.
--
-- ADDITIVE ONLY: two new functions. No table, column, policy or trigger is
-- created or changed. Re-runnable (CREATE OR REPLACE).
--
--   public.suggest_option(section, title, link, note, idea, trip)  authenticated
--   public.withdraw_suggestion(option)                             authenticated
--
-- WHY AN RPC AND NOT AN INSERT POLICY: a permissive INSERT policy on options
-- would let a participant set ANY column (price, status = 'booked', locked,
-- order_index, place_id, metadata.pricing ...). The RPC inserts one row with
-- safe defaults only; the existing organizer-only policy
-- ("Trip organizers can create/delete/update options") is untouched, so
-- organizers edit, price and delete suggestions through the normal option
-- editor, and participants still cannot write options directly.
--
-- WHO MAY CALL suggest_option: an ACTIVE participant of the question's trip
-- (trip_participants.active) whose confirmation_status is not 'declined' or
-- 'cancelled' (same "in scope" notion as the answers engine). Organizers who are
-- participants qualify too (the app does not offer it to them; they use
-- Manage -> Add option). Site admins / creators who are not on the roster do
-- NOT qualify. SECURITY DEFINER, pinned search_path, REVOKEd from
-- PUBLIC/anon, GRANTed to authenticated.
--
-- RULES (all raise with a plain message; ERRCODE 42501 = not allowed,
-- 22023 = bad input, 55000 = wrong state, 54000 = limit):
--   * question open = planning_sections.status <> 'completed'; trip not
--     finished = trips.status <> 'trip_completed' (the client also treats an
--     ended-by-date trip as finished and hides the entry).
--   * Group-choice questions only: metadata.decision_shape = 'personal'
--     (Own choice order forms with prices/variants) is refused, as are date
--     polls (any option with metadata.date_range, or the question titled
--     "Trip dates"): a bare suggestion cannot carry dates or prices.
--   * title: trimmed, 1-120 chars. link: optional, trimmed, http(s) only, no
--     spaces, <= 2000 chars, stored as metadata.source_url. note: optional,
--     trimmed, <= 500 chars, stored in options.description.
--   * no duplicate: a live (non-cancelled) option with the same title
--     (case-insensitive) in the question is refused.
--   * limits: max 5 suggestions per person per question, max 20 per person per
--     trip, max 60 options per question. Counted from metadata.suggested_by.
--   * the row: price NULL, currency NULL, status = column default ('available'),
--     locked = default (false), price_type = default, order_index = after the
--     existing options, metadata {suggested_by, suggested_at, source_url?}.
--     Nothing about hiding answers until a question is decided is touched.
--   * writes activity_feed verb 'option_suggested' (actor = caller).
--
-- IDEAS BUCKET: with p_section_id NULL, p_idea = true and p_trip_id set, the
-- idea goes into the trip's open Ideas question (metadata.ideas_bucket = true),
-- which is created on first use with EXACTLY the shape
-- useAddToPlanSave/addFlow.buildIdeasSectionInsert writes (Choose any,
-- approval, results visible, Ideas, section_type activities, order_index 0).
-- This is the only way a participant can cause a question to exist, and only
-- this one. The per-trip advisory lock (taken after the participant check) stops two first ideas creating two buckets and makes limits/duplicates race-safe. When
-- p_section_id is given the idea flag is ignored and the normal rules apply
-- (an ideas bucket is a normal Choose-any group question).
--
-- withdraw_suggestion(option): the caller must be the suggester
-- (metadata.suggested_by = caller), still on the trip, the question open and
-- the trip not finished, the option still 'available', and NOBODY has answered
-- with it (no option_votes, no selections). Deletes the option. Comments and
-- reactions on it cascade away with it (FKs are ON DELETE CASCADE).
--
-- ASSUMPTIONS (verify on live with PRE_APPLY_CHECKS group 16):
--   * options columns as in schema.txt: currency has default 'EUR' (we write
--     NULL explicitly, like the Ideas flow), status default 'available',
--     locked default false, metadata default '{}'.
--   * planning_sections.status section_status (not_started|in_progress|completed);
--     trips.status text/enum with the label 'trip_completed'.
--   * the function owner bypasses RLS (as the existing definer RPCs rely on).
--   * activity_feed has no verb CHECK.
--   * no INSERT trigger on options (only set_updated_at BEFORE UPDATE).

CREATE OR REPLACE FUNCTION public.suggest_option(
  p_section_id uuid,
  p_title      text,
  p_link       text    DEFAULT NULL,
  p_note       text    DEFAULT NULL,
  p_idea       boolean DEFAULT false,
  p_trip_id    uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_title     text := btrim(COALESCE(p_title, ''));
  v_link      text := NULLIF(btrim(COALESCE(p_link, '')), '');
  v_note      text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_trip_id   uuid;
  v_trip_status text;
  v_section   public.planning_sections%ROWTYPE;
  v_created   boolean := false;
  v_meta      jsonb;
  v_next      integer;
  v_option_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Input checks first: nothing is read or written for bad input.
  IF char_length(v_title) < 1 OR char_length(v_title) > 120 OR v_title ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'Give it a short title (1 to 120 characters)' USING ERRCODE = '22023', HINT = 'bad_title';
  END IF;
  IF v_link IS NOT NULL AND (char_length(v_link) > 2000 OR v_link !~* '^https?://[^[:space:]]+$') THEN
    RAISE EXCEPTION 'That link doesn''t look right. Use the full address starting with http:// or https://, or leave it empty'
      USING ERRCODE = '22023', HINT = 'bad_link';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is too long (500 characters at most)' USING ERRCODE = '22023', HINT = 'bad_note';
  END IF;

  -- Resolve the trip (and the question).
  IF p_section_id IS NOT NULL THEN
    SELECT * INTO v_section FROM public.planning_sections ps WHERE ps.id = p_section_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That question no longer exists' USING ERRCODE = '22023', HINT = 'no_question';
    END IF;
    v_trip_id := v_section.trip_id;
  ELSE
    IF NOT COALESCE(p_idea, false) OR p_trip_id IS NULL THEN
      RAISE EXCEPTION 'Pick a question to add the option to' USING ERRCODE = '22023', HINT = 'no_question';
    END IF;
    v_trip_id := p_trip_id;
  END IF;

  SELECT t.status::text INTO v_trip_status FROM public.trips t WHERE t.id = v_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trip no longer exists' USING ERRCODE = '22023', HINT = 'no_trip';
  END IF;

  -- Caller must be an active, not-out participant of THIS trip.
  IF NOT EXISTS (
    SELECT 1 FROM public.trip_participants tp
     WHERE tp.trip_id = v_trip_id AND tp.user_id = v_uid AND tp.active
       AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Only people who are coming on this trip can suggest options'
      USING ERRCODE = '42501', HINT = 'not_participant';
  END IF;

  -- One per-trip lock makes the duplicate check, the limits and order_index
  -- race-safe (also covers the Ideas bucket find-or-create).
  PERFORM pg_advisory_xact_lock(hashtextextended('suggest_option:' || v_trip_id::text, 0));

  IF v_trip_status = 'trip_completed' THEN
    RAISE EXCEPTION 'This trip is finished' USING ERRCODE = '55000', HINT = 'trip_finished';
  END IF;

  -- Ideas bucket: find or create (only reachable with no section given).
  IF p_section_id IS NULL THEN
    SELECT * INTO v_section FROM public.planning_sections ps
     WHERE ps.trip_id = v_trip_id AND ps.status <> 'completed'
       AND jsonb_typeof(ps.metadata) = 'object' AND (ps.metadata -> 'ideas_bucket') = 'true'::jsonb
     ORDER BY ps.created_at, ps.id
     LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO public.planning_sections (
        trip_id, title, description, metadata, section_type, status,
        allow_multiple_selections, order_index, voting_method, hide_votes_until_close, vote_deadline, quorum
      ) VALUES (
        v_trip_id, 'Ideas', 'Things people have suggested. Tell us which you like.',
        '{"decision_shape":"vote","ideas_bucket":true}'::jsonb, 'activities', 'in_progress',
        true, 0, 'approval', false, NULL, NULL
      )
      RETURNING * INTO v_section;
      v_created := true;
    END IF;
  END IF;

  -- The question must be open, a group choice, and not a date poll.
  IF v_section.status = 'completed' THEN
    RAISE EXCEPTION 'This question is closed' USING ERRCODE = '55000', HINT = 'question_closed';
  END IF;
  IF jsonb_typeof(v_section.metadata) = 'object' AND (v_section.metadata ->> 'decision_shape') = 'personal' THEN
    RAISE EXCEPTION 'This question is an order form, so only the organizers add to it' USING ERRCODE = '55000', HINT = 'own_choice';
  END IF;
  IF lower(btrim(v_section.title)) = 'trip dates'
     OR EXISTS (SELECT 1 FROM public.options o
                 WHERE o.section_id = v_section.id AND jsonb_typeof(o.metadata) = 'object' AND o.metadata ? 'date_range') THEN
    RAISE EXCEPTION 'Dates are set by the organizers' USING ERRCODE = '55000', HINT = 'date_poll';
  END IF;

  -- Duplicates and limits.
  IF EXISTS (SELECT 1 FROM public.options o
              WHERE o.section_id = v_section.id AND o.status <> 'cancelled' AND lower(btrim(o.title)) = lower(v_title)) THEN
    RAISE EXCEPTION 'That option is already there' USING ERRCODE = '22023', HINT = 'duplicate';
  END IF;
  IF (SELECT count(*) FROM public.options o WHERE o.section_id = v_section.id) >= 60 THEN
    RAISE EXCEPTION 'This question has plenty of options already' USING ERRCODE = '54000', HINT = 'too_many_options';
  END IF;
  IF (SELECT count(*) FROM public.options o
       WHERE o.section_id = v_section.id AND jsonb_typeof(o.metadata) = 'object' AND (o.metadata ->> 'suggested_by') = v_uid::text) >= 5 THEN
    RAISE EXCEPTION 'You have already suggested 5 options here. Withdraw one or ask an organizer' USING ERRCODE = '54000', HINT = 'rate_limit_question';
  END IF;
  IF (SELECT count(*) FROM public.options o JOIN public.planning_sections ps ON ps.id = o.section_id
       WHERE ps.trip_id = v_trip_id AND jsonb_typeof(o.metadata) = 'object' AND (o.metadata ->> 'suggested_by') = v_uid::text) >= 20 THEN
    RAISE EXCEPTION 'You have suggested a lot already. Ask an organizer to add more' USING ERRCODE = '54000', HINT = 'rate_limit_trip';
  END IF;

  SELECT COALESCE(max(o.order_index), -1) + 1 INTO v_next FROM public.options o WHERE o.section_id = v_section.id;

  v_meta := jsonb_build_object('suggested_by', v_uid, 'suggested_at', to_jsonb(now()));
  IF v_link IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('source_url', v_link);
  END IF;

  -- Safe defaults only: no price, default status / locked / price_type.
  INSERT INTO public.options (section_id, title, description, price, currency, order_index, metadata)
  VALUES (v_section.id, v_title, v_note, NULL, NULL, v_next, v_meta)
  RETURNING id INTO v_option_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_trip_id, v_uid, 'option_suggested',
    jsonb_build_object('type', 'section', 'id', v_section.id, 'label', v_title),
    jsonb_build_object('option_id', v_option_id, 'question', v_section.title, 'ideas_bucket', p_section_id IS NULL)
  );

  RETURN jsonb_build_object(
    'option_id', v_option_id,
    'section_id', v_section.id,
    'trip_id', v_trip_id,
    'created_section', v_created
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_suggestion(p_option_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_opt     public.options%ROWTYPE;
  v_section public.planning_sections%ROWTYPE;
  v_trip_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_opt FROM public.options o WHERE o.id = p_option_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That suggestion is already gone' USING ERRCODE = '22023', HINT = 'no_option';
  END IF;

  IF NOT COALESCE(jsonb_typeof(v_opt.metadata) = 'object' AND (v_opt.metadata ->> 'suggested_by') = v_uid::text, false) THEN
    RAISE EXCEPTION 'You can only withdraw your own suggestion' USING ERRCODE = '42501', HINT = 'not_suggester';
  END IF;

  SELECT * INTO v_section FROM public.planning_sections ps WHERE ps.id = v_opt.section_id;
  SELECT t.status::text INTO v_trip_status FROM public.trips t WHERE t.id = v_section.trip_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.trip_participants tp
     WHERE tp.trip_id = v_section.trip_id AND tp.user_id = v_uid AND tp.active
  ) THEN
    RAISE EXCEPTION 'You are not on this trip' USING ERRCODE = '42501', HINT = 'not_participant';
  END IF;
  IF v_section.status = 'completed' OR v_trip_status = 'trip_completed' THEN
    RAISE EXCEPTION 'This question is closed' USING ERRCODE = '55000', HINT = 'question_closed';
  END IF;
  IF v_opt.status <> 'available' OR v_opt.locked THEN
    RAISE EXCEPTION 'An organizer has already acted on this option' USING ERRCODE = '55000', HINT = 'option_in_use';
  END IF;
  IF EXISTS (SELECT 1 FROM public.option_votes v WHERE v.option_id = p_option_id)
     OR EXISTS (SELECT 1 FROM public.selections s WHERE s.option_id = p_option_id) THEN
    RAISE EXCEPTION 'Someone has already answered with this, so it can''t be withdrawn' USING ERRCODE = '55000', HINT = 'has_answers';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bookings b WHERE b.option_id = p_option_id)
     OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.option_id = p_option_id)
     OR EXISTS (SELECT 1 FROM public.trip_timeline_events t WHERE t.source_option_id = p_option_id) THEN
    RAISE EXCEPTION 'An organizer has already acted on this option' USING ERRCODE = '55000', HINT = 'option_in_use';
  END IF;

  DELETE FROM public.options WHERE id = p_option_id;

  RETURN jsonb_build_object('option_id', p_option_id, 'section_id', v_section.id, 'withdrawn', true);
END;
$$;

REVOKE ALL ON FUNCTION public.suggest_option(uuid, text, text, text, boolean, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_suggestion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_option(uuid, text, text, text, boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_suggestion(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
