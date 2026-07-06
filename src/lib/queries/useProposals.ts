import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'

export type AiProposal = Tables<'ai_proposals'>

/** AI-suggested changesets awaiting human review (§13 write-safety spine). */
export function useProposals(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.proposals(tripId || ''),
    queryFn: async (): Promise<AiProposal[]> => {
      const { data, error } = await supabase
        .from('ai_proposals')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateProposal(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'ai_proposals'>, 'trip_id'>) => {
      const { data, error } = await supabase
        .from('ai_proposals')
        .insert({ trip_id: tripId, ...input })
        .select()
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.proposals(tripId) }),
  })
}

/**
 * Status transitions: 'pending' -> 'approved' | 'rejected' | 'partially_applied'.
 * Per §13, applying proposal actions happens client-side under the approving
 * user's JWT (separate per-action mutations elsewhere) — this hook only
 * updates the proposal row's status/audit fields.
 */
export function useUpdateProposalStatus(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      status,
      reviewedBy,
      appliedAt,
    }: {
      id: string
      status: string
      reviewedBy?: string
      appliedAt?: string
    }) => {
      const { error } = await supabase
        .from('ai_proposals')
        .update({ status, reviewed_by: reviewedBy, applied_at: appliedAt })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.proposals(tripId) }),
  })
}
