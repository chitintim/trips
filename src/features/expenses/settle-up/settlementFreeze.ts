import { toMinorUnits } from '../../../lib/money'
import type { Transaction } from '../../../lib/debtMinimization'
import type { Settlement } from '../../../lib/queries/useSettlements'
import { withinDuplicateWindow } from './settleUpLogic'

/**
 * Pure helpers for the server-side freeze / duplicate-removal RPCs
 * (supabase/migrations/20261118100000_settlement_freeze.sql). The maths of
 * WHAT to suggest stays in settleUpLogic; this file only shapes the payload
 * and mirrors the server's duplicate proof so the UI can predict it.
 */

export type SettlementRpcName = 'freeze_settlements' | 'unfreeze_settlements' | 'remove_duplicate_settlement'

export interface FreezeSuggestionPayload {
  from: string
  to: string
  amount: number
  currency: string
}

/** The `p_suggestions` argument: one entry per suggested payment, in the trip's base currency. */
export function buildFreezeSuggestions(transactions: Transaction[], baseCurrency: string): FreezeSuggestionPayload[] {
  return transactions
    .filter((t) => t.amount > 0 && t.from !== t.to)
    .map((t) => ({ from: t.from, to: t.to, amount: t.amount, currency: baseCurrency }))
}

/**
 * True when the RPC is not deployed yet (migration not applied): PostgREST
 * PGRST202 (not in schema cache), Postgres 42883 (undefined function), or a
 * message naming the function. Any OTHER error is real and must be shown, not
 * papered over by the client-side fallback.
 */
export function isSettlementRpcMissing(err: unknown, fn: SettlementRpcName): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'PGRST202' || code === '42883') return true
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  return text.includes(fn) && /(could not find|does not exist|schema cache|not found)/.test(text)
}

export type FreezePath = 'rpc' | 'client'

/** Which path a freeze/unfreeze/remove takes after an RPC attempt: fall back only when the function is missing. */
export function pathAfterRpcError(err: unknown, fn: SettlementRpcName): FreezePath | 'fail' {
  return isSettlementRpcMissing(err, fn) ? 'client' : 'fail'
}

function sameMoney(a: Settlement, b: Settlement, baseCurrency: string): boolean {
  const ca = a.currency ?? baseCurrency
  const cb = b.currency ?? baseCurrency
  return ca === cb && toMinorUnits(a.amount, ca) === toMinorUnits(b.amount, cb)
}

/**
 * Mirrors remove_duplicate_settlement: a settlement may be removed as a
 * duplicate only if it is NOT confirmed and another NON-suggested settlement
 * exists in the same trip with the same payer, payee, amount and currency,
 * created within 24 hours of it. (A suggested row is a proposal, never proof of
 * a repeat.) The organiser chooses which of the two to remove.
 */
export function findProvingDuplicate(target: Settlement, all: Settlement[], baseCurrency: string): Settlement | null {
  if (target.status === 'confirmed') return null
  return (
    all.find(
      (s) =>
        s.id !== target.id &&
        s.trip_id === target.trip_id &&
        s.status !== 'suggested' &&
        withinDuplicateWindow(s, target) &&
        s.from_user_id === target.from_user_id &&
        s.to_user_id === target.to_user_id &&
        sameMoney(s, target, baseCurrency)
    ) ?? null
  )
}

/**
 * The `p_known_paid_ids` argument of freeze_settlements: ids of the
 * non-suggested, non-confirmed rows the client saw when it computed the
 * suggestions. The server refuses if any other such row exists (a payment was
 * marked while the freeze was in flight).
 */
export function knownPaidIds(settlements: Settlement[]): string[] {
  return settlements.filter((s) => s.status !== 'suggested' && s.status !== 'confirmed').map((s) => s.id)
}

/** True when any non-suggested, non-confirmed row is missing from the list the client computed from. */
export function paymentsChangedSince(settlements: Settlement[], known: string[]): boolean {
  const set = new Set(known)
  return settlements.some((s) => s.status !== 'suggested' && s.status !== 'confirmed' && !set.has(s.id))
}

export const FREEZE_BLOCKED_BY_DUPLICATES = 'Sort out the payments recorded twice first (see the notice below), then freeze.'
/** Unfreezing is paused too: after an unfreeze nobody could freeze again until the twins are sorted out. */
export const UNFREEZE_BLOCKED_BY_DUPLICATES = 'Sort out the payments recorded twice first (see the notice below). Unfreezing is paused too, because balances could not be frozen again until they are resolved.'
export const PAYMENTS_CHANGED_MESSAGE = 'Payments changed while you were freezing — try again'

export function canRemoveAsDuplicate(target: Settlement, all: Settlement[], baseCurrency: string): boolean {
  return findProvingDuplicate(target, all, baseCurrency) !== null
}
