import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { TimelineEvent, TimelineEventInsert, TimelineEventUpdate } from '../../types'
import { queryKeys } from './queryKeys'

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
