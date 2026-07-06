import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { ParticipantWithUser } from './useTrip'
import { Enums } from '../../types/database.types'

export type ConfirmationStatus = Enums<'confirmation_status'>
export type ConditionalType = Enums<'conditional_type'>

export interface ConfirmationSummaryRow {
  status: ConfirmationStatus
  count: number
  user_ids: string[]
}

/** Server-computed per-status counts, via the get_confirmation_summary RPC. */
export function useConfirmationSummary(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.confirmationSummary(tripId || ''),
    queryFn: async (): Promise<ConfirmationSummaryRow[]> => {
      const { data, error } = await supabase.rpc('get_confirmation_summary', { p_trip_id: tripId as string })
      if (error) throw error
      return (data as ConfirmationSummaryRow[]) || []
    },
    enabled: !!tripId,
  })
}

export interface UpdateConfirmationInput {
  tripId: string
  userId: string
  status: ConfirmationStatus
  note?: string | null
  conditionalType?: ConditionalType
  conditionalDate?: string | null
  conditionalUserIds?: string[] | null
}

/**
 * RSVP status change — optimistic against the participants cache (the
 * single most common "needs your attention" resolving action).
 */
export function useUpdateConfirmationStatus(tripId: string) {
  return useOptimisticMutation<void, UpdateConfirmationInput, ParticipantWithUser[]>({
    mutationFn: async (input) => {
      const update: Record<string, unknown> = {
        confirmation_status: input.status,
        confirmation_note: input.note?.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (input.status !== 'conditional') {
        update.conditional_type = 'none'
        update.conditional_date = null
        update.conditional_user_ids = null
      } else {
        update.conditional_type = input.conditionalType
        update.conditional_date = input.conditionalDate || null
        update.conditional_user_ids = input.conditionalUserIds?.length ? input.conditionalUserIds : null
      }

      const { error } = await supabase
        .from('trip_participants')
        .update(update)
        .eq('trip_id', input.tripId)
        .eq('user_id', input.userId)
      if (error) throw error
    },
    queryKey: () => [queryKeys.participants(tripId), queryKeys.confirmationSummary(tripId)],
    updater: (participants, input) => {
      if (!participants) return participants as unknown as ParticipantWithUser[]
      return participants.map((p) =>
        p.user_id === input.userId
          ? {
              ...p,
              confirmation_status: input.status,
              confirmation_note: input.note?.trim() || null,
              conditional_type: input.status === 'conditional' ? input.conditionalType ?? 'none' : 'none',
              conditional_date: input.status === 'conditional' ? input.conditionalDate ?? null : null,
              conditional_user_ids: input.status === 'conditional' ? input.conditionalUserIds ?? null : null,
            }
          : p
      )
    },
  })
}

export function useAddParticipant(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, role = 'participant' }: { userId: string; role?: 'organizer' | 'participant' }) => {
      const { error } = await supabase.from('trip_participants').insert({ trip_id: tripId, user_id: userId, role })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmationSummary(tripId) })
    },
  })
}

export function useSetParticipantActive(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, active }: { userId: string; active: boolean }) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ active, updated_at: new Date().toISOString() })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) }),
  })
}

export function useChangeParticipantRole(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'organizer' | 'participant' }) => {
      const { error } = await supabase
        .from('trip_participants')
        .update({ role })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) }),
  })
}
