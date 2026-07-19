/**
 * Public surface of the Actions feature — shared travel to-dos ("book
 * flights", "get visa"), individual or whole-group, plus the packing/bring
 * list (reused from features/checklists) as a segment of the same launched
 * sheet.
 */
export { ActionsSheet } from './components/ActionsSheet'
export type { ActionsSheetProps } from './components/ActionsSheet'
export { ActionsSection } from './components/ActionsSection'
export type { ActionsSectionProps } from './components/ActionsSection'
export { ActionRow } from './components/ActionRow'
export type { ActionRowProps } from './components/ActionRow'

export {
  resolveDueDate,
  daysUntilDue,
  isOverdue,
  isActionCompleteForUser,
  isGroupComplete,
  countdownLabel,
} from './lib/actionStatus'
export type { ActionRow as ActionRowType, ActionCompletionRow, ActionWithCompletions, TripForActionStatus } from './lib/actionStatus'
