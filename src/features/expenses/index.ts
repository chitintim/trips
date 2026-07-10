/**
 * Public surface of the expenses feature, for the coordinator to wire into
 * TripDetail.tsx / App.tsx (per the workstream contract -- this file does
 * NOT import TripDetail or App, and nothing outside src/features/expenses
 * should reach into subfolders directly).
 *
 * Exports:
 *   - MoneySpace: the v3 balance-first Money hub (UX_REDESIGN.md Part 4
 *     "Money: balance-first, no inner tabs") -- position header, filter
 *     chips, day-grouped feed, Settle-up as a STATE card/pushed screen, My
 *     Spending pushed from "see my breakdown". This is what TripDetail
 *     renders for the Money space now.
 *   - QuickCaptureSheet: the shell's "+" FAB target for this feature.
 *     Mount with a fresh `key` per open (e.g. an incrementing counter) so
 *     no previous capture's state leaks in.
 */
export { MoneySpace } from './money-space/MoneySpace'
export type { MoneySpaceProps } from './money-space/MoneySpace'
export { computeMoneyPosition } from './money-space/moneyPosition'
export type { MoneyPosition, MoneyPositionKind, MoneyPositionPersonRow } from './money-space/moneyPosition'

export { QuickCaptureSheet } from './quick-capture/QuickCaptureSheet'
export type { QuickCaptureSheetProps } from './quick-capture/QuickCaptureSheet'

export { ExpenseEditorWizard } from './editor/ExpenseEditorWizard'
export type { ExpenseEditorWizardProps } from './editor/ExpenseEditorWizard'

export { ClaimPage } from './claims/ClaimPage'

// Balance math, exposed for Today's "you owe / are owed" chip and settle
// status card (UX_REDESIGN Part 2) — same functions the Money tabs use, so
// the figures always agree.
export { computeBalances, splitOwedAmounts } from './lib/balances'
export type { ParticipantBalance, BalanceComputationResult } from './lib/balances'
