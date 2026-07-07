-- Security fix (QA/hardening pass, see SECURITY_AUDIT.md): the
-- get_recent_failed_attempts() function is SECURITY DEFINER (runs as the
-- table owner, bypasses RLS) and returns invitation_attempts data
-- (code_attempted, ip_addresses, attempt counts) that the table's own RLS
-- restricts to admins only ("Admins can view all invitation attempts").
-- However the function had EXECUTE granted to anon/authenticated with no
-- internal role check, so any signed-in user -- or any caller of the
-- public REST RPC endpoint holding just the anon key -- could call it
-- directly and read admin-only security-monitoring data, bypassing RLS
-- entirely.
--
-- Fix: add the same internal admin check used by create_invitation() and
-- other admin-only SECURITY DEFINER functions, and tighten the grant to
-- authenticated only (the function itself still enforces admin-only
-- access, so this is defense-in-depth, not the sole control).
--
-- ADDITIVE ONLY: replaces the function body and grants; no data touched.

CREATE OR REPLACE FUNCTION "public"."get_recent_failed_attempts"("hours_back" integer DEFAULT 24) RETURNS TABLE("code_attempted" "text", "attempt_count" bigint, "last_attempt" timestamp with time zone, "ip_addresses" "text"[])
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  SELECT role = 'admin' INTO v_is_admin
  FROM public.users
  WHERE id = auth.uid();

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Only admins can view invitation attempt monitoring data';
  END IF;

  RETURN QUERY
  SELECT
    ia.code_attempted,
    COUNT(*) AS attempt_count,
    MAX(ia.created_at) AS last_attempt,
    ARRAY_AGG(DISTINCT ia.ip_address::text) AS ip_addresses
  FROM public.invitation_attempts ia
  WHERE ia.created_at > now() - (hours_back || ' hours')::interval
    AND ia.success = false
  GROUP BY ia.code_attempted
  HAVING COUNT(*) > 2
  ORDER BY attempt_count DESC, last_attempt DESC;
END;
$$;

COMMENT ON FUNCTION "public"."get_recent_failed_attempts"("hours_back" integer) IS 'Returns suspicious invitation validation patterns for admin monitoring. Admin-only: raises if the caller is not an admin (defense-in-depth; previously relied solely on the grant, which was too broad).';

REVOKE ALL ON FUNCTION "public"."get_recent_failed_attempts"("hours_back" integer) FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_recent_failed_attempts"("hours_back" integer) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_recent_failed_attempts"("hours_back" integer) TO "authenticated";
