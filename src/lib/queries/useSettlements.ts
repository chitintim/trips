import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, Json } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

export type Settlement = Tables<'settlements'>
export type SettlementCarryover = Tables<'settlement_carryovers'>

export interface SettlementSnapshotTransaction {
  from: string
  to: string
  fromName: string
  toName: string
  amount: number
  settled: boolean
}

/** Shape of trips.settlement_snapshot as written by the freeze/finalize flow. */
export interface SettlementSnapshot {
  transactions: SettlementSnapshotTransaction[]
  balances: Array<{ userId: string; name: string; netBalance: number }>
  created_at: string
}

export function useSettlements(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.settlements(tripId || ''),
    queryFn: async (): Promise<Settlement[]> => {
      const { data, error } = await supabase.from('settlements').select('*').eq('trip_id', tripId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export interface SettlementWithUsers extends Settlement {
  from_user: Tables<'users'>
  to_user: Tables<'users'>
  creator: Tables<'users'>
}

/**
 * Full settlement history with joined user rows. Not wired into a dedicated
 * history screen today -- the per-row status/method/date/note now shown
 * inline in SettleUpTab (see MarkPaidSheet) covers the "when/how did I
 * settle" need this hook was originally built for. Left in place as ready
 * infra if a full audit-trail modal is wanted later.
 */
export function useSettlementHistory(tripId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.settlements(tripId || ''), 'history'] as const,
    queryFn: async (): Promise<SettlementWithUsers[]> => {
      const { data, error } = await supabase
        .from('settlements')
        .select(
          `
          *,
          from_user:from_user_id (*),
          to_user:to_user_id (*),
          creator:created_by (*)
        `
        )
        .eq('trip_id', tripId as string)
        .order('settled_at', { ascending: false })
      if (error) throw error
      return (data as unknown as SettlementWithUsers[]) || []
    },
    enabled: !!tripId,
  })
}

export function useSettlementCarryovers(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.settlementCarryovers(tripId || ''),
    queryFn: async (): Promise<SettlementCarryover[]> => {
      const { data, error } = await supabase.from('settlement_carryovers').select('*').eq('trip_id', tripId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

/** Record a settlement payment (manual "who paid whom" entry). */
export function useRecordSettlement(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'settlements'>, 'trip_id'>) => {
      const { error } = await supabase.from('settlements').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) }),
  })
}

export interface UpdateSettlementStatusVars {
  settlementId: string
  status: string
  payment_method?: string | null
  notes?: string | null
  settled_at?: string
}

/**
 * status: 'suggested' -> 'marked_paid' (by payer, optionally with
 * payment_method/notes/settled_at) -> 'confirmed' (by recipient). Optimistic
 * for snappy taps.
 *
 * RLS is the actual gate on who may do this (see the
 * settlements_two_party_lifecycle migration): the payer may only move
 * suggested -> marked_paid on their own row, the payee only marked_paid ->
 * confirmed. When RLS (or the guard trigger) filters the row out,
 * PostgREST returns success with zero rows affected -- no PostgrestError --
 * so `.select().maybeSingle()` and an explicit throw on a null result are
 * what make that failure visible instead of a silent optimistic-then-
 * reverted "bounce".
 */
export function useUpdateSettlementStatus(tripId: string) {
  return useOptimisticMutation<Settlement, UpdateSettlementStatusVars, Settlement[]>({
    mutationFn: async ({ settlementId, status, payment_method, notes, settled_at }) => {
      const patch: Record<string, unknown> = { status }
      if (payment_method !== undefined) patch.payment_method = payment_method
      if (notes !== undefined) patch.notes = notes
      if (settled_at !== undefined) patch.settled_at = settled_at

      const { data, error } = await supabase.from('settlements').update(patch).eq('id', settlementId).select().maybeSingle()
      if (error) throw error
      if (!data) {
        throw new Error("This settlement couldn't be updated — it may have changed, or you don't have permission.")
      }
      return data
    },
    queryKey: () => queryKeys.settlements(tripId),
    updater: (settlements, { settlementId, status, payment_method, notes, settled_at }) =>
      (settlements || []).map((s) =>
        s.id === settlementId
          ? {
              ...s,
              status,
              ...(payment_method !== undefined ? { payment_method } : {}),
              ...(notes !== undefined ? { notes } : {}),
              ...(settled_at !== undefined ? { settled_at } : {}),
            }
          : s
      ),
  })
}

export function useDeleteSettlement(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string) => {
      const { data, error } = await supabase.from('settlements').delete().eq('id', settlementId).select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('Could not delete this settlement — it may already be gone, or you don\'t have permission.')
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) }),
  })
}

/** Freeze balances into trips.settlement_snapshot (the "finalize settlements" step). */
export function useFinalizeSettlementSnapshot(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ snapshotData, snapshotBy }: { snapshotData: unknown; snapshotBy: string }) => {
      const { data, error } = await supabase
        .from('trips')
        .update({
          settlement_snapshot: snapshotData as Json,
          settlement_snapshot_at: new Date().toISOString(),
          settlement_snapshot_by: snapshotBy,
        })
        .eq('id', tripId)
        .select('id')
        .maybeSingle()
      if (error) throw error
      // A non-organizer/non-creator's click is filtered to 0 rows by RLS
      // with no PostgrestError -- surface that explicitly rather than let
      // the caller believe the freeze/unfreeze actually applied.
      if (!data) {
        throw new Error("Couldn't update this trip's settlement state — you may not have permission.")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
    },
  })
}

/** Fold an unsettled balance from a previous completed trip into this trip's settlement. */
export function useCreateSettlementCarryover(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'settlement_carryovers'>, 'trip_id'>) => {
      const { error } = await supabase.from('settlement_carryovers').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settlementCarryovers(tripId) })
      // useCarryoverCandidates keys on ['carryoverCandidates', tripId, userId]
      // (not part of the queryKeys factory -- it's not trip-detail-prefixed
      // data). Invalidate the whole family by its literal string prefix so
      // de-dupe reflects this fold immediately instead of waiting out its
      // 5-minute staleTime, for whichever trip(s) the candidate was surfaced
      // from/into.
      queryClient.invalidateQueries({ queryKey: ['carryoverCandidates'] })
    },
  })
}
