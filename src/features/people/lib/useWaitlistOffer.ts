import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
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
 */
export function useOfferWaitlistSpot(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, hours }: { userId: string; hours?: number }) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ waitlist_offer_expires_at: computeOfferExpiry(Date.now(), hours) })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) }),
  })
}

/** Clear an offer (expired-and-cascaded, or claimed) without changing status. */
export function useClearWaitlistOffer(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ waitlist_offer_expires_at: null })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) }),
  })
}
