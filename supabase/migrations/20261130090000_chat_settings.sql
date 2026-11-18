SET LOCAL lock_timeout = '5s';

-- Trip chat, switches: a SITE-LEVEL and a TRIP-LEVEL control over the assistant ("site level toggle that might just as well turn off the ai chat button, and then trip level control as well").
--
-- SITE (one row, site admins only): mode = off (no chat anywhere: the Ask button is hidden and the edge function refuses) | answers (chat answers, no confirm-card actions) | actions (answers + actions);
--   actions_scope (only matters when mode = actions) = upcoming (the trip has not ended more than 30 days ago, or has no dates: the SAME rule as tripIsUpcoming in supabase/functions/trip-chat/flags.ts) | all.
-- TRIP (one optional row per trip): chat = inherit | off;  actions = inherit | off | on ("on" = force on even when the scope would exclude the trip; only a site admin may set it).
-- WHO SETS WHAT: site admin anything; a trip organiser (active) chat inherit/off and actions inherit/off for their own trip (they can switch things off and back to inherit, never force on; an unchanged "on"
--   that an admin set is accepted as unchanged, so a form can resend it). Participants can read their trip's availability, not set it. Works on FROZEN trips too (it is not a money change).
--
-- EFFECTIVE VALUES (one function, _chat_effective, used by every RPC; the edge function computes the same rule from the same two tables):
--   chat    = site.mode <> 'off' AND trip.chat <> 'off'
--   actions = chat AND site.mode = 'actions' AND trip.actions <> 'off' AND (trip.actions = 'on' OR scope = 'all' OR trip is upcoming)
-- The env switch TRIP_CHAT_ACTIONS=off in the edge function stays a CEILING above all of this (see supabase/functions/trip-chat/chatSettings.ts and the README).
--
-- WRITES: both tables have RLS ON, NO policy and NO client privilege: clients read and write only through the SECURITY DEFINER RPCs below. The edge function reads both tables with the service role.
-- SEED (so nothing changes at apply time): site mode = actions, scope = upcoming; the private test trip be551bc4-... gets actions = on (only if that trip exists).
--
-- ADDITIVE AND RE-RUNNABLE: CREATE TABLE IF NOT EXISTS, seeds with ON CONFLICT DO NOTHING (a re-run never overwrites what an admin chose), CREATE OR REPLACE, idempotent REVOKE/GRANT.
-- ALSO REPLACED: begin_chat_action(uuid) (body of 20261129090000 plus one check): a card proposed earlier cannot be confirmed once the effective actions value is false.
-- RPCs: get_chat_availability(trip), set_trip_chat_settings(trip, chat, actions), admin_get_chat_settings(), admin_set_chat_settings(mode, scope). A NULL argument to a setter means "leave unchanged".

-- ---------------------------------------------------------------------------------------------------------------------
-- Pre-flight: fail LOUDLY if the live state is not what this migration was written for
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.trip_participants') IS NULL THEN
    RAISE EXCEPTION 'chat settings migration: trips / users / trip_participants are missing; this is not the expected database';
  END IF;
  IF to_regclass('public.chat_actions') IS NULL OR to_regclass('public.trip_chat_threads') IS NULL THEN
    RAISE EXCEPTION 'chat settings migration: apply 20261129090000 / 20261129100000 (chat_actions, trip_chat_threads) first';
  END IF;
  IF to_regprocedure('public.begin_chat_action(uuid)') IS NULL OR to_regprocedure('public._chat_action_own(uuid)') IS NULL OR to_regprocedure('public._chat_action_json(public.chat_actions)') IS NULL THEN
    RAISE EXCEPTION 'chat settings migration: begin_chat_action / _chat_action_own / _chat_action_json are missing (apply 20261129090000 first)';
  END IF;
  IF to_regprocedure('public.is_trip_participant(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'chat settings migration: public.is_trip_participant(uuid, uuid) is missing';
  END IF;
  SELECT string_agg(x.c, ', ') INTO v_missing FROM (VALUES ('trips', 'id', 'uuid'), ('trips', 'name', 'text'), ('trips', 'start_date', 'date'), ('trips', 'end_date', 'date'), ('trips', 'created_at', 'timestamp with time zone'),
      ('users', 'id', 'uuid'), ('users', 'role', NULL), ('trip_participants', 'trip_id', 'uuid'), ('trip_participants', 'user_id', 'uuid'), ('trip_participants', 'role', NULL), ('trip_participants', 'active', 'boolean')) AS x(t, c, ty)
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = x.t AND k.column_name = x.c AND (x.ty IS NULL OR k.data_type = x.ty));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'chat settings migration: expected columns are missing or have another type (trips.start_date / end_date must be date): %', v_missing;
  END IF;
  IF to_regclass('public.chat_site_settings') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_site_settings' AND column_name = 'actions_scope') THEN
    RAISE EXCEPTION 'chat settings migration: public.chat_site_settings already exists with a different shape (no actions_scope column); inspect it before applying';
  END IF;
  IF to_regclass('public.trip_chat_settings') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_chat_settings' AND column_name = 'actions') THEN
    RAISE EXCEPTION 'chat settings migration: public.trip_chat_settings already exists with a different shape (no actions column); inspect it before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_site_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),   -- singleton: the only possible key is true
  mode text NOT NULL DEFAULT 'actions' CHECK (mode IN ('off', 'answers', 'actions')),
  actions_scope text NOT NULL DEFAULT 'upcoming' CHECK (actions_scope IN ('upcoming', 'all')),
  updated_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.trip_chat_settings (
  trip_id uuid PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
  chat text NOT NULL DEFAULT 'inherit' CHECK (chat IN ('inherit', 'off')),
  actions text NOT NULL DEFAULT 'inherit' CHECK (actions IN ('inherit', 'off', 'on')),
  updated_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_chat_settings ENABLE ROW LEVEL SECURITY;
-- no policies on purpose: with RLS on and no policy nobody but the owner / service role (BYPASSRLS) can touch a row; the privileges are revoked as well (belt and braces)
REVOKE ALL ON public.chat_site_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trip_chat_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chat_site_settings TO service_role;
GRANT ALL ON public.trip_chat_settings TO service_role;

COMMENT ON TABLE public.chat_site_settings IS 'Trip chat site switch (singleton row): mode off|answers|actions, actions_scope upcoming|all. Written only by admin_set_chat_settings(); read by the trip-chat edge function (service role).';
COMMENT ON TABLE public.trip_chat_settings IS 'Trip chat per-trip switch: chat inherit|off, actions inherit|off|on. Written only by set_trip_chat_settings(); read by the trip-chat edge function (service role). No row = inherit / inherit.';

-- the singleton row cannot be deleted (the edge function and the RPCs read it; a missing row would silently fall back to the environment variable)
CREATE OR REPLACE FUNCTION public.guard_chat_site_settings_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'The site chat settings row cannot be deleted; change it with admin_set_chat_settings()' USING ERRCODE = 'P0001', HINT = 'immutable';
END
$$;
REVOKE ALL ON FUNCTION public.guard_chat_site_settings_delete() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_chat_site_settings_delete ON public.chat_site_settings;
CREATE TRIGGER trg_guard_chat_site_settings_delete BEFORE DELETE ON public.chat_site_settings FOR EACH ROW EXECUTE FUNCTION public.guard_chat_site_settings_delete();

-- seed: nothing changes at apply time; a re-run never overwrites an admin's choice
INSERT INTO public.chat_site_settings (id, mode, actions_scope) VALUES (true, 'actions', 'upcoming') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.trip_chat_settings (trip_id, chat, actions)
  SELECT t.id, 'inherit', 'on' FROM public.trips t WHERE t.id = 'be551bc4-a524-4b6a-a0c9-b74a7168ced4' ON CONFLICT (trip_id) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers (no client can call them; the SECURITY DEFINER RPCs below run as the owner)
-- ---------------------------------------------------------------------------------------------------------------------
-- the "upcoming" rule, identical to tripIsUpcoming() in flags.ts: reference date = end_date, else start_date; upcoming when it is today (UTC) or later or at most 30 days ago; no dates = upcoming
CREATE OR REPLACE FUNCTION public._chat_trip_upcoming(p_start date, p_end date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_end, p_start) IS NULL OR coalesce(p_end, p_start) >= (now() AT TIME ZONE 'UTC')::date - 30
$$;

-- the effective values, the single place the rule lives in SQL
CREATE OR REPLACE FUNCTION public._chat_effective(p_mode text, p_scope text, p_trip_chat text, p_trip_actions text, p_start date, p_end date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'chat', x.chat,
    'actions', x.chat AND p_mode = 'actions' AND p_trip_actions <> 'off'
               AND (p_trip_actions = 'on' OR p_scope = 'all' OR public._chat_trip_upcoming(p_start, p_end)))
  FROM (SELECT p_mode <> 'off' AND p_trip_chat <> 'off' AS chat) x
$$;

CREATE OR REPLACE FUNCTION public._chat_is_site_admin(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_uid AND u.role::text = 'admin')
$$;

-- the availability envelope for one trip as seen by p_uid (no access check: the callers do that)
CREATE OR REPLACE FUNCTION public._chat_availability_json(p_trip_id uuid, p_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode text; v_scope text; v_tchat text; v_tactions text; v_start date; v_end date; v_admin boolean; v_org boolean; v_eff jsonb;
BEGIN
  SELECT s.mode, s.actions_scope INTO v_mode, v_scope FROM public.chat_site_settings s LIMIT 1;
  v_mode := coalesce(v_mode, 'actions'); v_scope := coalesce(v_scope, 'upcoming');
  SELECT c.chat, c.actions INTO v_tchat, v_tactions FROM public.trip_chat_settings c WHERE c.trip_id = p_trip_id;
  v_tchat := coalesce(v_tchat, 'inherit'); v_tactions := coalesce(v_tactions, 'inherit');
  SELECT t.start_date, t.end_date INTO v_start, v_end FROM public.trips t WHERE t.id = p_trip_id;
  v_admin := public._chat_is_site_admin(p_uid);
  v_org := EXISTS (SELECT 1 FROM public.trip_participants o WHERE o.trip_id = p_trip_id AND o.user_id = p_uid AND o.role::text = 'organizer' AND o.active);
  v_eff := public._chat_effective(v_mode, v_scope, v_tchat, v_tactions, v_start, v_end);
  RETURN jsonb_build_object(
    'chat', (v_eff ->> 'chat')::boolean, 'actions', (v_eff ->> 'actions')::boolean,
    'can_manage', v_admin OR v_org, 'can_force_on', v_admin,
    'trip', jsonb_build_object('chat', v_tchat, 'actions', v_tactions),
    'site', jsonb_build_object('mode', v_mode, 'actions_scope', v_scope));
END
$$;

-- the admin envelope: the site row plus every trip, newest first
CREATE OR REPLACE FUNCTION public._chat_admin_json()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode text; v_scope text; v_at timestamptz; v_trips jsonb;
BEGIN
  SELECT s.mode, s.actions_scope, s.updated_at INTO v_mode, v_scope, v_at FROM public.chat_site_settings s LIMIT 1;
  v_mode := coalesce(v_mode, 'actions'); v_scope := coalesce(v_scope, 'upcoming');
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'trip_id', x.id, 'name', x.name, 'start_date', x.start_date, 'end_date', x.end_date, 'chat', x.chat, 'actions', x.actions,
           'effective_chat', (x.eff ->> 'chat')::boolean, 'effective_actions', (x.eff ->> 'actions')::boolean) ORDER BY x.created_at DESC NULLS LAST, x.id), '[]'::jsonb)
    INTO v_trips
  FROM (SELECT t.id, t.name, t.start_date, t.end_date, t.created_at, coalesce(c.chat, 'inherit') AS chat, coalesce(c.actions, 'inherit') AS actions,
               public._chat_effective(v_mode, v_scope, coalesce(c.chat, 'inherit'), coalesce(c.actions, 'inherit'), t.start_date, t.end_date) AS eff
        FROM public.trips t LEFT JOIN public.trip_chat_settings c ON c.trip_id = t.id) x;
  RETURN jsonb_build_object('mode', v_mode, 'actions_scope', v_scope, 'updated_at', v_at, 'trips', v_trips);
END
$$;

REVOKE ALL ON FUNCTION public._chat_trip_upcoming(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._chat_effective(text, text, text, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._chat_is_site_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._chat_availability_json(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._chat_admin_json() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- RPCs (authenticated only)
-- ---------------------------------------------------------------------------------------------------------------------
-- What the assistant is allowed to do on one trip, for the caller (an active participant of the trip, or a site admin).
CREATE OR REPLACE FUNCTION public.get_chat_availability(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF p_trip_id IS NULL OR NOT (public.is_trip_participant(p_trip_id, v_uid) OR public._chat_is_site_admin(v_uid)) THEN
    RAISE EXCEPTION 'Not on this trip' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id) THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  RETURN public._chat_availability_json(p_trip_id, v_uid);
END
$$;

-- Set the trip-level switches. Site admin: anything. Active trip organiser: chat inherit|off, actions inherit|off (never a new "on"). NULL = leave unchanged. Allowed on a frozen trip.
CREATE OR REPLACE FUNCTION public.set_trip_chat_settings(p_trip_id uuid, p_chat text, p_actions text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_cur_chat text; v_cur_actions text; v_chat text; v_actions text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  v_admin := public._chat_is_site_admin(v_uid);
  IF p_trip_id IS NULL OR NOT (v_admin OR EXISTS (SELECT 1 FROM public.trip_participants o WHERE o.trip_id = p_trip_id AND o.user_id = v_uid AND o.role::text = 'organizer' AND o.active)) THEN
    RAISE EXCEPTION 'Only a trip organiser or a site admin can change the assistant settings' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id) THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  IF p_chat IS NOT NULL AND p_chat NOT IN ('inherit', 'off') THEN
    RAISE EXCEPTION 'chat must be inherit or off' USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  IF p_actions IS NOT NULL AND p_actions NOT IN ('inherit', 'off', 'on') THEN
    RAISE EXCEPTION 'actions must be inherit, off or on' USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  SELECT c.chat, c.actions INTO v_cur_chat, v_cur_actions FROM public.trip_chat_settings c WHERE c.trip_id = p_trip_id FOR UPDATE;
  v_cur_chat := coalesce(v_cur_chat, 'inherit'); v_cur_actions := coalesce(v_cur_actions, 'inherit');
  v_chat := coalesce(p_chat, v_cur_chat); v_actions := coalesce(p_actions, v_cur_actions);
  IF v_actions = 'on' AND v_cur_actions <> 'on' AND NOT v_admin THEN
    RAISE EXCEPTION 'Only a site admin can force the assistant''s actions on' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  INSERT INTO public.trip_chat_settings (trip_id, chat, actions, updated_by, updated_at) VALUES (p_trip_id, v_chat, v_actions, v_uid, now())
    ON CONFLICT (trip_id) DO UPDATE SET chat = EXCLUDED.chat, actions = EXCLUDED.actions, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN public._chat_availability_json(p_trip_id, v_uid);
END
$$;

-- Site admins: the site switch plus every trip with its settings and effective result.
CREATE OR REPLACE FUNCTION public.admin_get_chat_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public._chat_is_site_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Site admins only' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  RETURN public._chat_admin_json();
END
$$;

-- Site admins: set the site switch. NULL = leave unchanged.
CREATE OR REPLACE FUNCTION public.admin_set_chat_settings(p_mode text, p_actions_scope text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public._chat_is_site_admin(v_uid) THEN
    RAISE EXCEPTION 'Site admins only' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('off', 'answers', 'actions') THEN
    RAISE EXCEPTION 'mode must be off, answers or actions' USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  IF p_actions_scope IS NOT NULL AND p_actions_scope NOT IN ('upcoming', 'all') THEN
    RAISE EXCEPTION 'actions_scope must be upcoming or all' USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  INSERT INTO public.chat_site_settings (id, mode, actions_scope, updated_by, updated_at) VALUES (true, coalesce(p_mode, 'actions'), coalesce(p_actions_scope, 'upcoming'), v_uid, now())
    ON CONFLICT (id) DO UPDATE SET mode = coalesce(p_mode, public.chat_site_settings.mode), actions_scope = coalesce(p_actions_scope, public.chat_site_settings.actions_scope), updated_by = v_uid, updated_at = now();
  RETURN public._chat_admin_json();
END
$$;

-- Confirming a card already proposed goes from the browser straight to begin_chat_action (the edge function is not involved), so the switch must also be enforced HERE:
-- this is the body of 20261129090000 unchanged, plus one check after the "still on this trip" check. When the effective actions value for the trip is false (site mode, trip switch or the
-- upcoming scope) the confirm is refused with a plain message and the card stays as it was (the person can still dismiss it). The env ceiling TRIP_CHAT_ACTIONS=off cannot be seen from SQL.
CREATE OR REPLACE FUNCTION public.begin_chat_action(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a public.chat_actions;
  v_n integer;
BEGIN
  v_a := public._chat_action_own(p_id);
  IF v_a.status = 'executing' THEN
    RETURN jsonb_build_object('started', false, 'reason', 'already_started', 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.status <> 'proposed' THEN
    RETURN jsonb_build_object('started', false, 'reason', CASE WHEN v_a.status = 'expired' THEN 'expired' ELSE 'not_proposed' END, 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.expires_at <= now() THEN
    UPDATE public.chat_actions SET status = 'expired', finished_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
    RETURN jsonb_build_object('started', false, 'reason', 'expired', 'action', public._chat_action_json(v_a));
  END IF;
  IF NOT public.is_trip_participant(v_a.trip_id, v_uid) THEN
    RAISE EXCEPTION 'You are no longer on this trip' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF NOT coalesce((public._chat_availability_json(v_a.trip_id, v_uid) ->> 'actions')::boolean, false) THEN
    RAISE EXCEPTION 'The assistant is not allowed to make changes on this trip any more, so this suggestion cannot be confirmed. You can dismiss it.' USING ERRCODE = 'P0001', HINT = 'actions_off';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_cap:' || v_uid::text, 0));
  SELECT count(*) INTO v_n FROM public.chat_actions c WHERE c.user_id = v_uid AND c.started_at > now() - interval '24 hours';
  IF v_n >= 25 THEN
    RAISE EXCEPTION 'You have confirmed 25 assistant actions in the last 24 hours; try again later' USING ERRCODE = 'P0001', HINT = 'daily_cap';
  END IF;
  UPDATE public.chat_actions SET status = 'executing', started_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('started', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;
REVOKE ALL ON FUNCTION public.begin_chat_action(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_chat_action(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_chat_availability(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_trip_chat_settings(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_chat_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_chat_settings(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_chat_availability(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_trip_chat_settings(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_chat_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_chat_settings(text, text) TO authenticated;

COMMENT ON FUNCTION public.get_chat_availability(uuid) IS 'What the assistant may do on one trip for the caller (active participant or site admin): {chat, actions, can_manage, can_force_on, trip:{chat,actions}, site:{mode,actions_scope}}.';
COMMENT ON FUNCTION public.set_trip_chat_settings(uuid, text, text) IS 'Set the trip-level assistant switches. Site admin: anything; trip organiser: chat inherit|off, actions inherit|off (never a new "on"). NULL = unchanged. Works on frozen trips. Returns get_chat_availability().';
COMMENT ON FUNCTION public.admin_get_chat_settings() IS 'Site admins only: the site switch and every trip with its settings and effective result.';
COMMENT ON FUNCTION public.admin_set_chat_settings(text, text) IS 'Site admins only: set the site switch (mode off|answers|actions, actions_scope upcoming|all). NULL = unchanged. Returns admin_get_chat_settings().';

NOTIFY pgrst, 'reload schema';
