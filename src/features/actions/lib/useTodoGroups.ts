import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useActions, useSectionVoters } from '../../../lib/queries/useActions'
import { useSections } from '../../../lib/queries/usePlanning'
import { useChecklists } from '../../../lib/queries/useChecklists'
import { isTripFinished } from '../../../lib/answers/answers'
import { countsTowardActions } from './actionStatus'
import { buildTodoViews, groupTodos } from './todoModel'

/**
 * The To-dos sheet's grouped model (Yours / Everyone / With others / Up for
 * grabs / Done), built once so the sheet and Today's "All to-dos (N open)"
 * footer can never disagree about what is on the list.
 */
export function useTodoGroups(tripId: string) {
  const { user } = useAuth()
  const { data: trip } = useTrip(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: actions, isLoading: actionsLoading, isError: actionsError } = useActions(tripId)
  const { data: checklists, isLoading: checklistsLoading, isError: checklistsError } = useChecklists(tripId)
  const { data: sections } = useSections(tripId)
  const sectionVoters = useSectionVoters(tripId)

  const finished = trip ? isTripFinished(trip) : false
  const myParticipant = (participants ?? []).find((p) => p.user_id === user?.id)
  const isParticipant = !!myParticipant && countsTowardActions(myParticipant)
  const closedSectionIds = useMemo(() => new Set((sections ?? []).filter((s) => s.status === 'completed').map((s) => s.id)), [sections])

  const views = useMemo(
    () =>
      buildTodoViews({
        actions: actions ?? [],
        checklists: checklists ?? [],
        participants: participants ?? [],
        userId: user?.id,
        trip,
        sectionVoters,
        closedSectionIds,
        finished,
      }),
    [actions, checklists, participants, user?.id, trip, sectionVoters, closedSectionIds, finished]
  )
  const groups = useMemo(() => groupTodos(views, { userId: user?.id, finished, viewerInScope: isParticipant }), [views, user?.id, finished, isParticipant])

  return {
    views,
    groups,
    finished,
    isParticipant,
    isLoading: actionsLoading || checklistsLoading,
    isError: actionsError || checklistsError,
  }
}
