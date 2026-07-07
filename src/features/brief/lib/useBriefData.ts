import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useBookings } from '../../../lib/queries/useBookings'
import { useSettlements } from '../../../lib/queries/useSettlements'
import { computeCostBand } from './costBand'
import { buildAutoFaq } from './autoFaq'
import type { CostBand } from './costBand'
import type { FaqEntry } from './autoFaq'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface BriefData {
  trip: Trip | null
  participants: ParticipantWithUser[]
  myParticipant: ParticipantWithUser | null
  confirmedCount: number
  costBand: CostBand | null
  faqEntries: FaqEntry[]
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
  const { data: places } = usePlaces(tripId)
  const { data: bookings } = useBookings(tripId)
  const { data: settlements } = useSettlements(tripId)

  const myParticipant = participants.find((p) => p.user_id === user?.id) ?? null
  const confirmedCount = participants.filter((p) => p.confirmation_status === 'confirmed').length

  const costBand = useMemo(() => {
    if (!trip || !sections) return null
    return computeCostBand(trip, sections, votes || [], confirmedCount, user?.id ?? null)
  }, [trip, sections, votes, confirmedCount, user?.id])

  const hasUnpaidBalance = (settlements || []).some(
    (s) => (s.from_user_id === user?.id || s.to_user_id === user?.id) && s.status !== 'confirmed'
  )

  const faqEntries = useMemo(() => {
    if (!trip) return []
    return buildAutoFaq(trip, places || [], bookings || [], costBand, hasUnpaidBalance)
  }, [trip, places, bookings, costBand, hasUnpaidBalance])

  return {
    trip,
    participants,
    myParticipant,
    confirmedCount,
    costBand,
    faqEntries,
    isLoading: tripLoading || participantsLoading,
  }
}
