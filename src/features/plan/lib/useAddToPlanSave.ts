import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { throwIfError } from '../../../lib/queries/assertRowsAffected'
import { useSections, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants } from '../../../lib/queries/useTrip'
import { isTripFinished } from '../../../lib/answers/answers'
import { isViewerOut } from '../../decisions/lib/answerModel'
import { useCanSuggestIdea } from './useCanSuggestIdea'
import type { Trip } from '../../../types'
import { suggestOption, invalidateAfterSuggestOption } from '../../../lib/queries/useSuggestions'
import { normalizeSuggestionLink } from '../../decisions/lib/suggestOption'
import {
  availableIntents, buildEventInsert, buildIdeaOptionRow, buildMyPlanItemInput, buildIdeasSectionInsert, buildQuestionOptionRows, buildSectionInsert, findIdeasQuestion,
  type AddIntent, type HappeningValues, type IdeaValues, type QuestionValues,
} from './addFlow'
import { saveMyPlanItem } from './myPlanItems'

/** Create a happening (timeline event). Plain function; the hook adds the activity row and cache refresh. */
export async function createHappening(tripId: string, userId: string | undefined, v: HappeningValues): Promise<{ id: string }> {
  if (!userId) throw new Error('You need to be signed in.')
  const { data, error } = await supabase.from('trip_timeline_events').insert(buildEventInsert(v, tripId, userId)).select('id').single()
  throwIfError(error)
  return { id: data!.id }
}

/**
 * Create a question with its options (organizers). If the options cannot be stored the empty question is
 * removed again. Returns the new question's id. Plain function shared by the Add flow and the trip chat; the
 * activity row (`option_added`) and the cache refresh stay with the caller (`invalidateAfterCreateQuestion`).
 */
export async function createQuestionWithOptions(tripId: string, v: QuestionValues): Promise<{ id: string }> {
  const { data: section, error } = await supabase
    .from('planning_sections')
    .insert({ ...buildSectionInsert(v), trip_id: tripId })
    .select('id')
    .single()
  throwIfError(error)
  const sectionId = section!.id
  const { error: optionsError } = await supabase.from('options').insert(buildQuestionOptionRows(v, sectionId))
  if (optionsError) {
    // Never leave an empty question behind.
    await supabase.from('planning_sections').delete().eq('id', sectionId)
    throwIfError(optionsError)
  }
  return { id: sectionId }
}

/**
 * Add an idea. A participant (not an organizer) goes through the `suggest_option` RPC, which writes the
 * activity row itself; an organizer finds or creates the Ideas question and inserts the option directly.
 * `knownSections` is only a fallback for finding the Ideas question when the fresh lookup returns nothing.
 */
export async function addIdea(
  tripId: string,
  v: IdeaValues,
  asParticipant: boolean,
  knownSections?: ReadonlyArray<Pick<SectionWithOptions, 'id' | 'status' | 'title' | 'metadata' | 'created_at'>>
): Promise<{ questionId: string }> {
  if (asParticipant) {
    // People who are not organizers cannot write options or questions; the RPC adds one safe option to the Ideas
    // question (creating it on first use) and writes the activity row itself.
    const res = await suggestOption(tripId, { sectionId: null, idea: true, title: v.title, link: normalizeSuggestionLink(v.link) ?? '' })
    return { questionId: res.section_id }
  }
  // Find-or-create defensively: re-query before inserting, and if two buckets ever exist always use the oldest.
  const { data: existing, error: lookupError } = await supabase
    .from('planning_sections')
    .select('id, status, title, metadata, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  throwIfError(lookupError)
  let sectionId = findIdeasQuestion(existing ?? knownSections)?.id
  if (!sectionId) {
    const { data, error } = await supabase
      .from('planning_sections')
      .insert({ ...buildIdeasSectionInsert(), trip_id: tripId })
      .select('id')
      .single()
    throwIfError(error)
    sectionId = data!.id
  }
  const { error } = await supabase.from('options').insert(buildIdeaOptionRow(v, sectionId))
  throwIfError(error)
  return { questionId: sectionId }
}

/** Refresh what the Add saves change: the timeline for a happening, the questions for the rest. Same calls the hook makes. */
export function invalidateAfterCreateHappening(queryClient: QueryClient, tripId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
}
export function invalidateAfterCreateQuestion(queryClient: QueryClient, tripId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
}
export const invalidateAfterAddIdea = invalidateAfterCreateQuestion

/**
 * The three Add saves. New file (not usePlanning.ts) because the existing hooks do not hand back the new
 * row's id, which the toast's "View" link needs. Every failure is thrown to the caller, which shows it.
 */
export function useAddToPlanSave(tripId: string, userId: string | undefined, asParticipant = false, justMe = false) {
  const queryClient = useQueryClient()
  const logActivity = useTripActivityLog(tripId)
  const { data: sections } = useSections(tripId)

  const happening = useMutation({
    // Members add a "just me" plan through the RPC (RLS refuses their direct insert); organisers insert directly.
    mutationFn: async (v: HappeningValues): Promise<{ id: string }> => {
      if (!justMe) return createHappening(tripId, userId, v)
      const res = await saveMyPlanItem(tripId, null, buildMyPlanItemInput(v))
      return { id: res.id as string }
    },
    onSuccess: (_row, v) => {
      // The RPC writes no activity row, so members' own plans are not logged here either.
      if (!justMe) logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: v.title.trim() } })
      return invalidateAfterCreateHappening(queryClient, tripId)
    },
  })

  const question = useMutation({
    mutationFn: (v: QuestionValues): Promise<{ id: string }> => createQuestionWithOptions(tripId, v),
    onSuccess: (row, v) => {
      logActivity({ verb: 'option_added', entity: { type: 'section', id: row.id, label: v.title.trim() } })
      return invalidateAfterCreateQuestion(queryClient, tripId)
    },
  })

  const idea = useMutation({
    mutationFn: (v: IdeaValues): Promise<{ questionId: string }> => addIdea(tripId, v, asParticipant, sections),
    onSuccess: (row, v) => {
      if (asParticipant) {
        // The suggestion went through suggest_option, whose own hook refreshes every decision key first.
        invalidateAfterSuggestOption(queryClient, tripId)
        return invalidateAfterAddIdea(queryClient, tripId)
      }
      logActivity({ verb: 'option_added', entity: { type: 'section', id: row.questionId, label: v.title.trim() } })
      return invalidateAfterAddIdea(queryClient, tripId)
    },
  })

  return { happening, question, idea, isSaving: happening.isPending || question.isPending || idea.isPending }
}

/**
 * What this viewer may add: the intents plus the facts the Add sheet needs. "Coming" = on the trip and not
 * declined, cancelled or removed (`isViewerOut`, the same notion the idea gate uses).
 */
export function useAddIntents(trip: Trip | null | undefined): { intents: AddIntent[]; isMember: boolean; canSuggestIdea: boolean; isLoading: boolean } {
  const { user } = useAuth()
  const { canManageTrip, isLoading } = useTripPermissions(trip)
  const canSuggestIdea = useCanSuggestIdea(trip)
  const { data: participants } = useParticipants(trip?.id)
  const isComing = !!user && (participants ?? []).some((p) => p.user_id === user.id) && !isViewerOut(user.id, participants ?? [])
  const intents = availableIntents(canManageTrip, !trip || isTripFinished(trip), canSuggestIdea, isComing)
  return { intents, isMember: !canManageTrip, canSuggestIdea, isLoading }
}
