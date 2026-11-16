import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { assertRowsAffected, throwIfError } from './assertRowsAffected'

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
      throwIfError(error)
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
      throwIfError(error)
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export function useUpdateBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'bookings'> }) => {
      const { data, error } = await supabase
        .from('bookings')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to edit this booking, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export function useDeleteBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('bookings').delete().eq('id', id).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to delete this booking, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export interface CancelBookingFollowUps {
  bookingId: string
  /** Delete the linked expense (and unlink it). Omit/false to keep it. */
  removeExpenseId?: string | null
  /** Delete the linked timeline event (and unlink it). Omit/false to keep it. */
  removeEventId?: string | null
}

/**
 * Organiser-chosen follow-ups after a booking is marked cancelled. Nothing
 * is removed unless an id is passed. The target is deleted directly:
 * bookings.expense_id and bookings.timeline_event_id are ON DELETE SET NULL,
 * so the database clears the link itself (the RI action bypasses RLS). That
 * avoids unlinking first and stranding an unlinked booking if the delete is
 * refused. Every step throws on 0 affected rows.
 */
export function useCancelBookingFollowUps(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ removeExpenseId, removeEventId }: CancelBookingFollowUps) => {
      if (removeExpenseId) {
        const { data, error } = await supabase.from('expenses').delete().eq('id', removeExpenseId).select('id')
        throwIfError(error)
        assertRowsAffected(data, "You don't have permission to remove the linked expense (only the payer or an organizer can), or it no longer exists.")
      }
      if (removeEventId) {
        const { data, error } = await supabase.from('trip_timeline_events').delete().eq('id', removeEventId).select('id')
        throwIfError(error)
        assertRowsAffected(data, "You don't have permission to remove the linked event, or it no longer exists.")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
    },
  })
}
