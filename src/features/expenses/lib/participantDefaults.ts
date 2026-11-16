/**
 * Default "who was there?" tagging for a new expense (participant_ids).
 * Drives auto-chase targeting for unclaimed items, so getting the default
 * WRONG means chasing people who haven't even confirmed they're coming.
 * Delegates to the shared in-scope rule (features/people/lib/inScopePeople)
 * so expense defaults, booking splits, cost per person and vote counts
 * agree: confirmed people when anyone has confirmed, else everyone except
 * declined/cancelled; every active participant when RSVP tracking is off.
 * `confirmationEnabled` defaults to true (the historical behaviour) for
 * callers that don't know the trip setting.
 */
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { inScopePeople } from '../../people/lib/inScopePeople'

export function defaultTaggedParticipants(
  participants: ParticipantWithUser[],
  confirmationEnabled = true
): ParticipantWithUser[] {
  return inScopePeople(participants, confirmationEnabled)
}

export function defaultTaggedParticipantIds(participants: ParticipantWithUser[], confirmationEnabled = true): string[] {
  return defaultTaggedParticipants(participants, confirmationEnabled).map((p) => p.user_id)
}
