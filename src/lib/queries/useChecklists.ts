import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

export type ChecklistItem = Tables<'trip_checklists'>

/** Lightweight shared checklist ("who's bringing the speaker"). */
export function useChecklists(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.checklists(tripId || ''),
    queryFn: async (): Promise<ChecklistItem[]> => {
      const { data, error } = await supabase
        .from('trip_checklists')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: true })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateChecklistItem(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'trip_checklists'>, 'trip_id'>) => {
      const { error } = await supabase.from('trip_checklists').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.checklists(tripId) }),
  })
}

/** Check/uncheck a checklist item — optimistic. */
export function useToggleChecklistItem(tripId: string) {
  return useOptimisticMutation<void, { id: string; done: boolean }, ChecklistItem[]>({
    mutationFn: async ({ id, done }) => {
      const { error } = await supabase
        .from('trip_checklists')
        .update({ done, done_at: done ? new Date().toISOString() : null })
        .eq('id', id)
      if (error) throw error
    },
    queryKey: () => queryKeys.checklists(tripId),
    updater: (items, { id, done }) =>
      (items || []).map((item) => (item.id === id ? { ...item, done, done_at: done ? new Date().toISOString() : null } : item)),
  })
}

/** Pending-state (non-optimistic) delete. */
export function useDeleteChecklistItem(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('trip_checklists').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.checklists(tripId) }),
  })
}
