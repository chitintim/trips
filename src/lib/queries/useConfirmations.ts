import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { ParticipantWithUser } from './useTrip'
import { assertCountAffected, throwIfError } from './assertRowsAffected'
import { Enums } from '../../types/database.types'
import { useTripActivityLog } from '../../features/organizer/lib/activity'

export type ConfirmationStatus = Enums<'confirmation_status'>
export type ConditionalType = Enums<'conditional_type'>

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
  const logActivity = useTripActivityLog(tripId)
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

      // Count form (no .select()): a RETURNING would make Postgres require the
      // updated row to pass the SELECT policy, which can depend on the row's state.
      const { count, error } = await supabase
        .from('trip_participants')
        .update(update, { count: 'exact' })
        .eq('trip_id', input.tripId)
        .eq('user_id', input.userId)
      throwIfError(error)
      assertCountAffected(count, "Your status could not be saved: you may no longer be on this trip.")
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
    options: {
      onSuccess: (_data, input) => {
        logActivity({ verb: 'rsvp_changed', entity: { type: 'confirmation', id: input.userId, label: input.status } })
      },
    },
  })
}

export function useAddParticipant(tripId: string) {
  const queryClient = useQueryClient()
  const logActivity = useTripActivityLog(tripId)
  return useMutation({
    mutationFn: async ({ userId, role = 'participant' }: { userId: string; role?: 'organizer' | 'participant' }) => {
      // Upsert on the (trip_id, user_id) unique constraint rather than a
      // plain insert: someone who was previously removed from the trip
      // still has a row here with active=false, and a plain insert would
      // violate the constraint. Upserting reactivates that existing row
      // (active: true, requested role) in the same round trip a brand-new
      // participant gets inserted in -- People tab "add participant" covers
      // both cases without needing to branch on whether the user was ever
      // on the trip before.
      const { error } = await supabase
        .from('trip_participants')
        .upsert({ trip_id: tripId, user_id: userId, role, active: true }, { onConflict: 'trip_id,user_id' })
      throwIfError(error)
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmationSummary(tripId) })
      logActivity({ verb: 'participant_joined', entity: { type: 'participant', id: input.userId, label: input.role ?? 'participant' } })
    },
  })
}

export function useSetParticipantActive(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, active }: { userId: string; active: boolean }) => {
      // Deactivating is also guarded server-side (guard_participant_removal
      // trigger): it refuses while the person has an open balance or an
      // unfinished settlement, and that message surfaces as the error here.
      // Count form, not .select(): this update flips `active`, which the
      // trip_participants SELECT policy may filter on, and RETURNING would then
      // reject the (now hidden) updated row and roll the change back.
      const { count, error } = await supabase
        .from('trip_participants')
        .update({ active, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('trip_id', tripId)
        .eq('user_id', userId)
      throwIfError(error)
      assertCountAffected(count, 'You don\'t have permission to change this person, or they are no longer on the trip.')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) }),
  })
}

export interface ResetConfirmationsResult {
  cleared: number
  reminder_history_cleared: number
}

/**
 * Organizer/admin "start a fresh confirmation round": calls the
 * reset_trip_confirmations RPC, which checks the caller's role server-side,
 * returns active participants to pending, clears RSVP reminder history and
 * writes the activity-feed audit row itself (so no client logging here).
 */
export function useResetConfirmations(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ includeDeclined = false }: { includeDeclined?: boolean } = {}): Promise<ResetConfirmationsResult> => {
      const { data, error } = await supabase.rpc('reset_trip_confirmations', {
        p_trip_id: tripId,
        p_include_declined: includeDeclined,
      })
      throwIfError(error)
      return data as unknown as ResetConfirmationsResult
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmationSummary(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.activityFeed(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications(tripId) })
    },
  })
}
