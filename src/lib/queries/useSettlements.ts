import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, Json } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { toRpcError } from './useDecide'
import { unresolvedDuplicateGroups } from '../../features/expenses/settle-up/settleUpLogic'
import {
  isSettlementRpcMissing,
  canRemoveAsDuplicate,
  paymentsChangedSince,
  FREEZE_BLOCKED_BY_DUPLICATES,
  PAYMENTS_CHANGED_MESSAGE,
  type FreezeSuggestionPayload,
} from '../../features/expenses/settle-up/settlementFreeze'

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

export async function fetchSettlements(tripId: string): Promise<Settlement[]> {
  const { data, error } = await supabase.from('settlements').select('*').eq('trip_id', tripId)
  if (error) throw error
  return data || []
}

export function useSettlements(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.settlements(tripId || ''),
    queryFn: () => fetchSettlements(tripId as string),
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

/** The status a settlement must currently have for a transition to `next` to be valid (suggested -> marked_paid -> confirmed). */
export function expectedPriorStatus(next: string): 'suggested' | 'marked_paid' | null {
  if (next === 'marked_paid') return 'suggested'
  if (next === 'confirmed') return 'marked_paid'
  return null
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

      // Transition the existing row (never insert a new one), and only from
      // the status the lifecycle allows: a double tap or a second tab then
      // matches zero rows instead of re-applying the change.
      const expectedPrior = expectedPriorStatus(status)
      let query = supabase.from('settlements').update(patch).eq('id', settlementId)
      if (expectedPrior) query = query.eq('status', expectedPrior)
      const { data, error } = await query.select().maybeSingle()
      if (error) throw error
      if (data) return data
      // Zero rows: either the row is already in the requested state (the same
      // action was submitted twice -- treat as success, idempotent) or RLS /
      // the lifecycle guard filtered it out.
      const { data: current, error: readError } = await supabase.from('settlements').select().eq('id', settlementId).maybeSingle()
      if (readError) throw readError
      if (current && current.status === status) return current
      throw new Error("This settlement couldn't be updated — it may have changed, or you don't have permission.")
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
    // One status change at a time per trip: a double tap queues behind the
    // first write, then finds the row already moved and resolves as a no-op.
    options: { scope: { id: `settlement-status-${tripId}` } },
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

// ---------------------------------------------------------------------------
// Atomic freeze / unfreeze / duplicate removal (RPCs from
// 20261118100000_settlement_freeze.sql). Each falls back to the previous
// client-side sequence while the migration is not applied, so the front end
// can ship in either order.
// ---------------------------------------------------------------------------

function invalidateSettlementState(queryClient: ReturnType<typeof useQueryClient>, tripId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
  queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
  queryClient.invalidateQueries({ queryKey: queryKeys.activityFeed(tripId) })
  // To-dos ("Confirm X paid you", pay reminders) derive from settlements and actions.
  queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) })
}

async function logActivityRow(tripId: string, actor: string, verb: string, metadata?: Record<string, Json>) {
  // Best effort: an audit-row failure must not turn a completed freeze into an error.
  await supabase.from('activity_feed').insert({ trip_id: tripId, actor, verb, entity: { trip_id: tripId }, metadata: metadata ?? null })
}

export interface FreezeSettlementsVars {
  userId: string
  snapshot: unknown
  suggestions: FreezeSuggestionPayload[]
  /** Ids of the non-suggested, non-confirmed rows the suggestions were computed from (see knownPaidIds). */
  knownPaidIds: string[]
  /** The trip's base currency (used by the fallback's duplicate check). */
  baseCurrency: string
}

export interface FreezeSettlementsResult {
  source: 'rpc' | 'fallback'
  inserted: number
  deletedSuggested: number
  skippedDuplicates: number
}

/** The pre-migration sequence: three separate client writes. Not atomic -- only used when the RPC is missing. */
async function freezeClientSide(tripId: string, { userId, snapshot, suggestions, knownPaidIds, baseCurrency }: FreezeSettlementsVars): Promise<FreezeSettlementsResult> {
  // Same guards as the RPC, checked against fresh rows (not atomic, but the best the old path can do).
  const fresh = await fetchSettlements(tripId)
  if (unresolvedDuplicateGroups(fresh, baseCurrency).length > 0) throw new Error(FREEZE_BLOCKED_BY_DUPLICATES)
  if (paymentsChangedSince(fresh, knownPaidIds)) throw new Error(PAYMENTS_CHANGED_MESSAGE)
  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .update({ settlement_snapshot: snapshot as Json, settlement_snapshot_at: new Date().toISOString(), settlement_snapshot_by: userId })
    .eq('id', tripId)
    .select('id')
    .maybeSingle()
  if (tripError) throw toRpcError(tripError)
  if (!trip) throw new Error("Couldn't update this trip's settlement state — you may not have permission.")

  const transactionCount = Array.isArray((snapshot as { transactions?: unknown[] } | null)?.transactions)
    ? ((snapshot as { transactions: unknown[] }).transactions.length)
    : suggestions.length
  await logActivityRow(tripId, userId, 'froze_settlement', { transaction_count: transactionCount })

  // Only 'suggested' rows are cleared; marked_paid / confirmed are payment history.
  const { data: deleted, error: delError } = await supabase.from('settlements').delete().eq('trip_id', tripId).eq('status', 'suggested').select('id')
  if (delError) throw toRpcError(delError, 'Could not clear the old suggested payments')

  let inserted = 0
  for (const t of suggestions) {
    const { error } = await supabase.from('settlements').insert({
      trip_id: tripId,
      from_user_id: t.from,
      to_user_id: t.to,
      amount: t.amount,
      currency: t.currency,
      status: 'suggested',
      created_by: userId,
      settled_at: new Date().toISOString(),
    })
    if (error) throw toRpcError(error)
    inserted++
  }
  return { source: 'fallback', inserted, deletedSuggested: deleted?.length ?? 0, skippedDuplicates: 0 }
}

/** Freeze the balances and (re)create the suggested payments in ONE transaction. */
export function useFreezeSettlements(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: FreezeSettlementsVars): Promise<FreezeSettlementsResult> => {
      const { data, error } = await supabase.rpc('freeze_settlements', {
        p_trip_id: tripId,
        p_snapshot: vars.snapshot as Json,
        p_suggestions: vars.suggestions as unknown as Json,
        p_known_paid_ids: vars.knownPaidIds,
      })
      if (error) {
        if (isSettlementRpcMissing(error, 'freeze_settlements')) return freezeClientSide(tripId, vars)
        throw toRpcError(error, 'Could not freeze the balances')
      }
      const r = (data ?? {}) as { inserted?: number; deleted_suggested?: number; skipped_duplicates?: number }
      return { source: 'rpc', inserted: r.inserted ?? 0, deletedSuggested: r.deleted_suggested ?? 0, skippedDuplicates: r.skipped_duplicates ?? 0 }
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/** Clear the frozen snapshot (atomic with its audit row); falls back to the direct trips update. */
export function useUnfreezeSettlements(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }: { userId: string }): Promise<{ source: 'rpc' | 'fallback' }> => {
      const { error } = await supabase.rpc('unfreeze_settlements', { p_trip_id: tripId })
      if (!error) return { source: 'rpc' }
      if (!isSettlementRpcMissing(error, 'unfreeze_settlements')) throw toRpcError(error, 'Could not unfreeze the balances')
      const { data, error: updError } = await supabase
        .from('trips')
        .update({ settlement_snapshot: null, settlement_snapshot_at: new Date().toISOString(), settlement_snapshot_by: userId })
        .eq('id', tripId)
        .select('id')
        .maybeSingle()
      if (updError) throw toRpcError(updError)
      if (!data) throw new Error("Couldn't update this trip's settlement state — you may not have permission.")
      await logActivityRow(tripId, userId, 'unfroze_settlement')
      return { source: 'fallback' }
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/**
 * Remove ONE payment that is provably a duplicate (see remove_duplicate_settlement).
 * Before the migration is applied it falls back to a direct delete, which RLS
 * limits to admins / the creator within 24h; the duplicate proof is then
 * re-checked here against fresh data.
 */
export function useRemoveDuplicateSettlement(tripId: string, baseCurrency: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string): Promise<{ source: 'rpc' | 'fallback' }> => {
      const { error } = await supabase.rpc('remove_duplicate_settlement', { p_settlement_id: settlementId })
      if (!error) return { source: 'rpc' }
      if (!isSettlementRpcMissing(error, 'remove_duplicate_settlement')) throw toRpcError(error, 'Could not remove the duplicate')

      const fresh = await fetchSettlements(tripId)
      const target = fresh.find((s) => s.id === settlementId)
      if (!target) throw new Error('This payment no longer exists')
      if (target.status === 'confirmed') throw new Error('A confirmed payment cannot be removed this way')
      if (!canRemoveAsDuplicate(target, fresh, baseCurrency)) throw new Error('This payment has no duplicate')
      const { data, error: delError } = await supabase.from('settlements').delete().eq('id', settlementId).select('id')
      if (delError) throw toRpcError(delError)
      if (!data || data.length === 0) throw new Error("Could not remove this payment — it may already be gone, or you don't have permission.")
      return { source: 'fallback' }
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

// ---------------------------------------------------------------------------
// Settle on their behalf (organiser / trip creator / site admin).
// ---------------------------------------------------------------------------

export interface SettleOnBehalfVars {
  settlement: Settlement
  to: 'marked_paid' | 'confirmed'
  actorId: string
  payerName: string
  receiverName: string
  /** True when part of "Mark everything as settled". */
  batch?: boolean
}

/**
 * Move ONE payment forward on the parties' behalf, from the status the caller
 * saw (so a double tap or a stale screen matches zero rows instead of
 * re-applying), then write the attribution row to the activity feed.
 *
 * Server: the live settlements UPDATE policy + guard_settlement_party_update
 * already let an organiser on the roster do this directly (no RPC); a creator
 * or admin who is not on the roster is refused, which surfaces as the
 * "couldn't be updated" error for that row. amount, parties and currency are
 * never sent. Nothing here is optimistic: the cache is patched only after the
 * server accepted the row.
 */
export function useSettleOnBehalf(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ settlement, to, actorId, payerName, receiverName, batch }: SettleOnBehalfVars): Promise<{ row: Settlement; logged: boolean }> => {
      const from = settlement.status
      const { data, error } = await supabase
        .from('settlements')
        .update({ status: to })
        .eq('id', settlement.id)
        .eq('status', from)
        .select()
        .maybeSingle()
      if (error) throw toRpcError(error, 'Could not record this payment')
      if (!data) {
        const { data: current, error: readError } = await supabase.from('settlements').select().eq('id', settlement.id).maybeSingle()
        if (readError) throw readError
        if (current && current.status === to) return { row: current, logged: true } // already done elsewhere
        throw new Error("This payment couldn't be updated: it may have changed, or you don't have permission.")
      }
      const currency = data.currency ?? ''
      const { error: logError } = await supabase.from('activity_feed').insert({
        trip_id: tripId,
        actor: actorId,
        verb: 'settlement_recorded_on_behalf',
        entity: { type: 'settlement', id: data.id, label: `${payerName} → ${receiverName}` } as Json,
        metadata: {
          payer_id: data.from_user_id,
          receiver_id: data.to_user_id,
          payer_name: payerName,
          receiver_name: receiverName,
          amount: data.amount,
          currency,
          from_status: from,
          to_status: to,
          batch: !!batch,
        } as Json,
      })
      return { row: data, logged: !logError }
    },
    onSuccess: ({ row }) => {
      queryClient.setQueryData<Settlement[]>(queryKeys.settlements(tripId), (old) => (old ? old.map((s) => (s.id === row.id ? row : s)) : old))
    },
    // Settle up, the Money header, Waiting on and the to-do list all read the settlements query.
    onSettled: () => invalidateSettlementState(queryClient, tripId),
    scope: { id: `settlement-status-${tripId}` },
  })
}
