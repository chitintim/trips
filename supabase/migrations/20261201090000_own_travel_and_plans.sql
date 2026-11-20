SET LOCAL lock_timeout = '5s';

-- Own travel and own plans: two RPCs so ANY person who is coming on a trip can save their own travel and add "just me" plans. Table policies are NOT touched.
--
-- WHY: public.trip_timeline_events allows INSERT / UPDATE / DELETE only to trip organisers (organizers_insert_timeline / _update_ / _delete_), so a plain member who saved travel got the raw RLS error.
-- A broad member write policy would let a member set ANY column of ANY row (group events, bookings, other people's travel). These functions write only rows that are provably the caller's own.
--
--   public.set_my_travel(p_trip_id uuid, p_legs jsonb, p_known_ids uuid[]) RETURNS jsonb       -> { legs: [ { id, direction, leg } ] }   REPLACES the caller's whole set of travel rows on the trip
--   public.save_my_plan_item(p_trip_id uuid, p_id uuid, p_item jsonb) RETURNS jsonb   -> { id }   (id is null after a delete)   insert (p_id null) / update / delete (p_item null) of ONE "just me" plan row
--   public._own_travel_date(text), _own_clean(text), _own_ctrl(text, boolean), _own_is_travel(jsonb)    internal helpers (date parser, text trimming / control-character test, strict "is a travel row"); nobody can call them
--
-- WHO MAY CALL (both): auth.uid() is not null AND the caller has a trip_participants row on THAT trip with active (null counts as active) and a confirmation_status that is not 'declined' / 'cancelled'.
--   This is the same "isOut" rule as supabase/functions/trip-chat/context.ts (computeViewer) and suggest_option. Pending, interested, conditional and waitlisted people may add travel and plans.
--   Site admins / trip creators who are not on the roster do NOT qualify. No stage or frozen rule (travel can be corrected at any time).
--
-- WHAT THEY MAY TOUCH (everything is keyed to auth.uid(); no function takes a user id):
--   set_my_travel   : only rows with trip_id = p_trip_id AND metadata->>'travel_details' = 'true' AND participant_ids = ARRAY[caller]  ("own travel rows"; this includes rows an organiser made for the caller).
--                     A supplied id that is not one of those -> bad_id; it is never used to update by id alone. Rows are written with participant_ids = [caller], created_by = caller on insert.
--   save_my_plan_item: only rows with trip_id = p_trip_id AND created_by = caller AND participant_ids = ARRAY[caller] AND source_option_id IS NULL AND coalesce(metadata->>'travel_details','') <> 'true'
--                     (never an organiser's group event, a travel row, or an item that came from a decision); anything else -> not_yours.
--   Metadata is built on the server from validated fields only; the caller's JSON is never stored as it came. Unknown keys in a leg / item are REJECTED (bad_legs / bad_item), never ignored.
--
-- ERRORS: ERRCODE 42501 (not allowed) / 22023 (bad input), always with a HINT; the message is written to be shown to a person as it is. A date must be within 366 days of the trip start
--   (a typo guard for the year, not a rule about the trip dates: travel before / after the trip is fine). No activity_feed row. VOLATILE, SECURITY DEFINER, pinned search_path,
--   REVOKEd from PUBLIC / anon, GRANTed to authenticated.
--
-- RE-RUNNABLE: CREATE OR REPLACE only. Safe to paste inside begin; ... commit;.

-- ---------------------------------------------------------------------------------------------------------------------
-- Pre-flight: fail LOUDLY if the live state is not what this migration was written for
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_conf_type text;
  v_conf_kind text;
BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.trip_participants') IS NULL
     OR to_regclass('public.trip_timeline_events') IS NULL OR to_regclass('public.places') IS NULL THEN
    RAISE EXCEPTION 'own travel migration: trips / users / trip_participants / trip_timeline_events / places are missing; this is not the expected database';
  END IF;
  SELECT string_agg(x.t || '.' || x.c, ', ') INTO v_missing FROM (VALUES
      ('trip_timeline_events', 'id', 'uuid'), ('trip_timeline_events', 'trip_id', 'uuid'), ('trip_timeline_events', 'event_date', 'date'), ('trip_timeline_events', 'start_time', 'time without time zone'),
      ('trip_timeline_events', 'end_time', 'time without time zone'), ('trip_timeline_events', 'all_day', 'boolean'), ('trip_timeline_events', 'title', 'text'), ('trip_timeline_events', 'description', 'text'),
      ('trip_timeline_events', 'location', 'text'), ('trip_timeline_events', 'participant_ids', 'ARRAY'), ('trip_timeline_events', 'metadata', 'jsonb'), ('trip_timeline_events', 'created_by', 'uuid'),
      ('trip_timeline_events', 'source_option_id', 'uuid'), ('trip_timeline_events', 'place_id', 'uuid'), ('trip_timeline_events', 'sort_order', 'integer'), ('trip_timeline_events', 'updated_at', 'timestamp with time zone'),
      ('trip_timeline_events', 'category', 'USER-DEFINED'),
      ('trips', 'id', 'uuid'), ('trips', 'start_date', 'date'), ('trips', 'end_date', 'date'),
      ('users', 'id', 'uuid'), ('users', 'first_name', 'text'), ('users', 'full_name', 'text'),
      ('places', 'id', 'uuid'), ('places', 'trip_id', 'uuid'),
      ('trip_participants', 'trip_id', 'uuid'), ('trip_participants', 'user_id', 'uuid'), ('trip_participants', 'active', 'boolean'), ('trip_participants', 'confirmation_status', NULL)) AS x(t, c, ty)
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = x.t AND k.column_name = x.c AND (x.ty IS NULL OR k.data_type = x.ty));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'own travel migration: expected columns are missing or have another type (event_date / start_date / end_date must be date, start_time / end_time time, participant_ids an array, metadata jsonb): %', v_missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_timeline_events' AND column_name = 'participant_ids' AND udt_name = '_uuid') THEN
    RAISE EXCEPTION 'own travel migration: trip_timeline_events.participant_ids must be uuid[]';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_timeline_events' AND column_name = 'category' AND udt_name = 'timeline_event_category') THEN
    RAISE EXCEPTION 'own travel migration: trip_timeline_events.category must be of type timeline_event_category';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.trip_timeline_events'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'own travel migration: row level security is OFF on public.trip_timeline_events; this migration assumes the organiser-only policies are in force';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::public.timeline_event_category)) e WHERE e::text = 'flight')
     OR NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::public.timeline_event_category)) e WHERE e::text = 'transfer')
     OR NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::public.timeline_event_category)) e WHERE e::text = 'transport')
     OR NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::public.timeline_event_category)) e WHERE e::text = 'other') THEN
    RAISE EXCEPTION 'own travel migration: timeline_event_category must contain flight, transfer, transport and other; it has: %', enum_range(NULL::public.timeline_event_category);
  END IF;
  -- the "not coming" labels: when the column is an enum (live), declined and cancelled must be real labels (a typo in the check would silently let everyone in)
  SELECT k.udt_name, k.data_type INTO v_conf_type, v_conf_kind FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = 'trip_participants' AND k.column_name = 'confirmation_status';
  IF v_conf_kind = 'USER-DEFINED' AND (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = v_conf_type AND e.enumlabel IN ('declined', 'cancelled')) <> 2 THEN
    RAISE EXCEPTION 'own travel migration: trip_participants.confirmation_status (type %) does not contain the labels declined and cancelled', v_conf_type;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.trip_timeline_events'::regclass AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'own travel migration: a trigger has appeared on public.trip_timeline_events since the design was checked; review what it does before applying';
  END IF;
  IF to_regprocedure('public.is_trip_organizer(uuid,uuid)') IS NULL OR to_regprocedure('public.is_trip_participant(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'own travel migration: public.is_trip_organizer(uuid, uuid) / public.is_trip_participant(uuid, uuid) are missing';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'own travel migration: auth.uid() is missing';
  END IF;
  -- none of the names may already exist with another signature (CREATE OR REPLACE would then add a second overload next to it)
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_my_travel' AND p.oid <> coalesce(to_regprocedure('public.set_my_travel(uuid,jsonb,uuid[])')::oid, 0::oid) AND p.oid <> coalesce(to_regprocedure('public.set_my_travel(uuid,jsonb)')::oid, 0::oid))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_my_plan_item' AND p.oid <> coalesce(to_regprocedure('public.save_my_plan_item(uuid,uuid,jsonb)')::oid, 0::oid))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_own_travel_date' AND p.oid <> coalesce(to_regprocedure('public._own_travel_date(text)')::oid, 0::oid))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_own_clean' AND p.oid <> coalesce(to_regprocedure('public._own_clean(text)')::oid, 0::oid))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_own_ctrl' AND p.oid <> coalesce(to_regprocedure('public._own_ctrl(text,boolean)')::oid, 0::oid))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_own_is_travel' AND p.oid <> coalesce(to_regprocedure('public._own_is_travel(jsonb)')::oid, 0::oid)) THEN
    RAISE EXCEPTION 'own travel migration: set_my_travel / save_my_plan_item / _own_travel_date already exist with a different signature; inspect them before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal: strict yyyy-mm-dd -> date (NULL for anything else, including 2026-02-30)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._own_travel_date(p_text text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN p_text::date;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public._own_travel_date(text) FROM PUBLIC, anon, authenticated;

-- internal: text hygiene. _own_clean trims spaces, tabs, CR/LF and NBSP; _own_ctrl says whether control characters remain (newline, return and tab are allowed only in multi-line notes).
CREATE OR REPLACE FUNCTION public._own_clean(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT regexp_replace(COALESCE(p_text, ''), '^[[:space:]' || chr(160) || ']+|[[:space:]' || chr(160) || ']+$', '', 'g')
$$;
CREATE OR REPLACE FUNCTION public._own_ctrl(p_text text, p_multiline boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_multiline THEN regexp_replace(COALESCE(p_text, ''), '[' || chr(10) || chr(13) || chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' ELSE COALESCE(p_text, '') ~ '[[:cntrl:]]' END
$$;
-- internal: a travel row is exactly metadata.travel_details = JSON true (the same test as the client: travel_details === true); the string "true" is not travel
CREATE OR REPLACE FUNCTION public._own_is_travel(p_meta jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_typeof(p_meta -> 'travel_details') = 'boolean' AND (p_meta -> 'travel_details')::boolean, false)
$$;
REVOKE ALL ON FUNCTION public._own_clean(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._own_ctrl(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._own_is_travel(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- set_my_travel
-- ---------------------------------------------------------------------------------------------------------------------
-- the first draft had two arguments and was never applied live; remove it so exactly one signature exists
DROP FUNCTION IF EXISTS public.set_my_travel(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.set_my_travel(p_trip_id uuid, p_legs jsonb, p_known_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_anchor  date;
  v_first   text;
  v_allowed constant text[] := ARRAY['id', 'direction', 'leg', 'title', 'date', 'time', 'flight_ref', 'airport_code', 'set_off_date', 'set_off_time', 'home_date', 'home_time'];
  v_n       integer;
  v_i       integer;
  v_item    jsonb;
  v_key     text;
  v_norm    jsonb := '[]'::jsonb;
  v_ids     uuid[] := '{}';
  v_own     uuid[];
  v_cnt     integer[] := ARRAY[0, 0, 0, 0];   -- arrival main, arrival extra, departure main, departure extra
  v_idtxt   text;
  v_id      uuid;
  v_dir     text;
  v_leg     text;
  v_title   text;
  v_date    date;
  v_time    text;
  v_flight  text;
  v_air     text;
  v_so_d    text;
  v_so_t    text;
  v_h_d     text;
  v_h_t     text;
  v_d2      date;
  v_meta    jsonb;
  v_cat     public.timeline_event_category;
  v_ttl     text;
  v_row     jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_newid   uuid;
  v_cnt_upd integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'not_authenticated';
  END IF;

  -- Caller: coming on THIS trip (same rule as isOut in trip-chat/context.ts and suggest_option).
  IF p_trip_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.trip_participants tp
     WHERE tp.trip_id = p_trip_id AND tp.user_id = v_uid AND tp.active IS DISTINCT FROM false
       AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Only people who are coming on this trip can add travel.' USING ERRCODE = '42501', HINT = 'not_participant';
  END IF;

  SELECT COALESCE(t.start_date, t.end_date, (now() AT TIME ZONE 'UTC')::date) INTO v_anchor FROM public.trips t WHERE t.id = p_trip_id;
  IF v_anchor IS NULL THEN v_anchor := (now() AT TIME ZONE 'UTC')::date; END IF;

  -- Shape: nothing is read or written for bad input.
  IF p_legs IS NULL OR jsonb_typeof(p_legs) <> 'array' OR jsonb_array_length(p_legs) > 8 THEN
    RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
  END IF;
  v_n := jsonb_array_length(p_legs);

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_item := p_legs -> v_i;
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
    END IF;
    -- unknown keys and non-text values are rejected (never silently dropped); every field is a string or null
    FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF v_key <> ALL (v_allowed) OR jsonb_typeof(v_item -> v_key) NOT IN ('string', 'null') THEN
        RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
      END IF;
    END LOOP;

    v_dir := NULLIF(public._own_clean(v_item ->> 'direction'), '');
    v_leg := COALESCE(NULLIF(public._own_clean(v_item ->> 'leg'), ''), 'main');
    IF v_dir IS NULL OR v_dir NOT IN ('arrival', 'departure') OR v_leg NOT IN ('main', 'extra') THEN
      RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
    END IF;

    v_idtxt := NULLIF(public._own_clean(v_item ->> 'id'), '');
    v_id := NULL;
    IF v_idtxt IS NOT NULL THEN
      IF v_idtxt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'That travel entry isn''t yours to change. Close this and try again.' USING ERRCODE = '22023', HINT = 'bad_id';
      END IF;
      v_id := v_idtxt::uuid;
      IF v_id = ANY (v_ids) THEN
        RAISE EXCEPTION 'That travel entry isn''t yours to change. Close this and try again.' USING ERRCODE = '22023', HINT = 'bad_id';
      END IF;
      v_ids := v_ids || v_id;
    END IF;

    v_title := NULLIF(public._own_clean(v_item ->> 'title'), '');
    IF v_leg = 'main' AND v_title IS NOT NULL THEN
      RAISE EXCEPTION 'Arrivals and departures don''t take a name.' USING ERRCODE = '22023', HINT = 'bad_title';
    END IF;
    IF public._own_ctrl(v_title, false) THEN
      RAISE EXCEPTION 'Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.' USING ERRCODE = '22023', HINT = 'bad_title';
    END IF;
    IF v_leg = 'extra' AND (v_title IS NULL OR char_length(v_title) > 60) THEN
      RAISE EXCEPTION 'Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.' USING ERRCODE = '22023', HINT = 'bad_title';
    END IF;

    v_date := public._own_travel_date(public._own_clean(v_item ->> 'date'));
    IF v_date IS NULL OR abs(v_date - v_anchor) > 366 THEN
      RAISE EXCEPTION 'That date looks wrong. Check the year.' USING ERRCODE = '22023', HINT = 'bad_date';
    END IF;

    v_time := NULLIF(public._own_clean(v_item ->> 'time'), '');
    IF v_time IS NOT NULL AND v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'That time doesn''t look right. Use hours and minutes, like 21:30.' USING ERRCODE = '22023', HINT = 'bad_time';
    END IF;

    v_flight := NULLIF(public._own_clean(v_item ->> 'flight_ref'), '');
    IF v_flight IS NOT NULL AND (char_length(v_flight) > 12 OR public._own_ctrl(v_flight, false)) THEN
      RAISE EXCEPTION 'The flight or train number is too long (12 characters at most).' USING ERRCODE = '22023', HINT = 'bad_ref';
    END IF;

    v_air := upper(NULLIF(public._own_clean(v_item ->> 'airport_code'), ''));
    IF v_air IS NOT NULL AND (v_air !~ '^[A-Z]{3}$' OR public._own_ctrl(v_air, false)) THEN
      RAISE EXCEPTION 'The airport code should be three letters, like LHR.' USING ERRCODE = '22023', HINT = 'bad_airport';
    END IF;

    -- the "other end" belongs to the MAIN leg of its own direction only
    v_so_d := NULLIF(public._own_clean(v_item ->> 'set_off_date'), '');
    v_so_t := NULLIF(public._own_clean(v_item ->> 'set_off_time'), '');
    v_h_d := NULLIF(public._own_clean(v_item ->> 'home_date'), '');
    v_h_t := NULLIF(public._own_clean(v_item ->> 'home_time'), '');
    IF (v_so_d IS NOT NULL OR v_so_t IS NOT NULL) AND NOT (v_dir = 'arrival' AND v_leg = 'main') THEN
      RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
    END IF;
    IF (v_h_d IS NOT NULL OR v_h_t IS NOT NULL) AND NOT (v_dir = 'departure' AND v_leg = 'main') THEN
      RAISE EXCEPTION 'Those travel details don''t look right. Check them and try again.' USING ERRCODE = '22023', HINT = 'bad_legs';
    END IF;
    IF v_so_d IS NOT NULL OR v_so_t IS NOT NULL THEN
      v_d2 := public._own_travel_date(v_so_d);
      IF v_d2 IS NULL OR v_date - v_d2 NOT BETWEEN 0 AND 3 THEN
        RAISE EXCEPTION 'Setting off must be on or up to 3 days before arriving.' USING ERRCODE = '22023', HINT = 'bad_set_off';
      END IF;
      IF v_so_t IS NOT NULL AND v_so_t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RAISE EXCEPTION 'That time doesn''t look right. Use hours and minutes, like 21:30.' USING ERRCODE = '22023', HINT = 'bad_time';
      END IF;
    END IF;
    IF v_h_d IS NOT NULL OR v_h_t IS NOT NULL THEN
      v_d2 := public._own_travel_date(v_h_d);
      IF v_d2 IS NULL OR v_d2 - v_date NOT BETWEEN 0 AND 3 THEN
        RAISE EXCEPTION 'Getting home must be on or up to 3 days after leaving.' USING ERRCODE = '22023', HINT = 'bad_home';
      END IF;
      IF v_h_t IS NOT NULL AND v_h_t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RAISE EXCEPTION 'That time doesn''t look right. Use hours and minutes, like 21:30.' USING ERRCODE = '22023', HINT = 'bad_time';
      END IF;
    END IF;

    v_cnt[(CASE WHEN v_dir = 'arrival' THEN 1 ELSE 3 END) + (CASE WHEN v_leg = 'main' THEN 0 ELSE 1 END)] := v_cnt[(CASE WHEN v_dir = 'arrival' THEN 1 ELSE 3 END) + (CASE WHEN v_leg = 'main' THEN 0 ELSE 1 END)] + 1;

    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'direction', v_dir, 'leg', v_leg, 'title', v_title, 'date', v_date, 'time', v_time, 'flight_ref', v_flight, 'airport_code', v_air,
      'set_off_date', v_so_d, 'set_off_time', v_so_t, 'home_date', v_h_d, 'home_time', v_h_t));
  END LOOP;

  IF v_cnt[1] > 1 OR v_cnt[3] > 1 OR v_cnt[2] > 3 OR v_cnt[4] > 3 THEN
    RAISE EXCEPTION 'You can have one arrival, one departure and up to 3 extra journeys each way.' USING ERRCODE = '22023', HINT = 'too_many';
  END IF;

  -- One lock per person and trip: a double tap cannot create duplicates.
  PERFORM pg_advisory_xact_lock(hashtextextended('set_my_travel:' || p_trip_id::text || ':' || v_uid::text, 0));

  SELECT COALESCE(array_agg(e.id), '{}') INTO v_own FROM public.trip_timeline_events e
   WHERE e.trip_id = p_trip_id AND public._own_is_travel(e.metadata) AND e.source_option_id IS NULL AND e.participant_ids = ARRAY[v_uid];
  -- stale guard: every own row that exists now must be one the client had loaded; otherwise a form built from an incomplete set would silently delete it. Ids known but gone are ignored.
  IF EXISTS (SELECT 1 FROM unnest(v_own) x WHERE NOT (x = ANY (COALESCE(p_known_ids, '{}')))) THEN
    RAISE EXCEPTION 'Your travel has changed since you opened this. Close it, open it again and check.' USING ERRCODE = '55000', HINT = 'stale';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE NOT (x = ANY (v_own))) THEN
    RAISE EXCEPTION 'That travel entry isn''t yours to change. Close this and try again.' USING ERRCODE = '22023', HINT = 'bad_id';
  END IF;

  SELECT COALESCE(NULLIF(btrim(u.first_name), ''), NULLIF(split_part(btrim(COALESCE(u.full_name, '')), ' ', 1), '')) INTO v_first FROM public.users u WHERE u.id = v_uid;
  v_first := COALESCE(v_first, 'Someone');

  -- Replace the whole set: delete the caller's own rows that are not listed, update the listed ones, insert the rest.
  DELETE FROM public.trip_timeline_events e
   WHERE e.trip_id = p_trip_id AND public._own_is_travel(e.metadata) AND e.source_option_id IS NULL AND e.participant_ids = ARRAY[v_uid] AND e.id <> ALL (v_ids);

  FOR v_row IN SELECT x FROM jsonb_array_elements(v_norm) AS x LOOP
    v_ttl := CASE WHEN v_row ->> 'leg' = 'extra' THEN v_row ->> 'title'
                  WHEN v_row ->> 'direction' = 'arrival' THEN v_first || ' arrives' ELSE v_first || ' departs' END;
    v_cat := (CASE WHEN v_row ->> 'flight_ref' IS NOT NULL THEN 'flight' WHEN v_row ->> 'leg' = 'main' THEN 'transfer' ELSE 'transport' END)::public.timeline_event_category;
    v_meta := jsonb_strip_nulls(jsonb_build_object(
      'travel_details', true, 'direction', v_row ->> 'direction', 'leg', v_row ->> 'leg', 'flight_ref', v_row -> 'flight_ref', 'airport_code', v_row -> 'airport_code',
      'set_off_date', v_row -> 'set_off_date', 'set_off_time', v_row -> 'set_off_time', 'home_date', v_row -> 'home_date', 'home_time', v_row -> 'home_time'));
    IF v_row ->> 'id' IS NOT NULL THEN
      UPDATE public.trip_timeline_events e
         SET title = v_ttl, category = v_cat, event_date = (v_row ->> 'date')::date, start_time = (v_row ->> 'time')::time, end_time = NULL,
             all_day = (v_row ->> 'time') IS NULL, participant_ids = ARRAY[v_uid], metadata = v_meta, updated_at = now()
       WHERE e.id = (v_row ->> 'id')::uuid AND e.trip_id = p_trip_id AND public._own_is_travel(e.metadata) AND e.source_option_id IS NULL AND e.participant_ids = ARRAY[v_uid]
      RETURNING e.id INTO v_newid;
      GET DIAGNOSTICS v_cnt_upd = ROW_COUNT;
      IF v_cnt_upd <> 1 THEN
        RAISE EXCEPTION 'That travel entry isn''t yours to change. Close this and try again.' USING ERRCODE = '22023', HINT = 'bad_id';
      END IF;
    ELSE
      INSERT INTO public.trip_timeline_events (trip_id, event_date, start_time, end_time, all_day, title, category, participant_ids, metadata, created_by)
      VALUES (p_trip_id, (v_row ->> 'date')::date, (v_row ->> 'time')::time, NULL, (v_row ->> 'time') IS NULL, v_ttl, v_cat, ARRAY[v_uid], v_meta, v_uid)
      RETURNING id INTO v_newid;
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_newid, 'direction', v_row ->> 'direction', 'leg', v_row ->> 'leg'));
  END LOOP;

  RETURN jsonb_build_object('legs', v_out);
END
$$;
REVOKE ALL ON FUNCTION public.set_my_travel(uuid, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_travel(uuid, jsonb, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- save_my_plan_item
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_my_plan_item(p_trip_id uuid, p_id uuid, p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_anchor  date;
  v_allowed constant text[] := ARRAY['title', 'date', 'start_time', 'end_time', 'notes', 'category', 'place_id', 'location'];
  v_key     text;
  v_title   text;
  v_date    date;
  v_start   text;
  v_end     text;
  v_notes   text;
  v_cattxt  text;
  v_cat     public.timeline_event_category;
  v_placetx text;
  v_place   uuid;
  v_loc     text;
  v_found   uuid;
  v_new     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'not_authenticated';
  END IF;

  IF p_trip_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.trip_participants tp
     WHERE tp.trip_id = p_trip_id AND tp.user_id = v_uid AND tp.active IS DISTINCT FROM false
       AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Only people who are coming on this trip can add their own plans.' USING ERRCODE = '42501', HINT = 'not_participant';
  END IF;

  -- same lock as set_my_travel: one writer per person and trip
  PERFORM pg_advisory_xact_lock(hashtextextended('set_my_travel:' || p_trip_id::text || ':' || v_uid::text, 0));

  -- delete: a JSON or SQL null item
  IF p_item IS NULL OR jsonb_typeof(p_item) = 'null' THEN
    IF p_id IS NULL THEN
      RAISE EXCEPTION 'There is nothing to save.' USING ERRCODE = '22023', HINT = 'bad_item';
    END IF;
    DELETE FROM public.trip_timeline_events e
     WHERE e.id = p_id AND e.trip_id = p_trip_id AND e.created_by = v_uid AND e.participant_ids = ARRAY[v_uid] AND e.source_option_id IS NULL
       AND NOT public._own_is_travel(e.metadata);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'You can only change plans that you added for yourself.' USING ERRCODE = '42501', HINT = 'not_yours';
    END IF;
    RETURN jsonb_build_object('id', NULL::uuid);
  END IF;

  SELECT COALESCE(t.start_date, t.end_date, (now() AT TIME ZONE 'UTC')::date) INTO v_anchor FROM public.trips t WHERE t.id = p_trip_id;
  IF v_anchor IS NULL THEN v_anchor := (now() AT TIME ZONE 'UTC')::date; END IF;

  IF jsonb_typeof(p_item) <> 'object' THEN
    RAISE EXCEPTION 'That plan doesn''t look right. Check it and try again.' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_item) LOOP
    IF v_key <> ALL (v_allowed) OR jsonb_typeof(p_item -> v_key) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'That plan doesn''t look right. Check it and try again.' USING ERRCODE = '22023', HINT = 'bad_item';
    END IF;
  END LOOP;

  v_title := public._own_clean(p_item ->> 'title');
  IF char_length(v_title) < 1 OR char_length(v_title) > 120 OR public._own_ctrl(v_title, false) THEN
    RAISE EXCEPTION 'Give it a short title (1 to 120 characters).' USING ERRCODE = '22023', HINT = 'bad_title';
  END IF;

  v_date := public._own_travel_date(public._own_clean(p_item ->> 'date'));
  IF v_date IS NULL OR abs(v_date - v_anchor) > 366 THEN
    RAISE EXCEPTION 'That date looks wrong. Check the year.' USING ERRCODE = '22023', HINT = 'bad_date';
  END IF;

  v_start := NULLIF(public._own_clean(p_item ->> 'start_time'), '');
  v_end := NULLIF(public._own_clean(p_item ->> 'end_time'), '');
  IF (v_start IS NOT NULL AND v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') OR (v_end IS NOT NULL AND v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') THEN
    RAISE EXCEPTION 'That time doesn''t look right. Use hours and minutes, like 21:30.' USING ERRCODE = '22023', HINT = 'bad_time';
  END IF;
  IF v_end IS NOT NULL AND v_start IS NULL THEN
    RAISE EXCEPTION 'Add a start time to go with the end time.' USING ERRCODE = '22023', HINT = 'bad_time';
  END IF;

  v_notes := NULLIF(public._own_clean(p_item ->> 'notes'), '');
  IF v_notes IS NOT NULL AND public._own_ctrl(v_notes, true) THEN
    RAISE EXCEPTION 'The notes have characters we can''t save.' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'The notes are too long (1000 characters at most).' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;
  v_loc := NULLIF(public._own_clean(p_item ->> 'location'), '');
  IF v_loc IS NOT NULL AND public._own_ctrl(v_loc, false) THEN
    RAISE EXCEPTION 'The location has characters we can''t save.' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;
  IF v_loc IS NOT NULL AND char_length(v_loc) > 200 THEN
    RAISE EXCEPTION 'The location is too long (200 characters at most).' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;

  v_cattxt := COALESCE(NULLIF(public._own_clean(p_item ->> 'category'), ''), 'other');
  IF NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::public.timeline_event_category)) e WHERE e::text = v_cattxt) THEN
    RAISE EXCEPTION 'That kind of plan isn''t one we know. Pick another.' USING ERRCODE = '22023', HINT = 'bad_item';
  END IF;
  v_cat := v_cattxt::public.timeline_event_category;

  v_placetx := NULLIF(public._own_clean(p_item ->> 'place_id'), '');
  v_place := NULL;
  IF v_placetx IS NOT NULL THEN
    IF v_placetx !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'That place isn''t on this trip.' USING ERRCODE = '22023', HINT = 'bad_place';
    END IF;
    SELECT pl.id INTO v_place FROM public.places pl WHERE pl.id = v_placetx::uuid AND pl.trip_id = p_trip_id;
    IF v_place IS NULL THEN
      RAISE EXCEPTION 'That place isn''t on this trip.' USING ERRCODE = '22023', HINT = 'bad_place';
    END IF;
  END IF;

  IF p_id IS NOT NULL THEN
    -- update: only the caller's own plan row (lock it so a parallel delete cannot interleave)
    SELECT e.id INTO v_found FROM public.trip_timeline_events e
     WHERE e.id = p_id AND e.trip_id = p_trip_id AND e.created_by = v_uid AND e.participant_ids = ARRAY[v_uid] AND e.source_option_id IS NULL
       AND NOT public._own_is_travel(e.metadata)
     FOR UPDATE;
    IF v_found IS NULL THEN
      RAISE EXCEPTION 'You can only change plans that you added for yourself.' USING ERRCODE = '42501', HINT = 'not_yours';
    END IF;
    UPDATE public.trip_timeline_events e
       SET title = v_title, event_date = v_date, start_time = v_start::time, end_time = v_end::time, all_day = v_start IS NULL, description = v_notes,
           category = v_cat, location = v_loc, place_id = v_place, participant_ids = ARRAY[v_uid], updated_at = now()
     WHERE e.id = v_found;
    RETURN jsonb_build_object('id', v_found);
  END IF;

  IF (SELECT count(*) FROM public.trip_timeline_events e WHERE e.trip_id = p_trip_id AND e.created_by = v_uid AND e.participant_ids = ARRAY[v_uid] AND e.source_option_id IS NULL AND NOT public._own_is_travel(e.metadata)) >= 100 THEN
    RAISE EXCEPTION 'You''ve added a lot of your own plans to this trip. Remove one before adding another.' USING ERRCODE = '22023', HINT = 'too_many';
  END IF;
  INSERT INTO public.trip_timeline_events (trip_id, event_date, start_time, end_time, all_day, title, description, category, location, participant_ids, metadata, created_by, place_id)
  VALUES (p_trip_id, v_date, v_start::time, v_end::time, v_start IS NULL, v_title, v_notes, v_cat, v_loc, ARRAY[v_uid], '{}'::jsonb, v_uid, v_place)
  RETURNING id INTO v_new;
  RETURN jsonb_build_object('id', v_new);
END
$$;
REVOKE ALL ON FUNCTION public.save_my_plan_item(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_my_plan_item(uuid, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.set_my_travel(uuid, jsonb, uuid[]) IS 'The caller (coming on the trip) replaces their OWN travel rows on the trip (p_known_ids = the own row ids the client had loaded; an own row not in it gives stale and nothing is written): p_legs is an array of at most 8 legs {id, direction, leg, title, date, time, flight_ref, airport_code, set_off_*, home_*}; rows not listed are deleted. Returns {legs:[{id,direction,leg}]}. Touches only rows with participant_ids = [caller].';
COMMENT ON FUNCTION public.save_my_plan_item(uuid, uuid, jsonb) IS 'The caller (coming on the trip) inserts (p_id null), updates or deletes (p_item null) ONE "just me" plan row of their own (created_by = caller, participant_ids = [caller], not travel, not from an option). Returns {id}.';

NOTIFY pgrst, 'reload schema';
