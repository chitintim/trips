import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, Json } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { toRpcError } from './useDecide'
import { invokePaymentNotice, notifyPaymentEventAndRefresh, shouldNotifyPaymentEvent } from './notifyPaymentEvent'
import type { FreezeSuggestionPayload } from '../../features/expenses/settle-up/settlementFreeze'

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
  const queryClient = useQueryClient()
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
      if (data) {
        // Fire-and-forget email to the other party; never delays or fails the mutation.
        void supabase.auth
          .getUser()
          .then(({ data: auth }) => {
            const event = shouldNotifyPaymentEvent({ newStatus: data.status, actorId: auth.user?.id, receiverId: data.to_user_id })
            if (event) void notifyPaymentEventAndRefresh(queryClient, tripId, data.id, event)
          })
          .catch(() => undefined)
        return data
      }
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
// 20261118100000_settlement_freeze.sql). Live since 20261118: no client-side
// fallback (the database refuses direct writes to the snapshot columns).
// ---------------------------------------------------------------------------

function invalidateSettlementState(queryClient: ReturnType<typeof useQueryClient>, tripId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
  queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
  // The Money header reads its settlements from the expenses query, so a freeze/unfreeze must refresh that too or the two disagree.
  queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) })
  queryClient.invalidateQueries({ queryKey: queryKeys.activityFeed(tripId) })
  // To-dos ("Confirm X paid you", pay reminders) derive from settlements and actions.
  queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) })
}

export interface FreezeSettlementsVars {
  snapshot: unknown
  suggestions: FreezeSuggestionPayload[]
  /** Ids of the non-suggested, non-confirmed rows the suggestions were computed from (see knownPaidIds). */
  knownPaidIds: string[]
}

export interface FreezeSettlementsResult {
  inserted: number
  deletedSuggested: number
  skippedDuplicates: number
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
      if (error) throw toRpcError(error, 'Could not freeze the balances')
      const r = (data ?? {}) as { inserted?: number; deleted_suggested?: number; skipped_duplicates?: number }
      return { inserted: r.inserted ?? 0, deletedSuggested: r.deleted_suggested ?? 0, skippedDuplicates: r.skipped_duplicates ?? 0 }
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/** Clear the frozen snapshot (atomic with its audit row). */
export function useUnfreezeSettlements(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { error } = await supabase.rpc('unfreeze_settlements', { p_trip_id: tripId })
      if (error) throw toRpcError(error, 'Could not unfreeze the balances')
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/** Remove ONE payment that is provably a duplicate (the database re-checks the proof: see remove_duplicate_settlement). */
export function useRemoveDuplicateSettlement(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string): Promise<void> => {
      const { error } = await supabase.rpc('remove_duplicate_settlement', { p_settlement_id: settlementId })
      if (error) throw toRpcError(error, 'Could not remove the duplicate')
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
      // Only a payment recorded as paid asks the receiver to confirm; recording
      // it as received (single or batch) sends nothing.
      if (to === 'marked_paid') void notifyPaymentEventAndRefresh(queryClient, tripId, data.id, 'paid')
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

// ---------------------------------------------------------------------------
// "It hasn't arrived": receiver says no in the app; payer asks again or takes it back.
// Needs 20261121090000_payment_receipt_dispute.sql; the UI hides these actions until a settlement row
// carries `receipt_disputed_at` (see paymentDispute.ts).
// ---------------------------------------------------------------------------

/** Receiver: flag a marked-paid payment as not received, then email the payer. */
export function useReceiverDisputeReceipt(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string): Promise<Settlement> => {
      const { data, error } = await supabase
        .from('settlements')
        .update({ receipt_disputed_at: new Date().toISOString() })
        .eq('id', settlementId)
        .eq('status', 'marked_paid')
        .is('receipt_disputed_at', null)
        .select()
        .maybeSingle()
      if (error) throw toRpcError(error, "Couldn't tell the payer")
      if (data) {
        void notifyPaymentEventAndRefresh(queryClient, tripId, data.id, 'disputed')
        return data
      }
      const { data: current, error: readError } = await supabase.from('settlements').select().eq('id', settlementId).maybeSingle()
      if (readError) throw readError
      if (current && current.status === 'marked_paid' && current.receipt_disputed_at) return current // already said
      throw new Error('This payment has changed, so it could not be updated. Reload to see where it stands.')
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/**
 * What to tell the payer when "ask again" did not happen. payment-notice answers 409 with a `reason` for refusals
 * (reask_limit, not_disputed, wrong_state, capped), 502 when our side failed, 403 when it is not theirs to do.
 */
export function askAgainErrorMessage(status: number | null | undefined, reason: string | null | undefined, receiverName: string): string {
  if (reason === 'reask_limit') return "You've already asked twice — ask an organizer to help"
  if (reason === 'not_disputed') return `${receiverName} has already replied, so there is nothing to ask again. Reload to see where it stands.`
  if (reason === 'wrong_state') return 'This payment has changed since you opened it. Reload to see where it stands.'
  if (reason === 'capped') return `We can't send another email to ${receiverName} right now. Ask an organizer to help.`
  if (status === 403) return "You can't ask again for this payment. Ask an organizer to help."
  if (status === 404) return "Asking again isn't available yet."
  return "Couldn't ask again. Check your connection and try again."
}

/**
 * Payer (or an organizer): "I've sent it — ask again". Server side only: payment-notice 're_ask' checks the caps,
 * clears the flag and issues the receiver's fresh link in one step, then emails them. Not fire-and-forget: the
 * mutation succeeds ONLY when the function answered 200, so the UI never says "asked" when nothing happened.
 * (A payer cannot clear the flag with a direct update: the database refuses it.)
 */
export function useAskReceiverAgain(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ settlementId, receiverName }: { settlementId: string; receiverName: string }): Promise<void> => {
      const outcome = await invokePaymentNotice(settlementId, 're_ask')
      if (!outcome.ok) throw new Error(askAgainErrorMessage(outcome.status, outcome.reason, receiverName))
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}

/** Payer (or an organizer): "I haven't paid yet". Back to suggested; the database resets the payment details. */
export function useRetractPayment(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settlementId: string): Promise<Settlement> => {
      const { data, error } = await supabase
        .from('settlements')
        .update({ status: 'suggested' }) // the database resets the details and the flag, and stamps last_retracted_at
        .eq('id', settlementId)
        .eq('status', 'marked_paid')
        .select()
        .maybeSingle()
      if (error) throw toRpcError(error, "Couldn't undo this payment")
      if (data) {
        void notifyPaymentEventAndRefresh(queryClient, tripId, data.id, 'retracted')
        return data
      }
      const { data: current, error: readError } = await supabase.from('settlements').select().eq('id', settlementId).maybeSingle()
      if (readError) throw readError
      if (current && current.status === 'suggested') return current
      throw new Error("This payment couldn't be undone: it may have been confirmed, or you don't have permission.")
    },
    onSettled: () => invalidateSettlementState(queryClient, tripId),
  })
}
