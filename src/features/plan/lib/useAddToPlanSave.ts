import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { throwIfError } from '../../../lib/queries/assertRowsAffected'
import { useSections } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import {
  buildEventInsert, buildIdeaOptionRow, buildIdeasSectionInsert, buildQuestionOptionRows, buildSectionInsert, findIdeasQuestion,
  type HappeningValues, type IdeaValues, type QuestionValues,
} from './addFlow'

/**
 * The three Add saves. New file (not usePlanning.ts) because the existing hooks do not hand back the new
 * row's id, which the toast's "View" link needs. Every failure is thrown to the caller, which shows it.
 */
export function useAddToPlanSave(tripId: string, userId: string | undefined) {
  const queryClient = useQueryClient()
  const logActivity = useTripActivityLog(tripId)
  const { data: sections } = useSections(tripId)

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
      let sectionId = findIdeasQuestion(sections)?.id
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
      logActivity({ verb: 'option_added', entity: { type: 'section', id: row.questionId, label: v.title.trim() } })
      return queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
    },
  })

  return { happening, question, idea, isSaving: happening.isPending || question.isPending || idea.isPending }
}
