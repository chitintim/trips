import { isConfirmationEnabled } from '../../../lib/tripStatus'

export interface ConfirmedLabelTrip {
  confirmation_enabled: boolean | null
  confirmed_count: number
  participant_count: number
}

/**
 * TripCard's confirmed line. With confirmation tracking ON it's the real
 * confirmed-status count, unchanged. With tracking OFF the stored statuses
 * are meaningless (mostly 'pending'), so everyone on the active roster
 * counts as confirmed — shown as "N/N confirmed".
 */
export function confirmedCountLabel(trip: ConfirmedLabelTrip): string {
  if (isConfirmationEnabled(trip)) return `${trip.confirmed_count} confirmed`
  return `${trip.participant_count}/${trip.participant_count} confirmed`
}
