import { useQuery } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type Notification = Tables<'notifications'>

/** Sent chase/nudge log for a trip (read path only — writes happen server-side in edge functions). */
export function useNotifications(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.notifications(tripId || ''),
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('sent_at', { ascending: false })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}
