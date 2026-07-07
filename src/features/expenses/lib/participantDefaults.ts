/**
 * Default "who was there?" tagging for a new expense (participant_ids).
 * Drives auto-chase targeting for unclaimed items, so getting the default
 * WRONG means chasing people who haven't even confirmed they're coming.
 * Defaults to participants with confirmation_status='confirmed'; falls
 * back to every active participant only when nobody has confirmed yet
 * (e.g. a brand-new trip with no RSVPs) so the expense form never starts
 * with zero people tagged.
 */
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export function defaultTaggedParticipants(participants: ParticipantWithUser[]): ParticipantWithUser[] {
  const confirmed = participants.filter((p) => p.confirmation_status === 'confirmed')
  return confirmed.length > 0 ? confirmed : participants
}

export function defaultTaggedParticipantIds(participants: ParticipantWithUser[]): string[] {
  return defaultTaggedParticipants(participants).map((p) => p.user_id)
}
