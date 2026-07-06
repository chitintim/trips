/**
 * Public surface of the expenses feature, for the coordinator to wire into
 * TripDetail.tsx / App.tsx (per the workstream contract -- this file does
 * NOT import TripDetail or App, and nothing outside src/features/expenses
 * should reach into subfolders directly).
 *
 * Exports:
 *   - EXPENSE_TAB_CONFIGS: static {tabId,label,icon,Component} entries for
 *     the Expenses / My Spending / Settle Up in-trip tabs. Each Component
 *     takes a single `{ trip }` prop (participants/expenses are fetched
 *     internally via the TanStack hooks) so the coordinator's TripDetail
 *     tab-switch just does `<Component trip={trip} />` -- no per-tab prop
 *     plumbing needed. Map each config's `{icon,label}` into an
 *     `AppShellTabItem` (adding the runtime `isActive`/`onClick` the shell
 *     needs) or into TripDetail's existing in-page sub-tab bar, whichever
 *     integration point is live at wiring time.
 *   - QuickCaptureSheet: the shell's "+" FAB target for this feature.
 *     Mount with a fresh `key` per open (e.g. an incrementing counter) so
 *     no previous capture's state leaks in.
 */
import type { ComponentType } from 'react'
import { ExpensesTab } from './expenses-tab/ExpensesTab'
import { MySpendingTab } from './my-spending/MySpendingTab'
import { SettleUpTab } from './settle-up/SettleUpTab'
import type { Trip } from '../../types'

export { QuickCaptureSheet } from './quick-capture/QuickCaptureSheet'
export type { QuickCaptureSheetProps } from './quick-capture/QuickCaptureSheet'

export { ExpenseEditorWizard } from './editor/ExpenseEditorWizard'
export type { ExpenseEditorWizardProps } from './editor/ExpenseEditorWizard'

export { ClaimPage } from './claims/ClaimPage'

export interface ExpenseTabComponentProps {
  trip: Trip
}

export interface ExpenseTabConfig {
  tabId: string
  label: string
  /** Emoji, matching the existing tab bar's icon convention (see TripDetail.tsx's tripTabs). */
  icon: string
  Component: ComponentType<ExpenseTabComponentProps>
}

export const EXPENSE_TAB_CONFIGS: ExpenseTabConfig[] = [
  { tabId: 'expenses', label: 'Expenses', icon: '💰', Component: ExpensesTab },
  { tabId: 'my-spending', label: 'My Spending', icon: '📊', Component: MySpendingTab },
  { tabId: 'settle-up', label: 'Settle Up', icon: '🤝', Component: SettleUpTab },
]
