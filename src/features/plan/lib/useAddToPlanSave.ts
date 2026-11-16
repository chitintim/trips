import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { throwIfError } from '../../../lib/queries/assertRowsAffected'
import { useSections } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useSuggestOption } from '../../../lib/queries/useSuggestions'
import { normalizeSuggestionLink } from '../../decisions/lib/suggestOption'
import {
  buildEventInsert, buildIdeaOptionRow, buildIdeasSectionInsert, buildQuestionOptionRows, buildSectionInsert, findIdeasQuestion,
  type HappeningValues, type IdeaValues, type QuestionValues,
} from './addFlow'

/**
 * The three Add saves. New file (not usePlanning.ts) because the existing hooks do not hand back the new
 * row's id, which the toast's "View" link needs. Every failure is thrown to the caller, which shows it.
 */
export function useAddToPlanSave(tripId: string, userId: string | undefined, asParticipant = false) {
  const queryClient = useQueryClient()
  const logActivity = useTripActivityLog(tripId)
  const { data: sections } = useSections(tripId)
  const suggest = useSuggestOption(tripId)

  const happening = useMutation({
    mutationFn: async (v: HappeningValues): Promise<{ id: string }> => {
      if (!userId) throw new Error('You need to be signed in.')
      const { data, error } = await supabase.from('trip_timeline_events').insert(buildEventInsert(v, tripId, userId)).select('id').single()
      throwIfError(error)
      return { id: data!.id }
    },
    onSuccess: (_row, v) => {
      logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: v.title.trim() } })
      return queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
    },
  })

  const question = useMutation({
    mutationFn: async (v: QuestionValues): Promise<{ id: string }> => {
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
    },
    onSuccess: (row, v) => {
      logActivity({ verb: 'option_added', entity: { type: 'section', id: row.id, label: v.title.trim() } })
      return queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
    },
  })

  const idea = useMutation({
    mutationFn: async (v: IdeaValues): Promise<{ questionId: string }> => {
      if (asParticipant) {
        // People who are not organizers cannot write options or questions; the RPC adds one safe option to the Ideas
        // question (creating it on first use) and writes the activity row itself.
        const res = await suggest.mutateAsync({ sectionId: null, idea: true, title: v.title, link: normalizeSuggestionLink(v.link) ?? '' })
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
      let sectionId = findIdeasQuestion(existing ?? sections)?.id
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
    },
    onSuccess: (row, v) => {
      if (asParticipant) return queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
      logActivity({ verb: 'option_added', entity: { type: 'section', id: row.questionId, label: v.title.trim() } })
      return queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
    },
  })

  return { happening, question, idea, isSaving: happening.isPending || question.isPending || idea.isPending }
}
