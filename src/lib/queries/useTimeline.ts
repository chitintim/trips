import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { TimelineEvent, TimelineEventInsert, TimelineEventUpdate } from '../../types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

/** Trip timeline events, ordered exactly as PlanBoard's List lens expects (date, start_time, sort_order). */
export function useTimeline(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.timeline(tripId || ''),
    queryFn: async (): Promise<TimelineEvent[]> => {
      const { data, error } = await supabase
        .from('trip_timeline_events')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('event_date')
        .order('start_time')
        .order('sort_order')
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateTimelineEvent(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TimelineEventInsert) => {
      const { error } = await supabase.from('trip_timeline_events').insert(input)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) }),
  })
}

/**
 * Materializing a derived milestone (DerivedMilestoneRow's "+ Make it an
 * event" affordance, PlanBoard.tsx's handleMaterialize) inserts a row whose
 * fields are all already known up front — title/category/date/
 * metadata.derived_key come straight off the DerivedMilestone, no
 * multi-field form to wait on — which makes it a clean case for an
 * optimistic insert: the row lands in the same `events` cache used to
 * compute both the plan's items (usePlanItems) and the still-unmaterialized
 * milestones (deriveMilestones' materializedDerivedKeys dedupe), so the
 * derived row disappears and the real item appears in the same render,
 * with no flash of both being visible. Rolled back automatically on
 * failure by the shared optimistic-mutation helper.
 */
export function useMaterializeMilestone(tripId: string) {
  return useOptimisticMutation<TimelineEvent, TimelineEventInsert, TimelineEvent[]>({
    mutationFn: async (input) => {
      const { data, error } = await supabase.from('trip_timeline_events').insert(input).select().single()
      if (error) throw error
      return data
    },
    queryKey: () => queryKeys.timeline(tripId),
    updater: (events, input) => {
      const optimisticEvent: TimelineEvent = {
        id: `optimistic-${Date.now()}`,
        trip_id: tripId,
        title: input.title,
        description: input.description ?? null,
        event_date: input.event_date,
        start_time: input.start_time ?? null,
        end_time: input.end_time ?? null,
        all_day: input.all_day ?? null,
        category: input.category ?? 'other',
        location: input.location ?? null,
        place_id: input.place_id ?? null,
        source_option_id: input.source_option_id ?? null,
        sort_order: input.sort_order ?? null,
        participant_ids: input.participant_ids ?? null,
        metadata: input.metadata ?? null,
        created_by: input.created_by,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      return [...(events ?? []), optimisticEvent]
    },
  })
}

export function useUpdateTimelineEvent(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TimelineEventUpdate }) => {
      const { error } = await supabase
        .from('trip_timeline_events')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) }),
  })
}

/** Pending-state (non-optimistic) delete, per the brief's guidance for destructive actions. */
export function useDeleteTimelineEvent(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('trip_timeline_events').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) }),
  })
}
