import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Invitation } from '../../types'

/** Admin invitations list (Dashboard's InvitationsTab). Not trip-scoped, so it lives outside the ['trip', tripId, ...] hierarchy. */
export function useInvitations() {
  return useQuery({
    queryKey: ['invitations'] as const,
    queryFn: async (): Promise<Invitation[]> => {
      const { data, error } = await supabase.from('invitations').select('*').order('created_at', { ascending: false })
      if (error) throw error
      return data || []
    },
  })
}

/**
 * Create an invitation via the create_invitation RPC — kept as an RPC
 * (rather than a plain insert) specifically because the function exists to
 * avoid RLS ambiguity on the invitations table, per the original
 * CreateInvitationModal implementation.
 */
export function useCreateInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ tripId, expiresAt }: { tripId: string; expiresAt: string }) => {
      const { data, error } = await supabase
        .rpc('create_invitation', { p_trip_id: tripId, p_expires_at: expiresAt })
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  })
}

export function useDeleteInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('invitations').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  })
}
