-- ---------------------------------------------------------------------------
-- Invitation preview for the public /join/:code teaser page (UX_REDESIGN.md
-- Part 2 "Invite → join funnel"). Additive only.
--
-- Pattern mirrors validate_invitation_code (20260707110000_security_hardening
-- §3): invitations are NOT directly readable pre-auth, so the teaser goes
-- through a narrow SECURITY DEFINER RPC that returns a fixed, non-sensitive
-- column list — and ONLY for codes that are valid, unused and unexpired AND
-- tied to a trip. Invalid/used/expired/tripless codes return zero rows, so
-- the endpoint can't be used to probe which codes exist beyond the same
-- yes/no signal validate_invitation_code already exposes.
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.get_invitation_preview(text) TO anon, authenticated;
