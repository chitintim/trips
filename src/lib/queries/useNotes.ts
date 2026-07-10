import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { TripNoteWithUser, TripNoteInsert, User } from '../../types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

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

/**
 * Posting an announcement/note should appear instantly (Form & Flow
 * Standard-adjacent UX expectation) — optimistically prepend a placeholder
 * note built from the poster's own cached `currentUser` row (already
 * fetched everywhere the composer is reachable), rolled back on failure,
 * reconciled with the real row once the insert settles.
 */
export function useCreateNote(tripId: string) {
  const queryClient = useQueryClient()
  return useOptimisticMutation<void, Omit<TripNoteInsert, 'trip_id'>, TripNoteWithUser[]>({
    mutationFn: async (input) => {
      const { error } = await supabase.from('trip_notes').insert({ ...input, trip_id: tripId })
      if (error) throw error
    },
    queryKey: () => queryKeys.notes(tripId),
    updater: (notes, input) => {
      const author = queryClient.getQueryData<User | null>(queryKeys.currentUser(input.user_id))
      const optimisticNote: TripNoteWithUser = {
        id: `optimistic-${Date.now()}`,
        trip_id: tripId,
        user_id: input.user_id,
        note_type: input.note_type ?? 'note',
        content: input.content,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user: author ?? undefined,
      }
      return [optimisticNote, ...(notes ?? [])]
    },
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
