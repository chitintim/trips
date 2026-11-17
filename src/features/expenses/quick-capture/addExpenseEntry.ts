/**
 * Wording for the "Add expense" entry (the Money space's contextual nav button and its sheet).
 * One place so the nav button, the sheet and the Today shortcut cannot drift apart.
 */
import { FROZEN_WRITE_MESSAGE } from '../../../lib/writeRefusals'

export const ADD_EXPENSE_LABEL = 'Add expense'
export const ADD_EXPENSE_NAV_ICON = '＋'
export const SCAN_RECEIPT_CHOICE = {
  label: 'Scan a receipt',
  hint: "Take a photo and we'll read the items",
} as const
export const ENTER_YOURSELF_CHOICE = {
  label: 'Enter it yourself',
  hint: 'Type in the amount, who paid and who shares it',
} as const
export const FROZEN_EXPENSES_MESSAGE = FROZEN_WRITE_MESSAGE

/** The sheet can't take new expenses while balances are frozen (a settlement snapshot exists). */
export function addExpenseBlockedMessage(trip: { settlement_snapshot?: unknown }): string | null {
  return trip.settlement_snapshot ? FROZEN_EXPENSES_MESSAGE : null
}
