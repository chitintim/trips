/**
 * Pure rules for receipts that still have unclaimed value when someone tries
 * to freeze balances (receipts v2, slice 1B). No React, no Supabase.
 *
 * The server refuses to freeze while an itemised receipt has value left on a
 * line (hint `unclaimed_receipts`); the UI runs the check first (minus legacy
 * rounding dust, see isLineReallyUnclaimed) so it can open a dialog instead of
 * showing an error.
 */
import { formatMoneyMinor } from '../lib/formatMoney'
import type { ReceiptClaimStatus } from '../lib/balances'
import type { LeftoverMode } from '../../../lib/queries/useExpenses'

export const UNCLAIMED_HINT = 'unclaimed_receipts'
export const OVERCLAIMED_HINT = 'overclaimed_receipts'

export const FREEZE_DIALOG_TITLE = "Some receipts aren't fully claimed"
export const FREEZE_DIALOG_INTRO = "Whatever isn't claimed has to belong to someone before balances are frozen."
export const NOTICE_TITLE = 'Receipts with items nobody has claimed'
export const NOTICE_MANAGER_LIVE = "Until they're shared, the payer is counted as owing that money. Ask people to claim, or share what's left before freezing."
export const NOTICE_PAYER_LIVE = "Until it's shared, it's counted as yours."
export const CHOICE_EVERYONE = 'Share between everyone on the receipt'
export const CHOICE_EVERYONE_RECOMMENDED = `${CHOICE_EVERYONE} (recommended)`
export const CHOICE_PERSON = 'Assign to someone…'
export const CHOICE_PAYER_SELF = "I'll cover it"
export const APPLY_TO_ALL = 'Apply to all receipts'
export const APPLY_AND_FREEZE = 'Share leftovers and freeze'
export const SERVER_REPORT_UNCLAIMED_TITLE = 'Some receipts still have unclaimed items'
export const SERVER_REPORT_OVERCLAIMED_TITLE = 'Some receipts have more claimed than they are worth'
export const SERVER_REPORT_UNCLAIMED_INTRO = "This screen may be out of date. Refresh to load the latest claims, then try again."
export const SERVER_REPORT_OVERCLAIMED_INTRO = 'On these receipts an item has more claimed than it costs, so people would be charged too much. Open each receipt, fix who had what (or share the leftovers again), then refresh and try again.'
export const SERVER_REFUSED_NOTE = "Balances weren't frozen, because some receipts still have unclaimed items."

/** "Dinner at X — €48.00 not claimed". */
export function notClaimedLine(r: Pick<ReceiptClaimStatus, 'description' | 'unclaimedOwnMinor' | 'currency'>): string {
  return `${r.description} — ${formatMoneyMinor(r.unclaimedOwnMinor, r.currency)} not claimed`
}

/**
 * Who sees the notice and which receipts it lists: people who can manage the
 * trip see every receipt; everyone else sees only the receipts they paid for.
 */
export function receiptsForNotice<T extends Pick<ReceiptClaimStatus, 'paidBy'>>(receipts: T[], viewerId: string | undefined, canManageTrip: boolean): T[] {
  if (canManageTrip) return receipts
  return viewerId ? receipts.filter((r) => r.paidBy === viewerId) : []
}

export type FreezeGate = { kind: 'proceed' } | { kind: 'dialog'; receipts: ReceiptClaimStatus[] }

/** Freeze proceeds only when nothing is left to place, or when the leftovers function is not live yet (fail soft). */
export function freezeGate(receipts: ReceiptClaimStatus[]): FreezeGate {
  if (receipts.length === 0) return { kind: 'proceed' }
  return { kind: 'dialog', receipts }
}

/** The server's refusal (hint `unclaimed_receipts`, or its wording) as an error from the freeze call. */
export function isUnclaimedReceiptsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { hint, message } = err as { hint?: unknown; message?: unknown }
  if (hint === UNCLAIMED_HINT) return true
  return typeof message === 'string' && /still have unclaimed items|unclaimed_receipts/i.test(message)
}

/** The server refused because a line has more claimed than it is worth (hint overclaimed_receipts). */
export function isOverclaimedReceiptsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { hint, message } = err as { hint?: unknown; message?: unknown }
  if (hint === OVERCLAIMED_HINT) return true
  return typeof message === 'string' && /more claimed on an item than it is worth/i.test(message)
}

export interface ServerReceiptItem {
  id: string
  description: string
  /** Own-currency minor units the server reported (unclaimed or over-claimed), or null. */
  amountMinor: number | null
}

export interface ServerReceiptReport {
  kind: 'unclaimed' | 'overclaimed'
  items: ServerReceiptItem[]
}

/** The receipts listed in the freeze error's DETAIL (a JSON array written by freeze_settlements); [] when absent or malformed. */
export function parseServerReceiptDetail(err: unknown): ServerReceiptItem[] {
  const raw = err && typeof err === 'object' ? (err as { details?: unknown; detail?: unknown }).details ?? (err as { detail?: unknown }).detail : null
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((x): ServerReceiptItem[] => {
      if (!x || typeof x !== 'object') return []
      const o = x as { id?: unknown; description?: unknown; unclaimed_minor?: unknown; overclaimed_minor?: unknown }
      if (typeof o.id !== 'string') return []
      const amount = typeof o.unclaimed_minor === 'number' ? o.unclaimed_minor : typeof o.overclaimed_minor === 'number' ? o.overclaimed_minor : null
      return [{ id: o.id, description: typeof o.description === 'string' ? o.description : 'A receipt', amountMinor: amount }]
    })
  } catch {
    return []
  }
}

export type LeftoverChoice = { mode: Exclude<LeftoverMode, 'same'>; userId?: string }

export function choiceIsComplete(c: LeftoverChoice | undefined): c is LeftoverChoice {
  return !!c && (c.mode !== 'person' || !!c.userId)
}

/** One choice for every receipt. A person choice only applies where that person is on the receipt (otherwise it is left open). */
export function applyChoiceToAll(
  receipts: Array<Pick<ReceiptClaimStatus, 'expenseId'>>,
  choice: LeftoverChoice,
  canAssign: (expenseId: string, userId: string) => boolean = () => true
): Record<string, LeftoverChoice> {
  const out: Record<string, LeftoverChoice> = {}
  for (const r of receipts) {
    if (choice.mode === 'person' && choice.userId && !canAssign(r.expenseId, choice.userId)) continue
    out[r.expenseId] = { ...choice }
  }
  return out
}

export interface ApplyStep {
  expenseId: string
  currency: string
  mode: Exclude<LeftoverMode, 'same'>
  userId: string | null
}

/** The calls to make, in the receipts' order, or the receipts still missing a (complete) choice. */
export function planApplication(
  receipts: ReceiptClaimStatus[],
  choices: Record<string, LeftoverChoice | undefined>
): { steps: ApplyStep[]; missing: string[] } {
  const steps: ApplyStep[] = []
  const missing: string[] = []
  for (const r of receipts) {
    const c = choices[r.expenseId]
    if (!choiceIsComplete(c)) missing.push(r.expenseId)
    else steps.push({ expenseId: r.expenseId, currency: r.currency, mode: c.mode, userId: c.mode === 'person' ? c.userId ?? null : null })
  }
  return { steps, missing }
}

export interface ApplyOutcome {
  done: string[]
  failed: Array<{ expenseId: string; message: string }>
}

export function summariseApplication(outcome: ApplyOutcome, total: number): { tone: 'success' | 'warning' | 'error'; message: string } {
  if (outcome.failed.length === 0) return { tone: 'success', message: total === 1 ? 'Leftovers shared' : `Leftovers shared on ${total} receipts` }
  if (outcome.done.length === 0) return { tone: 'error', message: "Couldn't share the leftovers" }
  return { tone: 'warning', message: `Shared ${outcome.done.length} of ${total} receipts — ${outcome.failed.length} need another look` }
}

/** Labels for the third choice: the payer says "I'll cover it", a manager acting for them says "<Name> covers it". */
export function coverChoiceLabel(viewerId: string | undefined, payerId: string, payerName: string): string {
  return viewerId === payerId ? CHOICE_PAYER_SELF : `${payerName} covers it`
}
