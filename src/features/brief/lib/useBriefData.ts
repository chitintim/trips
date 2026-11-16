import { useAuth } from '../../../hooks/useAuth'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface BriefData {
  trip: Trip | null
  participants: ParticipantWithUser[]
  myParticipant: ParticipantWithUser | null
  confirmedCount: number
  isLoading: boolean
}

/**
 * Everything the brief sections need, in one hook (extracted from the old
 * monolithic TripBrief so Today's stage layouts can compose the same data).
 * Reads only already-keyed TanStack queries — cache is shared with the tabs.
 */
export function useBriefData(tripId: string): BriefData {
  const { user } = useAuth()
  const { data: trip = null, isLoading: tripLoading } = useTrip(tripId)
  const { data: participants = [], isLoading: participantsLoading } = useParticipants(tripId)

  const myParticipant = participants.find((p) => p.user_id === user?.id) ?? null
  const confirmedCount = participants.filter((p) => p.confirmation_status === 'confirmed').length
  return {
    trip,
    participants,
    myParticipant,
    confirmedCount,
    isLoading: tripLoading || participantsLoading,
  }
}
