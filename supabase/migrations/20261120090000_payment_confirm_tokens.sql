-- One-tap "I received it" from the payment email, without a login.
--
-- The payment-notice edge function emails the receiver of a marked_paid payment a
-- button. The button must never change state on a GET (mail scanners and link
-- previews fetch links), so the link opens an app page that POSTs to the
-- payment-confirm edge function, which calls the functions below with the
-- service role. The raw token only exists in the email; we store its SHA-256.
--
-- ADDITIVE AND RE-RUNNABLE: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- idempotent REVOKE/GRANT, DROP TRIGGER IF EXISTS + CREATE TRIGGER for the one new trigger.
-- No existing table, policy, trigger or function is changed.
--
-- Objects:
--   payment_confirm_tokens (RLS on, NO policies, no grants to anon/authenticated)
--   payment_confirm_rate_limits (RLS on, NO policies)
--   issue_payment_confirm_token(uuid, text)  -> jsonb
--   confirm_payment_by_token(text)           -> jsonb
--   dispute_payment_by_token(text)           -> jsonb
--   payment_confirm_rate_hit(text, int, int) -> boolean
--   supersede_payment_tokens_on_status_change() -> trigger (AFTER UPDATE OF status on settlements)
-- All four functions are SECURITY DEFINER, search_path pinned, EXECUTE for
-- service_role only (REVOKE from PUBLIC, anon, authenticated) AND their first
-- statement requires auth.role() = 'service_role'. Ordinary token problems
-- (unknown, used, expired, changed) are returned as {result: ...}, never raised.
--
-- ASSUMPTIONS (verify with supabase/PRE_APPLY_CHECKS.sql group 18):
--   * settlements(id, trip_id, from_user_id, to_user_id, amount numeric, currency text NULL,
--     status text CHECK in suggested|marked_paid|confirmed, ...); trips.base_currency;
--   * activity_feed(trip_id, actor, verb, entity jsonb, metadata jsonb), no verb CHECK;
--   * users(first_name, full_name);
--   * triggers on settlements: guard_immutable_keys and guard_settlement_party_update
--     (BEFORE UPDATE), unchanged by this migration. This migration ADDS one AFTER UPDATE
--     trigger (see the end of the file) that retires unused tokens when a payment leaves
--     marked_paid.
--
-- LOCK ORDER: settlement row first, then token row, everywhere (issue, check, and the
-- AFTER UPDATE trigger, which runs while the caller already holds the settlement row).
-- That keeps an in-app status change and an email click from deadlocking.
--
-- HOW THE CONFIRM PASSES THE GUARD TRIGGER (which is NOT modified):
-- guard_settlement_party_update decides by auth.uid(). In a service-role call
-- auth.uid() is NULL, so the trigger would fall through to "Not permitted".
-- confirm_payment_by_token therefore sets, transaction-locally (set_config(..., true)),
-- request.jwt.claim.sub and request.jwt.claims to the RECEIVER's id before its single
-- UPDATE, then restores the previous values. The trigger then sees exactly "the payee
-- moving marked_paid -> confirmed with amount, currency, method, notes and settled_at
-- untouched", the one thing it allows the payee, and enforces it. (If the receiver is
-- also an organizer the trigger's privileged branch applies, as in the app.) This is not
-- a weakening: only this service_role-only function sets those settings, the UPDATE is
-- restricted to status marked_paid -> confirmed, and the settings are restored before
-- return. Ordinary clients cannot set request.jwt.claim.* (PostgREST sets them from the
-- verified JWT). SECURITY DEFINER runs as the table owner so RLS is bypassed;
-- guard_immutable_keys and the status CHECK are satisfied (only status changes).

CREATE TABLE IF NOT EXISTS public.payment_confirm_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES public.settlements(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES public.users(id),
  token_hash text NOT NULL UNIQUE,
  amount numeric NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  used_at timestamptz,
  used_action text
);
ALTER TABLE public.payment_confirm_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_confirm_tokens FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS payment_confirm_tokens_live_idx
  ON public.payment_confirm_tokens (settlement_id, receiver_id) WHERE used_at IS NULL;
-- Plain index so the ON DELETE CASCADE from settlements does not scan the table.
CREATE INDEX IF NOT EXISTS payment_confirm_tokens_settlement_idx
  ON public.payment_confirm_tokens (settlement_id);

CREATE TABLE IF NOT EXISTS public.payment_confirm_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 0
);
ALTER TABLE public.payment_confirm_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_confirm_rate_limits FROM PUBLIC, anon, authenticated;

-- Display name the way the app does it: first name, else first word of full name.
CREATE OR REPLACE FUNCTION public._payment_token_name(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(btrim(u.first_name), ''), NULLIF(split_part(btrim(COALESCE(u.full_name, '')), ' ', 1), ''), 'Someone')
  FROM public.users u WHERE u.id = p_user
$$;
REVOKE ALL ON FUNCTION public._payment_token_name(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.issue_payment_confirm_token(p_settlement_id uuid, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.settlements%ROWTYPE;
  v_cur text;
  v_exp timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND OR s.status IS DISTINCT FROM 'marked_paid' THEN
    RETURN jsonb_build_object('result', 'not_marked_paid');
  END IF;
  SELECT COALESCE(s.currency, t.base_currency, 'GBP') INTO v_cur FROM public.trips t WHERE t.id = s.trip_id;
  v_cur := COALESCE(v_cur, s.currency, 'GBP');
  UPDATE public.payment_confirm_tokens
     SET used_at = now(), used_action = 'superseded'
   WHERE settlement_id = s.id AND receiver_id = s.to_user_id AND used_at IS NULL;
  INSERT INTO public.payment_confirm_tokens (settlement_id, receiver_id, token_hash, amount, currency)
  VALUES (s.id, s.to_user_id, p_token_hash, s.amount, v_cur)
  RETURNING expires_at INTO v_exp;
  RETURN jsonb_build_object('result', 'issued', 'expires_at', v_exp);
END $$;

-- Shared validation. Locks the settlement row, then the token row (held to the end of the
-- caller's transaction) and returns 'ok' or the reason it is not usable.
-- A token whose payment has meanwhile been confirmed (in the app, by an organizer, or by
-- this very token) reports 'already_confirmed' even if it was used or superseded, so a link
-- always shows the CURRENT truth.
CREATE OR REPLACE FUNCTION public._payment_token_check(p_hash text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tok public.payment_confirm_tokens;
  s public.settlements;
  v_sid uuid;
  v_have_s boolean;
  v_cur text;
BEGIN
  SELECT settlement_id INTO v_sid FROM public.payment_confirm_tokens WHERE token_hash = p_hash;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO s FROM public.settlements WHERE id = v_sid FOR UPDATE;
  v_have_s := FOUND;
  SELECT * INTO tok FROM public.payment_confirm_tokens WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF tok.used_at IS NOT NULL THEN
    IF v_have_s AND s.status = 'confirmed' THEN RETURN 'already_confirmed'; END IF;
    RETURN CASE WHEN tok.used_action = 'superseded' THEN 'expired' ELSE 'used' END;
  END IF;
  IF tok.expires_at <= now() THEN RETURN 'expired'; END IF;
  IF NOT v_have_s THEN RETURN 'changed'; END IF;
  SELECT COALESCE(s.currency, t.base_currency, 'GBP') INTO v_cur FROM public.trips t WHERE t.id = s.trip_id;
  v_cur := COALESCE(v_cur, s.currency, 'GBP');
  IF s.to_user_id IS DISTINCT FROM tok.receiver_id OR s.amount IS DISTINCT FROM tok.amount OR v_cur IS DISTINCT FROM tok.currency THEN
    RETURN 'changed';
  END IF;
  IF s.status = 'confirmed' THEN RETURN 'already_confirmed'; END IF;
  IF s.status IS DISTINCT FROM 'marked_paid' THEN RETURN 'changed'; END IF;
  RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION public._payment_token_check(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._payment_token_summary(tok public.payment_confirm_tokens, s public.settlements, res text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('result', res, 'settlement_id', tok.settlement_id, 'trip_id', s.trip_id,
    'payer_id', s.from_user_id, 'receiver_id', tok.receiver_id, 'amount', tok.amount, 'currency', tok.currency,
    'used_action', tok.used_action)
$$;
REVOKE ALL ON FUNCTION public._payment_token_summary(public.payment_confirm_tokens, public.settlements, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.confirm_payment_by_token(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tok public.payment_confirm_tokens;
  s public.settlements;
  res text;
  v_old_sub text;
  v_old_claims text;
  v_rows integer;
  v_label text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  res := public._payment_token_check(p_token_hash);
  SELECT * INTO tok FROM public.payment_confirm_tokens WHERE token_hash = p_token_hash;
  SELECT * INTO s FROM public.settlements WHERE id = tok.settlement_id;
  IF res = 'not_found' THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF res IS DISTINCT FROM 'ok' THEN
    IF tok.id IS NULL THEN RETURN jsonb_build_object('result', res); END IF;
    -- Paid and confirmed elsewhere: this link must never work again, even if the payment is
    -- later reverted to marked_paid.
    IF res = 'already_confirmed' THEN
      UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'superseded' WHERE id = tok.id AND used_at IS NULL;
    END IF;
    RETURN public._payment_token_summary(tok, s, res);
  END IF;

  v_old_sub := current_setting('request.jwt.claim.sub', true);
  v_old_claims := current_setting('request.jwt.claims', true);
  PERFORM set_config('request.jwt.claim.sub', tok.receiver_id::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', tok.receiver_id::text, 'role', 'authenticated')::text, true);
  UPDATE public.settlements SET status = 'confirmed'
   WHERE id = s.id AND status = 'marked_paid'
     AND to_user_id = tok.receiver_id AND amount = tok.amount AND COALESCE(currency, tok.currency) = tok.currency;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
  IF v_rows <> 1 THEN
    RETURN public._payment_token_summary(tok, s, 'changed');
  END IF;

  UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'confirmed' WHERE id = tok.id
  RETURNING * INTO tok;
  v_label := public._payment_token_name(s.from_user_id) || ' → ' || public._payment_token_name(s.to_user_id);
  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (s.trip_id, tok.receiver_id, 'settlement_confirmed_by_email',
    jsonb_build_object('type', 'settlement', 'id', s.id, 'label', v_label),
    jsonb_build_object('payer_id', s.from_user_id, 'receiver_id', tok.receiver_id, 'amount', tok.amount, 'currency', tok.currency, 'via', 'email'));
  RETURN public._payment_token_summary(tok, s, 'confirmed');
END $$;

CREATE OR REPLACE FUNCTION public.dispute_payment_by_token(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tok public.payment_confirm_tokens;
  s public.settlements;
  res text;
  v_label text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  res := public._payment_token_check(p_token_hash);
  SELECT * INTO tok FROM public.payment_confirm_tokens WHERE token_hash = p_token_hash;
  SELECT * INTO s FROM public.settlements WHERE id = tok.settlement_id;
  IF res = 'not_found' THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF res IS DISTINCT FROM 'ok' THEN
    IF tok.id IS NULL THEN RETURN jsonb_build_object('result', res); END IF;
    -- Paid and confirmed elsewhere: this link must never work again, even if the payment is
    -- later reverted to marked_paid.
    IF res = 'already_confirmed' THEN
      UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'superseded' WHERE id = tok.id AND used_at IS NULL;
    END IF;
    RETURN public._payment_token_summary(tok, s, res);
  END IF;
  UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'disputed' WHERE id = tok.id
  RETURNING * INTO tok;
  v_label := public._payment_token_name(s.from_user_id) || ' → ' || public._payment_token_name(s.to_user_id);
  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (s.trip_id, tok.receiver_id, 'settlement_receipt_disputed',
    jsonb_build_object('type', 'settlement', 'id', s.id, 'label', v_label),
    jsonb_build_object('payer_id', s.from_user_id, 'receiver_id', tok.receiver_id, 'amount', tok.amount, 'currency', tok.currency, 'via', 'email'));
  RETURN public._payment_token_summary(tok, s, 'disputed');
END $$;

CREATE OR REPLACE FUNCTION public.payment_confirm_rate_hit(p_key text, p_limit integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hits integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.payment_confirm_rate_limits WHERE window_start < now() - interval '1 day';
  INSERT INTO public.payment_confirm_rate_limits AS r (key, window_start, hits) VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE
    SET hits = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.hits + 1 END,
        window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END
  RETURNING hits INTO v_hits;
  RETURN v_hits <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.issue_payment_confirm_token(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_payment_by_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispute_payment_by_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payment_confirm_rate_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_payment_confirm_token(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_payment_by_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispute_payment_by_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_confirm_rate_hit(text, integer, integer) TO service_role;
GRANT ALL ON public.payment_confirm_tokens, public.payment_confirm_rate_limits TO service_role;

-- When a payment leaves marked_paid by ANY route (receiver or organizer confirms in the app, an
-- organizer reverts it to suggested, the token flow itself), its unused email tokens die. Without
-- this, a link left unused after an in-app confirmation would confirm again if the payment were
-- later reverted to marked_paid. (Deleting the payment cascades to its tokens.)
-- AFTER UPDATE, row level, touches only payment_confirm_tokens, never settlements, so it cannot
-- change what the BEFORE UPDATE guard triggers decide, and it takes the token row lock AFTER the
-- settlement row lock the UPDATE already holds (same order as the functions above). SECURITY
-- DEFINER because ordinary users have no grants on the token table; trigger functions need no
-- EXECUTE grant to fire, so it is revoked from everyone.
CREATE OR REPLACE FUNCTION public.supersede_payment_tokens_on_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.payment_confirm_tokens
     SET used_at = now(), used_action = 'superseded'
   WHERE settlement_id = NEW.id AND used_at IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.supersede_payment_tokens_on_status_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_supersede_payment_tokens ON public.settlements;
CREATE TRIGGER trigger_supersede_payment_tokens
  AFTER UPDATE OF status ON public.settlements
  FOR EACH ROW
  WHEN (OLD.status = 'marked_paid' AND NEW.status IS DISTINCT FROM 'marked_paid')
  EXECUTE FUNCTION public.supersede_payment_tokens_on_status_change();
