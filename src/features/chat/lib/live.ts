import { useMemo } from 'react'
import { type QueryClient } from '@tanstack/react-query'
import { isTripFinished } from '../../../lib/answers/answers'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useActions, useTodoWhoSupport, type ActionWithCompletions } from '../../../lib/queries/useActions'
import { useChecklists, type ChecklistItem } from '../../../lib/queries/useChecklists'
import { questionPassesKey, useQuestionPasses, useSections, useVotes, type OptionVoteWithUser, type QuestionPass, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import { useParticipants, useTrip, type ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'
import type { LiveData } from '../actions/types'

interface Inputs {
  userId: string
  trip: Trip
  canManage: boolean
  participants: ParticipantWithUser[] | undefined
  sections: SectionWithOptions[] | undefined
  votes: OptionVoteWithUser[] | undefined
  passes: QuestionPass[] | undefined
  actions: ActionWithCompletions[] | undefined
  checklists: ChecklistItem[] | undefined
  todoWho: boolean
}

/** The person's full name as the trip knows them (cards disambiguate and never shorten it; see `personName`). */
export function fullName(p: ParticipantWithUser): string {
  return (p.user?.full_name || p.user?.email?.split('@')[0] || 'Someone').trim()
}

/** Builds the view of the app's own data the cards use. Pure. */
export function buildLive(i: Inputs): LiveData {
  return {
    userId: i.userId,
    tripId: i.trip.id,
    frozen: !!i.trip.settlement_snapshot,
    finished: isTripFinished(i.trip),
    baseCurrency: i.trip.base_currency,
    canManage: i.canManage,
    todoWho: i.todoWho,
    roster: (i.participants ?? []).map((p) => ({ user_id: p.user_id, name: fullName(p), active: p.active !== false, confirmation_status: p.confirmation_status ?? null })),
    sections: i.sections ?? [],
    votes: i.votes ?? [],
    passes: i.passes,
    actions: i.actions ?? [],
    checklists: i.checklists ?? [],
  }
}

/** Live data for rendering: subscribes to the same caches the screens use, so a card re-checks itself as the data changes. */
export function useChatLive(trip: Trip, userId: string | undefined, canManage: boolean, enabled: boolean): LiveData | null {
  const id = enabled ? trip.id : undefined
  const { data: tripData } = useTrip(id)
  const { data: participants } = useParticipants(id)
  const { data: sections } = useSections(id)
  const { data: votes } = useVotes(id)
  const passesResult = useQuestionPasses(id)
  const { data: actions } = useActions(id)
  const { data: checklists } = useChecklists(id)
  const todoWho = useTodoWhoSupport()
  return useMemo(
    () =>
      userId
        ? buildLive({
            userId,
            trip: tripData ?? trip,
            canManage,
            participants,
            sections,
            votes,
            passes: passesResult.available ? passesResult.passes : undefined,
            actions,
            checklists,
            todoWho,
          })
        : null,
    [userId, tripData, trip, canManage, participants, sections, votes, passesResult.available, passesResult.passes, actions, checklists, todoWho]
  )
}

/** The same view read straight from the query cache (after a refetch), for the moment of confirming. */
export function readLive(queryClient: QueryClient, trip: Trip, userId: string, canManage: boolean): LiveData {
  const t = trip.id
  const passesState = queryClient.getQueryState(questionPassesKey(t))
  return buildLive({
    userId,
    trip: queryClient.getQueryData<Trip>(queryKeys.tripDetail(t)) ?? trip,
    canManage,
    participants: queryClient.getQueryData<ParticipantWithUser[]>(queryKeys.participants(t)),
    sections: queryClient.getQueryData<SectionWithOptions[]>(queryKeys.sections(t)),
    votes: queryClient.getQueryData<OptionVoteWithUser[]>(queryKeys.votes(t)),
    passes: passesState?.status === 'success' ? queryClient.getQueryData<QuestionPass[]>(questionPassesKey(t)) ?? [] : undefined,
    actions: queryClient.getQueryData<ActionWithCompletions[]>(queryKeys.actions(t)),
    checklists: queryClient.getQueryData<ChecklistItem[]>(queryKeys.checklists(t)),
    todoWho: queryClient.getQueryData<boolean>(['todoWhoSupport']) === true,
  })
}

/** Refetch what the cards read, so a suggestion is checked (and an answer planned) against the true state. */
export async function refreshLive(queryClient: QueryClient, tripId: string): Promise<void> {
  await Promise.all(
    [queryKeys.tripDetail(tripId), queryKeys.participants(tripId), queryKeys.sections(tripId), queryKeys.votes(tripId), questionPassesKey(tripId), queryKeys.actions(tripId), queryKeys.checklists(tripId)].map((queryKey) =>
      queryClient.refetchQueries({ queryKey, exact: true }).catch(() => undefined)
    )
  )
}

