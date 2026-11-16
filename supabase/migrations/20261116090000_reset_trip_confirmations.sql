-- Explicit "reset participation confirmations" for a trip.
--
-- Why: confirmation is two independent pieces of state -- the trip-level
-- switch (trips.confirmation_enabled + message/deadline/cost) and one
-- per-person row state (trip_participants.confirmation_status / _note /
-- confirmed_at / conditional_* / waitlist_offer_expires_at). Toggling the
-- switch off and on only touches the trips row, so a failed booking (Japan
-- ski trip) left everyone "confirmed" for a booking that no longer existed.
--
-- This RPC wipes the per-person round so a new one starts clean:
--   * active participants whose status is confirmed / interested /
--     conditional / waitlist (and, optionally, declined) go back to
--     'pending', with note, confirmed_at, conditional_* and any waitlist
--     offer cleared. 'cancelled' (they left) and inactive (removed) rows
--     are never touched.
--   * the chase throttle history for the RSVP kinds (pending_rsvp,
--     conditional_date_arrived, waitlist_offer) is cleared for the trip
--     (except rows from today UTC, which keep the daily digest cap intact),
--     because auto-chase caps reminders per (user, kind, trip) over all
--     time (max_reminders): without this, people who were reminded in the
--     first round would never be reminded in the second.
--   * one activity_feed row records who reset how many (the audit trail).
-- It sends no email itself. Reminders for the new round come only from the
-- normal daily auto-chase digest (<=1 email/user/day), and only when the
-- trip has a confirmation_deadline within 72h. trips.confirmation_* settings
-- are left as they are (organiser keeps control of message/deadline).
--
-- Triggers on trip_participants (enforce_capacity_limit,
-- notify_conditional_users) only act on a transition TO 'confirmed', so a
-- bulk move to 'pending' does not trip them.
--
-- Authorization is enforced here, not just in the UI: the trip's creator, a
-- trip organizer, or a site admin. SECURITY DEFINER is needed because the
-- participants' rows are not writable by the organizer under RLS and
-- notifications has no user write policy.

CREATE OR REPLACE FUNCTION public.reset_trip_confirmations(
  p_trip_id uuid,
  p_include_declined boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_statuses public.confirmation_status[] := ARRAY[
    'confirmed', 'interested', 'conditional', 'waitlist'
  ]::public.confirmation_status[];
  v_cleared integer;
  v_notifications_cleared integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.is_admin(v_uid)
    -- Inline (not is_trip_organizer(), whose live body is unverified) so that
    -- removed/inactive organisers are excluded.
    OR EXISTS (
      SELECT 1 FROM public.trip_participants o
      WHERE o.trip_id = p_trip_id AND o.user_id = v_uid
        AND o.role = 'organizer'::public.participant_role AND o.active
    )
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.created_by = v_uid)
  ) THEN
    RAISE EXCEPTION 'Only trip organizers and admins can reset confirmations'
      USING ERRCODE = '42501';
  END IF;

  IF p_include_declined THEN
    v_statuses := v_statuses || 'declined'::public.confirmation_status;
  END IF;

  UPDATE public.trip_participants
  SET confirmation_status = 'pending',
      confirmation_note = NULL,
      confirmed_at = NULL,
      conditional_type = 'none',
      conditional_date = NULL,
      conditional_user_ids = NULL,
      waitlist_offer_expires_at = NULL,
      updated_at = now()
  WHERE trip_id = p_trip_id
    AND active
    AND confirmation_status = ANY (v_statuses);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  DELETE FROM public.notifications
  WHERE trip_id = p_trip_id
    AND kind IN ('pending_rsvp', 'conditional_date_arrived', 'waitlist_offer')
    -- Keep today's (UTC) rows: auto-chase's one-digest-per-user-per-day cap
    -- counts them, so wiping them would let a second run today email again.
    -- (notifications.sent_at is NOT NULL timestamptz, so no NULL handling.)
    AND sent_at < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
  GET DIAGNOSTICS v_notifications_cleared = ROW_COUNT;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    p_trip_id,
    v_uid,
    'confirmations_reset',
    jsonb_build_object(
      'type', 'confirmation',
      'label', v_cleared || CASE WHEN v_cleared = 1 THEN ' confirmation' ELSE ' confirmations' END
    ),
    jsonb_build_object(
      'cleared', v_cleared,
      'include_declined', p_include_declined,
      'reminder_history_cleared', v_notifications_cleared
    )
  );

  RETURN jsonb_build_object(
    'cleared', v_cleared,
    'reminder_history_cleared', v_notifications_cleared
  );
END;
$$;

COMMENT ON FUNCTION public.reset_trip_confirmations(uuid, boolean) IS
  'Organizer/admin-only (checked inside): returns active participants of a trip to pending (clearing note, confirmed_at, conditional_* and waitlist offers), clears RSVP chase throttle history, and logs a confirmations_reset activity row. Starts a clean confirmation round. Never emails.';

REVOKE ALL ON FUNCTION public.reset_trip_confirmations(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_trip_confirmations(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.reset_trip_confirmations(uuid, boolean) TO authenticated;
