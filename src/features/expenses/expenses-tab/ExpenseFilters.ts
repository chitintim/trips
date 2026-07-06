/**
 * Filter state + application logic for the expenses list (plan §10 #5):
 * chips for category/person/currency/unclaimed. Pure so it's trivially
 * testable and reusable between the tab and any future embedded view.
 */
import { isItemizedExpense } from '../types'
import { summarizeOverallProgress } from '../claims/claimMath'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface ExpenseFilterState {
  category: string | null
  personId: string | null
  currency: string | null
  unclaimedOnly: boolean
}

export const EMPTY_FILTERS: ExpenseFilterState = { category: null, personId: null, currency: null, unclaimedOnly: false }

export function applyExpenseFilters(expenses: ExpenseWithDetails[], filters: ExpenseFilterState): ExpenseWithDetails[] {
  return expenses.filter((e) => {
    if (filters.category && e.category !== filters.category) return false
    if (filters.currency && e.currency !== filters.currency) return false
    if (filters.personId) {
      const involved =
        e.paid_by === filters.personId ||
        e.splits.some((s) => s.user_id === filters.personId) ||
        e.claims.some((c) => c.user_id === filters.personId)
      if (!involved) return false
    }
    if (filters.unclaimedOnly) {
      if (!isItemizedExpense(e)) return false
      const progress = summarizeOverallProgress(e.line_items, e.claims)
      if (progress.isFullyAllocated) return false
    }
    return true
  })
}

/** Groups expenses by payment_date (descending), for the day-grouped card list (plan §10 #5). */
export function groupExpensesByDay(expenses: ExpenseWithDetails[]): Array<{ date: string; expenses: ExpenseWithDetails[] }> {
  const byDate = new Map<string, ExpenseWithDetails[]>()
  for (const e of expenses) {
    const list = byDate.get(e.payment_date) || []
    list.push(e)
    byDate.set(e.payment_date, list)
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, exps]) => ({ date, expenses: exps }))
}
