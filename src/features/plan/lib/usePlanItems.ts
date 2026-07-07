import { useMemo } from 'react'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useBookings } from '../../../lib/queries/useBookings'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useAuth } from '../../../hooks/useAuth'
import { composePlanItems, type PlanItem } from './planItems'
import type { Booking } from '../../../lib/queries/useBookings'

export interface UsePlanItemsResult {
  items: PlanItem[]
  unlinkedBookings: Booking[]
  isLoading: boolean
}

/**
 * Thin wrapper (plan §2 "under the hood"): fetches timeline events,
 * sections/options/votes, bookings, and confirmed-participant count, then
 * hands them to the pure `composePlanItems` function. All composition
 * logic lives in planItems.ts so it's independently unit-testable — this
 * hook only wires up React Query + useMemo.
 */
export function usePlanItems(tripId: string | undefined): UsePlanItemsResult {
  const { user } = useAuth()
  const { data: events, isLoading: eventsLoading } = useTimeline(tripId)
  const { data: sections, isLoading: sectionsLoading } = useSections(tripId)
  const { data: votes, isLoading: votesLoading } = useVotes(tripId)
  const { data: bookings, isLoading: bookingsLoading } = useBookings(tripId)
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)

  const confirmedCount = useMemo(
    () => (participants || []).filter((p) => p.confirmation_status === 'confirmed').length,
    [participants]
  )

  const result = useMemo(
    () =>
      composePlanItems({
        events: events || [],
        sections: sections || [],
        votes: votes || [],
        bookings: bookings || [],
        confirmedCount,
        currentUserId: user?.id ?? null,
      }),
    [events, sections, votes, bookings, confirmedCount, user?.id]
  )

  return {
    items: result.items,
    unlinkedBookings: result.unlinkedBookings,
    isLoading: eventsLoading || sectionsLoading || votesLoading || bookingsLoading || participantsLoading,
  }
}
