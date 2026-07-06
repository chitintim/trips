import { useQuery } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type ChatMessage = Tables<'trip_chat_messages'>

/**
 * Read-only chat history hook. ChatDrawer.tsx owns its own realtime
 * streaming + optimistic-append logic tightly coupled to the AI response
 * flow (edge function call, daily-limit counting) — that belongs to the AI
 * chat workstream, not the generic data layer, so it is intentionally left
 * on its own fetch path rather than ported here. This hook exists so other
 * surfaces (e.g. an activity digest) can read chat history through the
 * same cache/query-key convention as everything else.
 */
export function useChatMessages(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.chatMessages(tripId || ''),
    queryFn: async (): Promise<ChatMessage[]> => {
      const { data, error } = await supabase
        .from('trip_chat_messages')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: true })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}
