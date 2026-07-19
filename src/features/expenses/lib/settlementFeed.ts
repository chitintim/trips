/**
 * Settlements as first-class Money-feed entries ("in a sense they are just
 * P2P transactions"): pure selectors that decide WHICH settlement rows
 * belong in the day-grouped feed, how they respond to the existing filter
 * chips, and how they interleave with expenses by day — so mid-trip
 * payments (pre-payments, paying someone back at dinner) are visible in the
 * same chronological stream as the spending they relate to, instead of
 * hiding inside the Settle-up screen until the end of the trip.
 *
 * Status semantics (mirrors computeBalances' settlement loop exactly):
 *   - 'confirmed' (and legacy no-status rows): a real transfer that already
 *     happened — counted in balances, shown as a normal feed payment.
 *   - 'marked_paid': the payer says they've paid but the recipient hasn't
 *     confirmed — NOT counted in balances yet, so it's shown distinctly as
 *     pending rather than hidden (hiding it invites double-payment).
 *   - 'suggested': a freeze-flow proposal, not a payment at all — never
 *     shown in the feed (it lives in Settle-up's pending-action UI).
 */
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ExpenseFilterState } from '../expenses-tab/ExpenseFilters'

/** Date-only (YYYY-MM-DD) key a settlement groups under: when the money moved (settled_at), falling back to when the row was created. */
export function settlementFeedDate(settlement: Settlement): string {
  return (settlement.settled_at || settlement.created_at || '').slice(0, 10)
}

/** True for rows that represent money that (at least allegedly) moved: confirmed/legacy rows and marked_paid ones. 'suggested' proposals are excluded — they're plans, not payments. */
export function isFeedSettlement(settlement: Settlement): boolean {
  return settlement.status !== 'suggested'
}

/** True for payer-claimed transfers the recipient hasn't confirmed yet — shown in the feed, flagged as pending, NOT counted in balances (matches computeBalances). */
export function isPendingSettlement(settlement: Settlement): boolean {
  return settlement.status === 'marked_paid'
}

/**
 * Applies the Money filter chips to settlements the same way
 * applyExpenseFilters applies them to expenses. Person ("Mine") matches
 * either side of the transfer; currency matches the settlement's own
 * currency (defaulting to trip base — settlements are recorded in base
 * currency, see computeBalances). Category and unclaimed-only are
 * expense-only concepts, so either being active excludes ALL settlements —
 * a "🍕 Food" filter should show food spending, not transfers.
 */
export function applySettlementFilters(
  settlements: Settlement[],
  filters: ExpenseFilterState,
  baseCurrency: string
): Settlement[] {
  if (filters.category || filters.unclaimedOnly) return []
  return settlements.filter((s) => {
    if (filters.personId && s.from_user_id !== filters.personId && s.to_user_id !== filters.personId) return false
    if (filters.currency && (s.currency || baseCurrency) !== filters.currency) return false
    return true
  })
}

export interface MoneyFeedDayGroup {
  date: string
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
}

/**
 * Day-groups expenses AND settlements into one merged, descending-date
 * feed. Mirrors groupExpensesByDay's ordering exactly (so days that only
 * contain expenses render identically to before); a day can now also exist
 * purely because payments happened on it (e.g. a pre-trip "everyone pays
 * the organizer" day with no expenses). Within a day, settlements keep
 * settled_at order (oldest first) so multiple same-day transfers read in
 * the order they happened.
 */
export function groupMoneyFeedByDay(expenses: ExpenseWithDetails[], settlements: Settlement[]): MoneyFeedDayGroup[] {
  const byDate = new Map<string, MoneyFeedDayGroup>()
  const groupFor = (date: string): MoneyFeedDayGroup => {
    let group = byDate.get(date)
    if (!group) {
      group = { date, expenses: [], settlements: [] }
      byDate.set(date, group)
    }
    return group
  }
  for (const e of expenses) {
    groupFor(e.payment_date).expenses.push(e)
  }
  const sortedSettlements = [...settlements].sort((a, b) => (a.settled_at < b.settled_at ? -1 : a.settled_at > b.settled_at ? 1 : 0))
  for (const s of sortedSettlements) {
    const date = settlementFeedDate(s)
    if (!date) continue // defensive: a row with no usable timestamp can't be day-grouped
    groupFor(date).settlements.push(s)
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
