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

/** Full settlement history with joined user rows, as used by SettlementHistoryModal. */
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

/** status: 'suggested' -> 'marked_paid' (by payer) -> 'confirmed' (by recipient). Optimistic for snappy taps. */
export function useUpdateSettlementStatus(tripId: string) {
  return useOptimisticMutation<void, { settlementId: string; status: string }, Settlement[]>({
    mutationFn: async ({ settlementId, status }) => {
      const { error } = await supabase.from('settlements').update({ status }).eq('id', settlementId)
      if (error) throw error
    },
    queryKey: () => queryKeys.settlements(tripId),
    updater: (settlements, { settlementId, status }) =>
      (settlements || []).map((s) => (s.id === settlementId ? { ...s, status } : s)),
  })
}

export function useDeleteSettlement(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string) => {
      const { error } = await supabase.from('settlements').delete().eq('id', settlementId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) }),
  })
}

/** Freeze balances into trips.settlement_snapshot (the "finalize settlements" step). */
export function useFinalizeSettlementSnapshot(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ snapshotData, snapshotBy }: { snapshotData: unknown; snapshotBy: string }) => {
      const { error } = await supabase
        .from('trips')
        .update({
          settlement_snapshot: snapshotData as Json,
          settlement_snapshot_at: new Date().toISOString(),
          settlement_snapshot_by: snapshotBy,
        })
        .eq('id', tripId)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
    },
  })
}

export function useToggleSnapshotTransactionSettled(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ snapshot, index }: { snapshot: SettlementSnapshot; index: number }) => {
      const updated: SettlementSnapshot = { ...snapshot, transactions: [...snapshot.transactions] }
      updated.transactions[index] = { ...updated.transactions[index], settled: !updated.transactions[index].settled }
      const { error } = await supabase.from('trips').update({ settlement_snapshot: updated as unknown as Json }).eq('id', tripId)
      if (error) throw error
      return updated
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) }),
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
