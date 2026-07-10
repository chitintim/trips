import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useOptimisticMutation } from '../../../lib/queries/makeOptimisticMutation'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { computeOfferExpiry } from './waitlist'

/**
 * Organizer action: offer a freed spot to a waitlisted participant, with an
 * expiry window (default 48h per plan §14). Writes
 * trip_participants.waitlist_offer_expires_at — added in
 * supabase/migrations/20260707090000_waitlist_offers.sql (workstream C).
 *
 * This only sets the offer window; it does not send the notification
 * email (the auto-chase edge function's job) and does not change
 * confirmation_status — claiming the offer is a normal status update to
 * 'confirmed' via useUpdateConfirmationStatus, which the capacity trigger
 * will honor since a spot is now actually free.
 *
 * Optimistic against the participants cache (mirroring
 * useUpdateConfirmationStatus in useConfirmations.ts) -- the offer/withdraw
 * buttons in WaitlistPanel should react instantly, same as every other RSVP
 * affordance, rather than waiting a round trip.
 */
export function useOfferWaitlistSpot(tripId: string) {
  return useOptimisticMutation<void, { userId: string; hours?: number }, ParticipantWithUser[]>({
    mutationFn: async ({ userId, hours }) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ waitlist_offer_expires_at: computeOfferExpiry(Date.now(), hours) })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    queryKey: () => queryKeys.participants(tripId),
    updater: (participants, { userId, hours }) => {
      if (!participants) return participants as unknown as ParticipantWithUser[]
      const expiresAt = computeOfferExpiry(Date.now(), hours)
      return participants.map((p) => (p.user_id === userId ? { ...p, waitlist_offer_expires_at: expiresAt } : p))
    },
  })
}

/** Clear an offer (expired-and-cascaded, or claimed) without changing status. */
export function useClearWaitlistOffer(tripId: string) {
  return useOptimisticMutation<void, string, ParticipantWithUser[]>({
    mutationFn: async (userId) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ waitlist_offer_expires_at: null })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    queryKey: () => queryKeys.participants(tripId),
    updater: (participants, userId) => {
      if (!participants) return participants as unknown as ParticipantWithUser[]
      return participants.map((p) => (p.user_id === userId ? { ...p, waitlist_offer_expires_at: null } : p))
    },
  })
}
