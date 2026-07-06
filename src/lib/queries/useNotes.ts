import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { TripNoteWithUser, TripNoteInsert } from '../../types'
import { queryKeys } from './queryKeys'

/** Trip notes + author, matching TripNotesSection.tsx's select shape. */
export function useNotes(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.notes(tripId || ''),
    queryFn: async (): Promise<TripNoteWithUser[]> => {
      const { data, error } = await supabase
        .from('trip_notes')
        .select(
          `
          *,
          user:user_id (
            id,
            full_name,
            email,
            avatar_data
          )
        `
        )
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data as unknown as TripNoteWithUser[]) || []
    },
    enabled: !!tripId,
  })
}

export function useCreateNote(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TripNoteInsert, 'trip_id'>) => {
      const { error } = await supabase.from('trip_notes').insert({ ...input, trip_id: tripId })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notes(tripId) }),
  })
}

export function useDeleteNote(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (noteId: string) => {
      const { error } = await supabase.from('trip_notes').delete().eq('id', noteId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notes(tripId) }),
  })
}
