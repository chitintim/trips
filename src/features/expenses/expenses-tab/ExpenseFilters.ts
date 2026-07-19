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

// Day-grouping for the feed lives in lib/settlementFeed.ts
// (groupMoneyFeedByDay), which supersedes the old expense-only
// groupExpensesByDay now that settlements interleave into the same feed.
