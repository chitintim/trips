import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type Place = Tables<'places'>

export function usePlaces(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.places(tripId || ''),
    queryFn: async (): Promise<Place[]> => {
      const { data, error } = await supabase.from('places').select('*').eq('trip_id', tripId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreatePlace(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'places'>, 'trip_id'>) => {
      const { data, error } = await supabase
        .from('places')
        .insert({ trip_id: tripId, ...input })
        .select()
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.places(tripId) }),
  })
}

export function useUpdatePlace(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'places'> }) => {
      const { error } = await supabase.from('places').update(update).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.places(tripId) }),
  })
}

export function useDeletePlace(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('places').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.places(tripId) }),
  })
}
