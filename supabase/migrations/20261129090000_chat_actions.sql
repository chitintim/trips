SET LOCAL lock_timeout = '5s';

-- Trip chat, A1 (1/3): chat_actions, the audit record and state machine for actions the assistant PROPOSES. The model only ever proposes; the CLIENT executes on a tap with the user's
-- own JWT (proposal 4.3); these tables/RPCs are the bookkeeping that makes a double tap, a retry or a second device run an action once.
--
-- ADDITIVE AND RE-RUNNABLE: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE TRIGGER, idempotent REVOKE/GRANT. Nothing existing is changed.
--
-- WHO WRITES WHAT: the edge function (SERVICE ROLE) inserts proposals. A signed-in client may only SELECT its own rows; INSERT / UPDATE / DELETE are revoked, so a client cannot
-- create a proposal or alter params / kind / preview / basis / requires. A trigger additionally freezes id / trip_id / user_id / turn_id / kind / params / requires / created_at for EVERY
-- writer. State moves only through the SECURITY DEFINER RPCs below, each checking user_id = auth.uid() and the allowed from -> to move.
-- DAILY CAP (decision D7): 25 CONFIRMED actions per person per rolling 24 hours, counted at begin_chat_action (started_at). A retry of an already-started action does not consume another.
-- EXPIRY: 24h (expires_at), applied lazily by begin / dismiss / mark and in bulk by chat_actions_expire_stale() (service role).
-- kind is free-form lower_snake (new action kinds need no migration); requires is tap | review.

-- ---------------------------------------------------------------------------------------------------------------------
-- Pre-flight: fail LOUDLY if the live state is not what this migration was written for
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.trip_participants') IS NULL THEN
    RAISE EXCEPTION 'chat_actions migration: trips / users / trip_participants are missing; this is not the expected database';
  END IF;
  IF to_regclass('public.trip_chat_messages') IS NULL THEN
    RAISE EXCEPTION 'chat_actions migration: public.trip_chat_messages does not exist (message_id references it)';
  END IF;
  IF to_regprocedure('public.is_trip_participant(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'chat_actions migration: public.is_trip_participant(uuid, uuid) is missing';
  END IF;
  IF to_regclass('public.chat_actions') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_actions' AND column_name = 'params') THEN
    RAISE EXCEPTION 'chat_actions migration: public.chat_actions already exists with a different shape (no params column); inspect it before applying';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.chat_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL,
  message_id uuid NULL REFERENCES public.trip_chat_messages(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  params jsonb NOT NULL,
  preview jsonb NOT NULL,
  basis jsonb NOT NULL,
  requires text NOT NULL CHECK (requires IN ('tap', 'review')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'executing', 'done', 'failed', 'dismissed', 'expired', 'edited_elsewhere')),
  result jsonb NULL,
  error text NULL,
  edited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  started_at timestamptz NULL,
  finished_at timestamptz NULL
);
-- two identical proposals in one turn (parallel tool calls) are one card: the edge function inserts with ON CONFLICT DO NOTHING / treats 23505 as "already proposed"
CREATE UNIQUE INDEX IF NOT EXISTS chat_actions_turn_dedupe_uidx ON public.chat_actions (trip_id, user_id, turn_id, kind, md5(params::text));
CREATE INDEX IF NOT EXISTS chat_actions_user_turn_idx ON public.chat_actions (user_id, turn_id);
CREATE INDEX IF NOT EXISTS chat_actions_trip_user_created_idx ON public.chat_actions (trip_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS chat_actions_started_idx ON public.chat_actions (user_id, started_at) WHERE started_at IS NOT NULL;
ALTER TABLE public.chat_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own chat actions" ON public.chat_actions;
CREATE POLICY "Users can view their own chat actions" ON public.chat_actions FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.chat_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.chat_actions TO authenticated;
GRANT ALL ON public.chat_actions TO service_role;

-- the immutable part of a proposal, for every writer (the edge function included)
CREATE OR REPLACE FUNCTION public.guard_chat_action_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.params IS DISTINCT FROM OLD.params OR NEW.requires IS DISTINCT FROM OLD.requires OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A proposed action cannot be changed' USING ERRCODE = 'P0001', HINT = 'immutable';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_chat_action_update ON public.chat_actions;
CREATE TRIGGER trg_guard_chat_action_update BEFORE UPDATE ON public.chat_actions FOR EACH ROW EXECUTE FUNCTION public.guard_chat_action_update();

-- the envelope every RPC returns
CREATE OR REPLACE FUNCTION public._chat_action_json(a public.chat_actions)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('id', a.id, 'trip_id', a.trip_id, 'turn_id', a.turn_id, 'kind', a.kind, 'params', a.params, 'preview', a.preview, 'basis', a.basis,
                            'requires', a.requires, 'status', a.status, 'result', a.result, 'error', a.error, 'edited', a.edited, 'created_at', a.created_at,
                            'expires_at', a.expires_at, 'started_at', a.started_at, 'finished_at', a.finished_at)
$$;

-- owner lookup with a row lock; an id that is not yours looks exactly like an id that does not exist
CREATE OR REPLACE FUNCTION public._chat_action_own(p_id uuid)
RETURNS public.chat_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a public.chat_actions;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  SELECT * INTO v_a FROM public.chat_actions WHERE id = p_id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  RETURN v_a;
END
$$;

-- proposed -> executing, atomically; the cap is checked only on the real transition
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
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_cap:' || v_uid::text, 0));
  SELECT count(*) INTO v_n FROM public.chat_actions c WHERE c.user_id = v_uid AND c.started_at > now() - interval '24 hours';
  IF v_n >= 25 THEN
    RAISE EXCEPTION 'You have confirmed 25 assistant actions in the last 24 hours; try again later' USING ERRCODE = 'P0001', HINT = 'daily_cap';
  END IF;
  UPDATE public.chat_actions SET status = 'executing', started_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('started', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;

-- executing -> done | failed
CREATE OR REPLACE FUNCTION public.finish_chat_action(p_id uuid, p_ok boolean, p_result jsonb DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.chat_actions;
BEGIN
  v_a := public._chat_action_own(p_id);
  IF p_result IS NOT NULL AND (jsonb_typeof(p_result) <> 'object' OR pg_column_size(p_result) > 16384) THEN
    RAISE EXCEPTION 'result must be an object under 16 KB' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  IF v_a.status IN ('done', 'failed') THEN
    RETURN jsonb_build_object('finished', false, 'reason', 'already_finished', 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.status <> 'executing' THEN
    RAISE EXCEPTION 'This action was not started' USING ERRCODE = 'P0001', HINT = 'not_started';
  END IF;
  UPDATE public.chat_actions
     SET status = CASE WHEN coalesce(p_ok, false) THEN 'done' ELSE 'failed' END, result = p_result, error = left(p_error, 500), finished_at = now()
   WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('finished', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;

-- proposed -> dismissed (idempotent)
CREATE OR REPLACE FUNCTION public.dismiss_chat_action(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.chat_actions;
BEGIN
  v_a := public._chat_action_own(p_id);
  IF v_a.status = 'dismissed' THEN
    RETURN jsonb_build_object('dismissed', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.status = 'proposed' AND v_a.expires_at <= now() THEN
    UPDATE public.chat_actions SET status = 'expired', finished_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  END IF;
  IF v_a.status <> 'proposed' THEN
    RETURN jsonb_build_object('dismissed', false, 'reason', CASE WHEN v_a.status = 'expired' THEN 'expired' ELSE 'not_proposed' END, 'action', public._chat_action_json(v_a));
  END IF;
  UPDATE public.chat_actions SET status = 'dismissed', finished_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('dismissed', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;

-- proposed -> edited_elsewhere: the user opened the real sheet from the card and saved there
CREATE OR REPLACE FUNCTION public.mark_chat_action_edited(p_id uuid, p_result jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.chat_actions;
BEGIN
  v_a := public._chat_action_own(p_id);
  IF p_result IS NOT NULL AND (jsonb_typeof(p_result) <> 'object' OR pg_column_size(p_result) > 16384) THEN
    RAISE EXCEPTION 'result must be an object under 16 KB' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  IF v_a.status = 'proposed' AND v_a.expires_at <= now() THEN
    UPDATE public.chat_actions SET status = 'expired', finished_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  END IF;
  IF v_a.status = 'edited_elsewhere' THEN
    RETURN jsonb_build_object('marked', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.status <> 'proposed' THEN
    RETURN jsonb_build_object('marked', false, 'reason', CASE WHEN v_a.status = 'expired' THEN 'expired' ELSE 'not_proposed' END, 'action', public._chat_action_json(v_a));
  END IF;
  UPDATE public.chat_actions SET status = 'edited_elsewhere', edited = true, result = p_result, finished_at = now() WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('marked', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;

-- done -> done with result.undone_at set (the client ran the inverse: Undo within 10 minutes). Idempotent; only the owner; only a succeeded action; only that one key of result changes.
CREATE OR REPLACE FUNCTION public.mark_chat_action_undone(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.chat_actions;
BEGIN
  v_a := public._chat_action_own(p_id);
  IF v_a.status <> 'done' THEN
    RETURN jsonb_build_object('undone', false, 'reason', 'not_done', 'action', public._chat_action_json(v_a));
  END IF;
  IF v_a.result IS NOT NULL AND v_a.result ? 'undone_at' THEN
    RETURN jsonb_build_object('undone', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
  END IF;
  UPDATE public.chat_actions SET result = coalesce(result, '{}'::jsonb) || jsonb_build_object('undone_at', now()) WHERE id = v_a.id RETURNING * INTO v_a;
  RETURN jsonb_build_object('undone', true, 'reason', NULL, 'action', public._chat_action_json(v_a));
END
$$;

-- bulk expiry (the edge function calls it before it summarises outcomes for the next turn)
CREATE OR REPLACE FUNCTION public.chat_actions_expire_stale()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.chat_actions SET status = 'expired', finished_at = now() WHERE status = 'proposed' AND expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

REVOKE ALL ON FUNCTION public.guard_chat_action_update() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._chat_action_json(public.chat_actions) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._chat_action_own(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_chat_action(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_chat_action(uuid, boolean, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dismiss_chat_action(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_chat_action_edited(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_chat_action_undone(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_actions_expire_stale() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_chat_action(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_chat_action(uuid, boolean, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_chat_action(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_chat_action_edited(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_chat_action_undone(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_actions_expire_stale() TO service_role;

NOTIFY pgrst, 'reload schema';
