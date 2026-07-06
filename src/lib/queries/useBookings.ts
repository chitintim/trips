import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type Booking = Tables<'bookings'>

export function useBookings(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.bookings(tripId || ''),
    queryFn: async (): Promise<Booking[]> => {
      const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'bookings'>, 'trip_id'>) => {
      const { data, error } = await supabase
        .from('bookings')
        .insert({ trip_id: tripId, ...input })
        .select()
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export function useUpdateBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'bookings'> }) => {
      const { error } = await supabase
        .from('bookings')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export function useDeleteBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('bookings').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}
