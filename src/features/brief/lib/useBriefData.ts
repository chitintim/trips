import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { inScopeHeadcount } from '../../people/lib/inScopePeople'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import { computeCostBand } from './costBand'
import type { CostBand } from './costBand'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface BriefData {
  trip: Trip | null
  participants: ParticipantWithUser[]
  myParticipant: ParticipantWithUser | null
  confirmedCount: number
  costBand: CostBand | null
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
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)

  const myParticipant = participants.find((p) => p.user_id === user?.id) ?? null
  const confirmedCount = participants.filter((p) => p.confirmation_status === 'confirmed').length
  // Cost maths use the in-scope headcount (all active people when RSVP tracking is off), not the raw confirmed count.
  const headcount = useMemo(() => inScopeHeadcount(participants, isConfirmationEnabled(trip)), [participants, trip])

  const costBand = useMemo(() => {
    if (!trip || !sections) return null
    return computeCostBand(trip, sections, votes || [], headcount, user?.id ?? null)
  }, [trip, sections, votes, headcount, user?.id])

  return {
    trip,
    participants,
    myParticipant,
    confirmedCount,
    costBand,
    isLoading: tripLoading || participantsLoading,
  }
}
