import { tripStageRank } from '../../../lib/tripStage'
import type { TripStatus } from '../../../types'

/**
 * Stage-advance SUGGESTION cards (UX_REDESIGN.md "Trip status: derived,
 * suggested, never nagging"): organizers see a one-tap card when the trip's
 * facts imply the stored status is behind. Applying updates the stored
 * status; the effective stage already drives UX, so these only keep the
 * stored value honest (chaser, queries). Pure — unit-testable.
 */

export interface StageSuggestion {
  /** Dismissal key, stable per from→to pair. */
  key: string
  to: TripStatus
  title: string
  detail: string
  /** Date-driven "sync" suggestions are lower-key than milestone advances. */
  kind: 'advance' | 'sync'
}

export interface StageSuggestionInput {
  storedStatus: TripStatus
  effectiveStage: TripStatus
  confirmationEnabled: boolean
  /** Active participants' confirmation statuses. */
  participantStatuses: string[]
  /** Count of non-cancelled bookings recorded. */
  bookingCount: number
}

export function computeStageSuggestion(input: StageSuggestionInput): StageSuggestion | null {
  const { storedStatus, effectiveStage, confirmationEnabled, participantStatuses, bookingCount } = input

  // Date-driven sync first: if the dates already carried us into
  // ongoing/completed, the only useful action is syncing the stored value.
  if (tripStageRank(effectiveStage) > tripStageRank(storedStatus)) {
    if (effectiveStage === 'trip_ongoing' && storedStatus !== 'trip_ongoing') {
      return {
        key: `sync-${storedStatus}-trip_ongoing`,
        to: 'trip_ongoing',
        title: 'Mark the trip as ongoing',
        detail: 'The trip dates have started — updating the status keeps reminders and the dashboard accurate.',
        kind: 'sync',
      }
    }
    if (effectiveStage === 'trip_completed') {
      return {
        key: `sync-${storedStatus}-trip_completed`,
        to: 'trip_completed',
        title: 'Mark the trip as completed',
        detail: 'The trip dates have passed — marking it completed unlocks the recap and settle-up flow everywhere.',
        kind: 'sync',
      }
    }
  }

  // Milestone advances (stored-status driven).
  if (storedStatus === 'gathering_interest' && confirmationEnabled) {
    return {
      key: 'advance-gathering_interest-confirming_participants',
      to: 'confirming_participants',
      title: 'Start confirming participants',
      detail: 'RSVPs are enabled — move to "confirming participants" so the group knows commitments are being collected.',
      kind: 'advance',
    }
  }

  if (storedStatus === 'confirming_participants') {
    const undecided = participantStatuses.filter(
      (s) => s !== 'confirmed' && s !== 'declined'
    )
    const confirmed = participantStatuses.filter((s) => s === 'confirmed')
    if (undecided.length === 0 && confirmed.length > 0) {
      return {
        key: 'advance-confirming_participants-booking_details',
        to: 'booking_details',
        title: 'Everyone has answered — move to booking',
        detail: 'All non-declined participants are confirmed. Time to decide and book the details.',
        kind: 'advance',
      }
    }
  }

  if (storedStatus === 'booking_details' && bookingCount > 0) {
    return {
      key: 'advance-booking_details-booked_awaiting_departure',
      to: 'booked_awaiting_departure',
      title: 'First booking recorded — mark as booked',
      detail: 'A booking is on the tracker. Moving to "awaiting departure" switches everyone to countdown mode.',
      kind: 'advance',
    }
  }

  return null
}
