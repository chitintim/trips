import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type ActivityFeedEntry = Tables<'activity_feed'>

/** Lightweight per-trip activity feed ("Alex claimed 3 items", "Poll closed — X wins"). */
export function useActivityFeed(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.activityFeed(tripId || ''),
    queryFn: async (): Promise<ActivityFeedEntry[]> => {
      const { data, error } = await supabase
        .from('activity_feed')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useLogActivity(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'activity_feed'>, 'trip_id'>) => {
      const { error } = await supabase.from('activity_feed').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.activityFeed(tripId) }),
  })
}
