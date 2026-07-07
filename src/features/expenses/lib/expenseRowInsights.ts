/**
 * Pure presentation logic for a single expense-feed row (UX_REDESIGN.md
 * Part 4 "Money: balance-first" + user feedback: "money part doesn't feel
 * space efficient" / "not immediately clear who paid and who is liable").
 *
 * Three things a row needs to answer at a glance, each backed by a pure
 * function here so ExpenseCard/ExpenseFeed stay dumb renderers:
 *   1. Who is on the hook for this line at all (`computeLiableUserIds`) --
 *      splits for a normal expense, claims for an itemized one.
 *   2. The one-sentence "who paid / what that means for the group" meta
 *      line (`buildExpenseMetaSentence`).
 *   3. "What does this mean for ME" -- the personal-stake chip
 *      (`computeExpenseStake`), which also doubles as the single source of
 *      truth for "is the viewer involved at all" (uninvolved rows render
 *      muted -- see ExpenseCard).
 *
 * All money math goes through src/lib/money (integer minor units) exactly
 * like lib/balances.ts, but deliberately stays in the EXPENSE'S OWN
 * currency (not base) -- the stake chip and day-header total serve
 * different purposes: a per-row "what do I owe on THIS line" reads best in
 * the currency the line was actually paid in, matching the row's primary
 * amount (plan point 1); the day-header total is a cross-currency sum so
 * it must go through base currency (`computeDayGroupSummary`, reusing
 * `computeBalances` for the same conversion the rest of the app trusts).
 */
import { toMinorUnits, sumMinorUnits } from '../../../lib/money'
import { computeBalances, BALANCE_EPSILON_MINOR } from './balances'
import { isItemizedExpense } from '../types'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

// ============================================================================
// Liable set
// ============================================================================

/**
 * Who is "on the hook" for an expense: unique split user_ids for a normal
 * expense, unique claim user_ids for an itemized one (line items with no
 * claims yet contribute nobody -- see the "tagged" set below for that
 * case). Order follows first-appearance in the underlying rows.
 */
export function computeLiableUserIds(expense: ExpenseWithDetails): string[] {
  const source = isItemizedExpense(expense) ? expense.claims.map((c) => c.user_id) : expense.splits.map((s) => s.user_id)
  return Array.from(new Set(source))
}

// ============================================================================
// Meta sentence ("You paid · split 4 ways" / "Alex paid · split with you +2")
// ============================================================================

export interface ExpenseMetaSentenceInput {
  /** Display name to use when the viewer did not pay ("Alex", "Sarah paid"...). */
  payerName: string
  payerId: string
  viewerId: string | undefined
  /** From `computeLiableUserIds` -- splits for normal expenses, claims for itemized. */
  liableUserIds: string[]
  isItemized: boolean
  /** Itemized only: expense.participant_ids -- who's expected to claim, whether or not they have yet. */
  taggedUserIds?: string[]
}

/**
 * Builds the explicit line-2 sentence (plan point 1). Three shapes for a
 * normal split expense:
 *   - viewer paid: "You paid · split N ways"
 *   - viewer paid alone (no other liable party): "You paid · just for you"
 *   - someone else paid, viewer shares the bill: "Alex paid · split with you +2"
 *   - someone else paid, viewer isn't in it: "Sarah paid · you're not in this"
 *
 * Itemized expenses get one extra nuance ahead of the generic branches:
 * a viewer who's tagged (participant_ids) but hasn't claimed their items
 * yet is NOT "not in this" (that reads as uninvolved, which is wrong --
 * they still owe a claim) -- and a receipt nobody has claimed at all reads
 * as "not claimed yet" rather than falsely implying nobody is involved.
 */
export function buildExpenseMetaSentence({
  payerName,
  payerId,
  viewerId,
  liableUserIds,
  isItemized,
  taggedUserIds = [],
}: ExpenseMetaSentenceInput): string {
  const viewerIsPayer = !!viewerId && viewerId === payerId
  const payerLabel = viewerIsPayer ? 'You' : payerName
  const viewerInLiable = !!viewerId && liableUserIds.includes(viewerId)

  if (isItemized && !viewerIsPayer && !viewerInLiable) {
    const viewerTagged = !!viewerId && taggedUserIds.includes(viewerId)
    if (viewerTagged) return `${payerLabel} paid · you haven't claimed yet`
    if (liableUserIds.length === 0) return `${payerLabel} paid · not claimed yet`
    return `${payerLabel} paid · you're not in this`
  }

  if (viewerIsPayer) {
    const n = liableUserIds.length
    return n <= 1 ? `${payerLabel} paid · just for you` : `${payerLabel} paid · split ${n} ways`
  }

  if (!viewerInLiable) {
    return `${payerLabel} paid · you're not in this`
  }

  const otherCount = liableUserIds.length - 1
  return otherCount > 0 ? `${payerLabel} paid · split with you +${otherCount}` : `${payerLabel} paid · split with you`
}

// ============================================================================
// Personal-stake chip ("you owe £12.50" / "you're owed £30" / "claim yours")
// ============================================================================

export type ExpenseStake =
  | { kind: 'owe' | 'owed'; amountMinor: number; currency: string; involved: true }
  | { kind: 'claim'; involved: true }
  | { kind: null; involved: boolean }

function sumOthersMinor(
  rows: Array<{ user_id: string; amount: number }>,
  payerId: string,
  currency: string
): number {
  return sumMinorUnits(rows.filter((r) => r.user_id !== payerId).map((r) => toMinorUnits(r.amount, currency)))
}

/**
 * The single-row equivalent of `computeBalances`, in the expense's own
 * currency: what THIS line means for the viewer specifically. `involved`
 * is the source of truth for "should this row render muted" (plan point 3)
 * -- it's true whenever the viewer paid, owes a share, or (itemized) is
 * tagged to claim, even when the resulting amount happens to be ~0.
 */
export function computeExpenseStake(expense: ExpenseWithDetails, viewerId: string | undefined): ExpenseStake {
  if (!viewerId) return { kind: null, involved: false }

  const itemized = isItemizedExpense(expense)
  const viewerIsPayer = expense.paid_by === viewerId
  const currency = expense.currency

  if (itemized) {
    if (viewerIsPayer) {
      const othersMinor = sumOthersMinor(
        expense.claims.map((c) => ({ user_id: c.user_id, amount: c.amount_owed })),
        viewerId,
        currency
      )
      if (othersMinor > BALANCE_EPSILON_MINOR) return { kind: 'owed', amountMinor: othersMinor, currency, involved: true }
      return { kind: null, involved: true }
    }

    const viewerClaim = expense.claims.find((c) => c.user_id === viewerId)
    if (viewerClaim) {
      const mineMinor = toMinorUnits(viewerClaim.amount_owed, currency)
      if (mineMinor > BALANCE_EPSILON_MINOR) return { kind: 'owe', amountMinor: mineMinor, currency, involved: true }
      return { kind: null, involved: true }
    }

    const tagged = !!expense.participant_ids?.includes(viewerId)
    if (tagged) return { kind: 'claim', involved: true }
    return { kind: null, involved: false }
  }

  if (viewerIsPayer) {
    const othersMinor = sumOthersMinor(
      expense.splits.map((s) => ({ user_id: s.user_id, amount: s.amount })),
      viewerId,
      currency
    )
    if (othersMinor > BALANCE_EPSILON_MINOR) return { kind: 'owed', amountMinor: othersMinor, currency, involved: true }
    return { kind: null, involved: true }
  }

  const viewerSplit = expense.splits.find((s) => s.user_id === viewerId)
  if (viewerSplit) {
    const mineMinor = toMinorUnits(viewerSplit.amount, currency)
    if (mineMinor > BALANCE_EPSILON_MINOR) return { kind: 'owe', amountMinor: mineMinor, currency, involved: true }
    return { kind: null, involved: true }
  }

  return { kind: null, involved: false }
}

// ============================================================================
// Day-group header (plan point 4: "Tue 30 Dec · 5 expenses · £340")
// ============================================================================

export interface DayGroupSummary {
  count: number
  /** Base-currency minor-unit total, via the SAME conversion `computeBalances` uses. */
  totalMinor: number
  currency: string
  /** True if any expense in the day couldn't be converted (missing fx_rate) -- total excludes them, never silently zeros them. */
  hasMissingRate: boolean
}

/**
 * Reuses `computeBalances` (with no settlements/participants -- only
 * `groupTotalMinor` is needed) rather than re-deriving the fx-rate
 * resolution rules a second time, so a day's total can never drift from
 * the headline balances shown elsewhere for the same expenses.
 */
export function computeDayGroupSummary(dayExpenses: ExpenseWithDetails[], baseCurrency: string): DayGroupSummary {
  const { groupTotalMinor, expensesMissingRate } = computeBalances(dayExpenses, [], [], baseCurrency)
  return {
    count: dayExpenses.length,
    totalMinor: groupTotalMinor,
    currency: baseCurrency,
    hasMissingRate: expensesMissingRate.length > 0,
  }
}

// ============================================================================
// Day label classification (plan point 4: pre-trip / post-trip / in-trip)
// ============================================================================

export type DayLabelKind = 'pre-trip' | 'post-trip' | 'in-trip'

/** Compares date-only strings (YYYY-MM-DD) -- see UX_REDESIGN.md Part 3 calendar edge case #6 ("pre/post-trip expenses ... always included in money math"). */
export function classifyDayLabel(date: string, tripStartDate: string, tripEndDate: string): DayLabelKind {
  if (date < tripStartDate.slice(0, 10)) return 'pre-trip'
  if (date > tripEndDate.slice(0, 10)) return 'post-trip'
  return 'in-trip'
}

/** Date-only (YYYY-MM-DD) string compare -- a day is "past" once it's strictly before today's local date. */
export function isPastDate(date: string, todayDateOnly: string): boolean {
  return date.slice(0, 10) < todayDateOnly.slice(0, 10)
}

/** Today's date-only string in LOCAL time (trip dates are destination-local naive, see UX_REDESIGN.md Part 3 #8). */
export function todayDateOnly(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
