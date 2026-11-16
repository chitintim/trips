import { isConfirmationEnabled } from '../../../lib/tripStatus'

export interface ConfirmedLabelTrip {
  confirmation_enabled: boolean | null
  confirmed_count: number
  participant_count: number
}

/**
 * TripCard's going line. With confirmation tracking ON it's the real
 * confirmed-status count, unchanged. With tracking OFF the stored statuses
 * are meaningless (mostly 'pending'), so everyone on the active roster
 * counts as going — shown as "N/N going".
 */
export function confirmedCountLabel(trip: ConfirmedLabelTrip): string {
  if (isConfirmationEnabled(trip)) return `${trip.confirmed_count} going`
  return `${trip.participant_count}/${trip.participant_count} going`
}
