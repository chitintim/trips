/**
 * Shared local types for the expenses feature. Re-exports/aliases from the
 * generated database types + query hooks so components import from one
 * place within this feature folder.
 */
import type { Enums } from '../../types/database.types'
import type { ExpenseWithDetails } from '../../lib/queries/useExpenses'

export type ExpenseCategory = Enums<'expense_category'>
export type ExpenseStatus = Enums<'expense_status'>
export type SplitType = Enums<'split_type'>

export type { ExpenseWithDetails }

/** Split UI mode -- 'itemized' is not an expense_splits.split_type value (itemized expenses have no split rows, they use line items + claims instead) but is a first-class choice in the split step. */
export type SplitMode = 'equal' | 'custom' | 'percentage' | 'shares' | 'itemized'

export function isItemizedExpense(expense: ExpenseWithDetails): boolean {
  return !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0
}
