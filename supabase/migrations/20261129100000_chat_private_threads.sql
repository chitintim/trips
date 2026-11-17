SET LOCAL lock_timeout = '5s';

-- Trip chat, A1 (2/3): PRIVATE threads. Every person gets their own thread per trip; the old shared history stays readable and READ-ONLY.
--
-- ADDITIVE AND RE-RUNNABLE. The live policies of trip_chat_messages are NOT in the repo, so this migration does not touch any of them (no DROP POLICY by guessed name). It adds
-- RESTRICTIVE policies, which Postgres ANDs with whatever permissive policies exist: the live "participants can read" policy keeps deciding who is on the trip, and ours additionally
-- hides other people's private threads. It FAILS LOUDLY (pre-flight below) if the live table is not what we expect.
--
--   trip_chat_messages.thread_user_id uuid NULL -> users  : whose private thread the row belongs to (NULL = legacy shared history)
--   trip_chat_messages.turn_id uuid NULL                  : the client's per-send uuid; unique per (trip, thread, role) so a retried POST cannot duplicate a turn
--   RESTRICTIVE SELECT : thread_user_id IS NULL (legacy, still limited by the live policy) OR thread_user_id = auth.uid()
--   RESTRICTIVE INSERT : thread_user_id = auth.uid()   (clients can never forge a legacy row; the edge function uses the service role and bypasses RLS)
--   RESTRICTIVE UPDATE / DELETE : thread_user_id = auth.uid() (legacy rows are read-only for clients)
--   trip_chat_threads(trip_id, user_id, last_seen_at, cleared_at): "since I last looked" and "New chat"; SELECT own; writes through new_chat / mark_chat_seen.

DO $$
DECLARE
  v_rls boolean;
  v_permissive integer;
  v_missing text;
BEGIN
  IF to_regclass('public.trip_chat_messages') IS NULL THEN
    RAISE EXCEPTION 'private threads: public.trip_chat_messages does not exist';
  END IF;
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c WHERE c.oid = 'public.trip_chat_messages'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'private threads: row level security is OFF on trip_chat_messages (expected ON); refusing to add policies to an unprotected table';
  END IF;
  SELECT string_agg(x.c, ', ') INTO v_missing FROM (VALUES ('id'), ('trip_id'), ('user_id'), ('role'), ('content'), ('created_at')) x(c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = 'trip_chat_messages' AND k.column_name = x.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'private threads: trip_chat_messages lacks the expected columns: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_chat_messages' AND column_name = 'thread_user_id' AND udt_name <> 'uuid')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_chat_messages' AND column_name = 'turn_id' AND udt_name <> 'uuid') THEN
    RAISE EXCEPTION 'private threads: thread_user_id / turn_id already exist with a type other than uuid';
  END IF;
  SELECT count(*) INTO v_permissive FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trip_chat_messages' AND cmd IN ('SELECT', 'ALL') AND permissive = 'PERMISSIVE';
  IF v_permissive = 0 THEN
    RAISE EXCEPTION 'private threads: trip_chat_messages has NO permissive SELECT policy today (the chat could not be read); the live policies are not what this migration expects, inspect them first';
  END IF;
  IF to_regclass('public.users') IS NULL OR to_regprocedure('public.is_trip_participant(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'private threads: users / is_trip_participant(uuid, uuid) are missing';
  END IF;
END
$$;

ALTER TABLE public.trip_chat_messages ADD COLUMN IF NOT EXISTS thread_user_id uuid NULL REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.trip_chat_messages ADD COLUMN IF NOT EXISTS turn_id uuid NULL;
CREATE INDEX IF NOT EXISTS trip_chat_messages_thread_idx ON public.trip_chat_messages (trip_id, thread_user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS trip_chat_messages_turn_uidx ON public.trip_chat_messages (trip_id, thread_user_id, turn_id, role) WHERE turn_id IS NOT NULL;

DROP POLICY IF EXISTS "Private chat threads: read only your own thread or legacy history" ON public.trip_chat_messages;
CREATE POLICY "Private chat threads: read only your own thread or legacy history" ON public.trip_chat_messages
  AS RESTRICTIVE FOR SELECT USING (thread_user_id IS NULL OR thread_user_id = auth.uid());
DROP POLICY IF EXISTS "Private chat threads: write only into your own thread" ON public.trip_chat_messages;
CREATE POLICY "Private chat threads: write only into your own thread" ON public.trip_chat_messages
  AS RESTRICTIVE FOR INSERT WITH CHECK (thread_user_id = auth.uid());
DROP POLICY IF EXISTS "Private chat threads: change only your own thread" ON public.trip_chat_messages;
CREATE POLICY "Private chat threads: change only your own thread" ON public.trip_chat_messages
  AS RESTRICTIVE FOR UPDATE USING (thread_user_id = auth.uid()) WITH CHECK (thread_user_id = auth.uid());
DROP POLICY IF EXISTS "Private chat threads: delete only your own thread" ON public.trip_chat_messages;
CREATE POLICY "Private chat threads: delete only your own thread" ON public.trip_chat_messages
  AS RESTRICTIVE FOR DELETE USING (thread_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.trip_chat_threads (
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz NULL,
  PRIMARY KEY (trip_id, user_id)
);
ALTER TABLE public.trip_chat_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own chat thread state" ON public.trip_chat_threads;
CREATE POLICY "Users can view their own chat thread state" ON public.trip_chat_threads FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.trip_chat_threads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_chat_threads TO authenticated;
GRANT ALL ON public.trip_chat_threads TO service_role;

CREATE OR REPLACE FUNCTION public.new_chat(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF NOT public.is_trip_participant(p_trip_id, v_uid) THEN
    RAISE EXCEPTION 'You are not on this trip' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  INSERT INTO public.trip_chat_threads (trip_id, user_id, last_seen_at, cleared_at) VALUES (p_trip_id, v_uid, now(), now())
  ON CONFLICT (trip_id, user_id) DO UPDATE SET cleared_at = now(), last_seen_at = now() RETURNING cleared_at INTO v_at;
  RETURN jsonb_build_object('cleared_at', v_at);
END
$$;

CREATE OR REPLACE FUNCTION public.mark_chat_seen(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF NOT public.is_trip_participant(p_trip_id, v_uid) THEN
    RAISE EXCEPTION 'You are not on this trip' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  INSERT INTO public.trip_chat_threads (trip_id, user_id, last_seen_at) VALUES (p_trip_id, v_uid, now())
  ON CONFLICT (trip_id, user_id) DO UPDATE SET last_seen_at = now() RETURNING last_seen_at INTO v_at;
  RETURN jsonb_build_object('last_seen_at', v_at);
END
$$;

REVOKE ALL ON FUNCTION public.new_chat(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_chat_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.new_chat(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_chat_seen(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
