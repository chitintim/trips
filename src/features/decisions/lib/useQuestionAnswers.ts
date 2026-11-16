import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { useQuestionPasses, useVotes, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import { getMyTravelEvents } from '../../people/lib/travelDetails'
import { inScopeHeadcount, type InScopeHeadcount } from '../../people/lib/inScopePeople'
import { buildAnswerControlModel, buildModelViewer, type AnswerControlModel, type ModelViewer } from './answerModel'
import { buildQuestionCardModel, type QuestionCardModel } from './questionCardModel'
import type { Trip } from '../../../types'

export interface UseQuestionAnswersOptions {
  /** Treat the question as closed regardless of its stored status (Decided / Booked cards). */
  closed?: boolean
  /** Booked option ids (live `bookings` rows) for the card's Booked state. */
  bookedOptionIds?: ReadonlySet<string>
}

export interface QuestionAnswersData {
  control: AnswerControlModel
  card: QuestionCardModel
  /** True once the passes query has succeeded (the pass button shows only then). */
  passesAvailable: boolean
  headcount: InScopeHeadcount
  viewer: ModelViewer
  /** Active participants with their user rows (for names and avatars). */
  participants: ReturnType<typeof useParticipants>['data']
}

/**
 * Reads everything the answer control and question card need from the query
 * cache (votes, passes, participants, timeline) and runs the pure models.
 * Mount-cheap: all of these queries are already mounted by the trip screens.
 */
export function useQuestionAnswers(trip: Trip, section: SectionWithOptions, options: UseQuestionAnswersOptions = {}): QuestionAnswersData {
  const { user } = useAuth()
  const votesQuery = useVotes(trip.id)
  const passesQuery = useQuestionPasses(trip.id)
  const participantsQuery = useParticipants(trip.id)
  const timelineQuery = useTimeline(trip.id)

  const userId = user?.id ?? null
  const participants = participantsQuery.data
  const votes = votesQuery.data
  const passes = passesQuery.passes
  const passesAvailable = passesQuery.available
  const events = timelineQuery.data

  const effectiveSection = useMemo(() => (options.closed && section.status !== 'completed' ? { ...section, status: 'completed' as const } : section), [section, options.closed])

  return useMemo(() => {
    const people = participants ?? []
    const viewer: ModelViewer = buildModelViewer(userId, people, trip)

    const travel = getMyTravelEvents(events ?? [], userId ?? undefined)
    const defaultDates = {
      start: travel.arrival?.event_date || trip.start_date,
      end: travel.departure?.event_date || trip.end_date,
    }

    const control = buildAnswerControlModel({
      section: effectiveSection,
      viewer,
      votes: votes ?? [],
      passes: passesAvailable ? passes : undefined,
      defaultDates,
      fallbackCurrency: trip.base_currency || 'GBP',
    })
    const card = buildQuestionCardModel({
      section: effectiveSection,
      userId,
      votes: votes ?? [],
      passes: passesAvailable ? passes : undefined,
      participants: people,
      trip,
      bookedOptionIds: options.bookedOptionIds,
    })
    const headcount = inScopeHeadcount(people, isConfirmationEnabled(trip))
    return { control, card, passesAvailable, headcount, viewer, participants }
  }, [effectiveSection, userId, votes, passes, passesAvailable, participants, events, trip, options.bookedOptionIds])
}
