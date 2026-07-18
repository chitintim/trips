-- Rate-limit the anon-callable invitation RPCs. validate_invitation_code
-- and get_invitation_preview (20260707110000 §3, 20260707130000) are
-- reachable with just the anon key and previously unthrottled, so a script
-- could brute-force / enumerate invitation codes at full REST throughput.
--
-- Mechanism: GLOBAL-PER-CODE lockout, not per-IP. Reasons:
--   - log_invitation_attempt never sets invitation_attempts.ip_address
--     (it comes from a column default), and behind PostgREST + the
--     connection pooler inet_client_addr() typically resolves to the
--     pooler, not the end client -- so "per IP" would collapse into one
--     shared bucket, throttling legitimate users while doing nothing
--     against a distributed prober. A per-code counter is attacker-cost
--     shaped instead: each candidate code gets at most N probes per
--     window across ALL callers, which is exactly what code enumeration
--     needs unbounded.
--   - It reuses the existing invitation_attempts audit table; no new
--     counter table.
--
-- Crucially, failed probes are now logged SERVER-SIDE inside the RPCs
-- themselves: previously only Signup.tsx voluntarily called
-- log_invitation_attempt after validating, so a direct REST caller left no
-- trail and a counter would never trip. Server-side rows carry
-- user_agent = '[server:...]' so the Signup flow's own client-side log
-- (which has the real user agent) remains distinguishable; the client call
-- is kept, so one failed UI attempt now logs twice -- the threshold below
-- is sized with that in mind.
--
-- Behavior when locked out: return the SAME shape as an invalid / unknown
-- code ('not_found' from validate_invitation_code, zero rows from
-- get_invitation_preview), so the limiter is not an oracle -- a prober
-- cannot distinguish "code does not exist" from "code is being shielded".
-- A real user who fat-fingers a valid code repeatedly sees "invalid code"
-- until the 15-minute window slides; acceptable, and the attempts remain
-- visible to admins via get_recent_failed_attempts.
--
-- Threshold: > 30 FAILED attempts against the same normalized code in the
-- last 15 minutes. Successful validations don't count, so a shared /join
-- link opened by a whole group does not lock the code out.

-- ---------------------------------------------------------------------------
-- Shared helpers (SECURITY DEFINER: invitation_attempts has no anon
-- SELECT/INSERT policy, by design -- see 20260718110000).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invitation_code_locked_out(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*) > 30
  FROM public.invitation_attempts
  WHERE upper(code_attempted) = upper(left(p_code, 64))
    AND success = false
    AND created_at > now() - interval '15 minutes';
$$;

COMMENT ON FUNCTION public.invitation_code_locked_out(text) IS 'Global-per-code brute-force lockout for the anon invitation RPCs (> 30 failed attempts / 15 min). Per-IP was rejected because the pooler masks client IPs.';

-- Server-side probe log: mirrors log_invitation_attempt's caps but tags the
-- row so admin tooling can tell RPC-internal rows from Signup's own logging.
CREATE OR REPLACE FUNCTION public.log_invitation_probe(p_code text, p_success boolean, p_source text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.invitation_attempts (code_attempted, success, user_agent)
  VALUES (left(p_code, 64), p_success, left('[server:' || p_source || ']', 512));
EXCEPTION WHEN OTHERS THEN
  -- Logging must never break code validation for real users.
  NULL;
END;
$$;

-- Internal helpers for the two RPCs below; no direct client callers.
REVOKE ALL ON FUNCTION public.invitation_code_locked_out(text) FROM anon;
REVOKE ALL ON FUNCTION public.invitation_code_locked_out(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.log_invitation_probe(text, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_invitation_probe(text, boolean, text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- validate_invitation_code: unchanged semantics (matches 20260707110000 §3)
-- plus (a) server-side logging of failed lookups, (b) the lockout
-- short-circuit, indistinguishable from 'not_found'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_invitation_code(p_code text)
RETURNS TABLE (
  invitation_id uuid,
  is_valid boolean,
  reason text,
  trip_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv public.invitations%ROWTYPE;
BEGIN
  IF public.invitation_code_locked_out(p_code) THEN
    -- Do NOT log while locked out: otherwise the attacker's own probes
    -- keep the window saturated forever AND the table grows unboundedly.
    RETURN QUERY SELECT NULL::uuid, false, 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_inv FROM public.invitations WHERE code = upper(p_code);

  IF NOT FOUND THEN
    PERFORM public.log_invitation_probe(p_code, false, 'validate_invitation_code');
    RETURN QUERY SELECT NULL::uuid, false, 'not_found'::text, NULL::uuid;
  ELSIF v_inv.used_by IS NOT NULL THEN
    PERFORM public.log_invitation_probe(p_code, false, 'validate_invitation_code');
    RETURN QUERY SELECT v_inv.id, false, 'already_used'::text, NULL::uuid;
  ELSIF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < now() THEN
    PERFORM public.log_invitation_probe(p_code, false, 'validate_invitation_code');
    RETURN QUERY SELECT v_inv.id, false, 'expired'::text, NULL::uuid;
  ELSE
    RETURN QUERY SELECT v_inv.id, true, 'valid'::text, v_inv.trip_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_invitation_code(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_invitation_preview: same column list / filters as 20260707130000,
-- now plpgsql (was SQL/STABLE) so it can log failed probes and share the
-- lockout. Locked-out codes yield zero rows -- exactly like an unknown,
-- used, expired, or tripless code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_invitation_preview(p_code text)
RETURNS TABLE (
  trip_name text,
  location text,
  start_date date,
  end_date date,
  accent_seed text,
  estimated_cost numeric,
  cost_currency text,
  confirmed_count int,
  organizer_first_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.invitation_code_locked_out(p_code) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.name                                   AS trip_name,
    t.location                               AS location,
    t.start_date                             AS start_date,
    t.end_date                               AS end_date,
    t.id::text                               AS accent_seed,
    t.estimated_accommodation_cost::numeric  AS estimated_cost,
    t.accommodation_cost_currency            AS cost_currency,
    (
      SELECT count(*)::int
      FROM public.trip_participants tp
      WHERE tp.trip_id = t.id
        AND tp.confirmation_status = 'confirmed'
    )                                        AS confirmed_count,
    COALESCE(u.first_name, split_part(u.full_name, ' ', 1)) AS organizer_first_name
  FROM public.invitations i
  JOIN public.trips t ON t.id = i.trip_id
  LEFT JOIN public.users u ON u.id = t.created_by
  WHERE i.code = upper(p_code)
    AND i.used_by IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now())
    AND i.trip_id IS NOT NULL;

  IF NOT FOUND THEN
    PERFORM public.log_invitation_probe(p_code, false, 'get_invitation_preview');
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invitation_preview(text) TO anon, authenticated;
