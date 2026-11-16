/**
 * Public surface of the To-dos feature — shared travel to-dos ("book flights",
 * "get visa") and the bring list as ONE grouped sheet (Yours / Everyone / With
 * others / Up for grabs / Done), each with an explicit Who: Everyone, a named
 * person, or Anyone (first to grab it).
 */
export { ActionsSheet } from './components/ActionsSheet'
export type { ActionsSheetProps } from './components/ActionsSheet'
export { TodoRow } from './components/TodoRow'
export type { TodoRowProps } from './components/TodoRow'
export { buildTodoViews, groupTodos, actionWhoMode } from './lib/todoModel'
export type { TodoView, TodoGroups } from './lib/todoModel'

export {
  resolveDueDate,
  daysUntilDue,
  isOverdue,
  actionUrgency,
  countdownBadgeVariant,
  isActionCompleteForUser,
  isActionOpenForUser,
  openActionCountForUser,
  isGroupComplete,
  countdownLabel,
} from './lib/actionStatus'
export type { ActionRow as ActionRowType, ActionCompletionRow, ActionWithCompletions, TripForActionStatus } from './lib/actionStatus'
