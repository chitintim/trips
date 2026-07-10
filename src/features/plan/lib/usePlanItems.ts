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
  /** True when any of the five underlying queries failed (UPGRADE_MASTER_PLAN.md audit item 2: previously only isLoading was surfaced, so a network failure silently rendered as "nothing on the plan yet"). */
  isError: boolean
  /** Re-fires every underlying query — for a caller's "Retry" action on the error branch. */
  refetch: () => void
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
  const eventsQuery = useTimeline(tripId)
  const sectionsQuery = useSections(tripId)
  const votesQuery = useVotes(tripId)
  const bookingsQuery = useBookings(tripId)
  const participantsQuery = useParticipants(tripId)

  const { data: events, isLoading: eventsLoading, isError: eventsError } = eventsQuery
  const { data: sections, isLoading: sectionsLoading, isError: sectionsError } = sectionsQuery
  const { data: votes, isLoading: votesLoading, isError: votesError } = votesQuery
  const { data: bookings, isLoading: bookingsLoading, isError: bookingsError } = bookingsQuery
  const { data: participants, isLoading: participantsLoading, isError: participantsError } = participantsQuery

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
    isError: eventsError || sectionsError || votesError || bookingsError || participantsError,
    refetch: () => {
      eventsQuery.refetch()
      sectionsQuery.refetch()
      votesQuery.refetch()
      bookingsQuery.refetch()
      participantsQuery.refetch()
    },
  }
}
