import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useBookings } from '../../../lib/queries/useBookings'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useQuestionPasses, useSections, useVotes, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { Trip } from '../../../types'
import { groupQuestions, type QuestionGroups } from './questionsModel'

export interface UseQuestionListResult {
  sections: SectionWithOptions[]
  groups: QuestionGroups<SectionWithOptions>
  /** Option ids with a live booking (QuestionCard's Booked state). */
  bookedOptionIds: ReadonlySet<string>
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

/** Feeds Plan's Questions lens and its default-lens choice from the shared query cache. */
export function useQuestionList(trip: Trip): UseQuestionListResult {
  const { user } = useAuth()
  const { canManageTrip } = useTripPermissions(trip)
  const sectionsQuery = useSections(trip.id)
  const votesQuery = useVotes(trip.id)
  const participantsQuery = useParticipants(trip.id)
  const bookingsQuery = useBookings(trip.id)
  const passesQuery = useQuestionPasses(trip.id)

  const sections = useMemo(() => sectionsQuery.data ?? [], [sectionsQuery.data])
  const votes = votesQuery.data
  const participants = participantsQuery.data
  const bookings = bookingsQuery.data

  const bookedOptionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const b of bookings ?? []) if (b.option_id && b.status !== 'cancelled') ids.add(b.option_id)
    return ids as ReadonlySet<string>
  }, [bookings])

  const passes = passesQuery.available ? passesQuery.passes : undefined
  const userId = user?.id ?? null

  const groups = useMemo(
    () =>
      groupQuestions({
        sections,
        userId,
        votes: votes ?? [],
        passes,
        participants: participants ?? [],
        trip,
        bookedOptionIds,
        canManage: canManageTrip,
      }),
    [sections, userId, votes, passes, participants, trip, bookedOptionIds, canManageTrip]
  )

  return {
    sections,
    groups,
    bookedOptionIds,
    isLoading: sectionsQuery.isLoading || votesQuery.isLoading || participantsQuery.isLoading,
    isError: sectionsQuery.isError || votesQuery.isError || participantsQuery.isError,
    refetch: () => {
      sectionsQuery.refetch()
      votesQuery.refetch()
      participantsQuery.refetch()
    },
  }
}
