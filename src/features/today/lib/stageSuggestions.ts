import { tripStageRank } from '../../../lib/tripStage'
import type { TripStatus } from '../../../types'
import type { RsvpStanding } from '../../people/lib/rsvpStanding'

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
  /** Every active participant's "Are you coming?" standing (see rsvpStanding). */
  standings: RsvpStanding[]
  /** Count of non-cancelled bookings recorded. */
  bookingCount: number
}

export function computeStageSuggestion(input: StageSuggestionInput): StageSuggestion | null {
  const { storedStatus, effectiveStage, confirmationEnabled, standings, bookingCount } = input

  // Date-driven sync first: if the dates already carried us into
  // ongoing/completed, the only useful action is syncing the stored value.
  if (tripStageRank(effectiveStage) > tripStageRank(storedStatus)) {
    if (effectiveStage === 'trip_ongoing' && storedStatus !== 'trip_ongoing') {
      return {
        key: `sync-${storedStatus}-trip_ongoing`,
        to: 'trip_ongoing',
        title: 'Tidy up: save the trip as ongoing',
        detail: 'The trip is already shown as under way because its dates have started. This just updates the saved status to match.',
        kind: 'sync',
      }
    }
    if (effectiveStage === 'trip_completed') {
      return {
        key: `sync-${storedStatus}-trip_completed`,
        to: 'trip_completed',
        title: 'Tidy up: save the trip as completed',
        detail: 'The trip is already shown as finished because its dates have passed. This just updates the saved status to match.',
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
    if (!confirmationEnabled) {
      // Tracking is off, so there is no "Are you coming?" rule to apply: judge by the stored answers, as before.
      const statuses = standings.map((s) => s.status)
      const undecided = statuses.filter((s) => s !== 'confirmed' && s !== 'declined')
      if (undecided.length === 0 && statuses.some((s) => s === 'confirmed')) {
        return {
          key: 'advance-confirming_participants-booking_details',
          to: 'booking_details',
          title: 'Everyone has answered — move to booking',
          detail: 'Everyone who is still in is going. Time to decide and book the details.',
          kind: 'advance',
        }
      }
    } else {
      // Nobody still owes an answer that matters: lapsed maybes (trip full or
      // replies closed), late replies, declined/cancelled people and plain
      // waitlisters don't hold the trip back. A live waitlist offer does, and
      // so does a freed place that is held for the waitlist: the trip is not
      // settled until that place is taken or released.
      const blocked = standings.some((s) => s.blocksBooking || s.placeHeld)
      const going = standings.filter((s) => s.kind === 'going').length
      if (!blocked && going > 0) {
        const noPlace = standings.filter((s) => s.kind === 'no_place').length
        return {
          key: 'advance-confirming_participants-booking_details',
          to: 'booking_details',
          title: 'Everyone has answered — move to booking',
          detail:
            noPlace > 0
              ? `Everyone with a place has answered. ${noPlace} not sure or not replied, but the trip is full.`
              : 'Everyone who is still in is going. Time to decide and book the details.',
          kind: 'advance',
        }
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
