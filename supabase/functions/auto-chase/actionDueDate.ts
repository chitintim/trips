// Pure date-math helpers for the trip_actions reminder loop (Task D +
// staged deadline reminders). Kept separate from index.ts so they're
// unit-testable without spinning up the edge function's Deno.serve handler
// or a service-role client.

/** A minimal shape of the fields we need off a trip_actions row. */
export interface ActionDueDateInput {
  deadline_kind: 'fixed' | 'before_trip'
  due_date: string | null
  tripStartDate: string | null
}

const DAY_MS = 24 * 3600_000

/**
 * Effective due date for a trip_action: `due_date` for 'fixed', the trip's
 * `start_date` for 'before_trip'. Returns null when there's no date to chase
 * against (e.g. 'before_trip' on a trip with no start_date yet -- skip it).
 */
export function effectiveActionDueDate(action: ActionDueDateInput): string | null {
  if (action.deadline_kind === 'before_trip') return action.tripStartDate
  return action.due_date
}

/**
 * True when the effective due date's day has fully elapsed relative to `now`
 * -- i.e. now is at or past 24h after the start of the due date (UTC). Due
 * "today" is not overdue; it only becomes overdue once the day is over,
 * matching the client's local-day semantics in actionStatus.ts#isOverdue.
 */
export function isActionOverdue(dueDateStr: string, now: Date): boolean {
  const due = new Date(dueDateStr + 'T00:00:00Z')
  return due.getTime() + DAY_MS <= now.getTime()
}

/**
 * Staged reminder ladder for action deadlines. Each open action earns at
 * most three reminder emails per user, one per stage (uniqueness enforced
 * by trip_action_reminders' primary key):
 *   - 'd7'      ~7 days before the due date (due within the next 7 days,
 *               but not yet within the d1 window);
 *   - 'd1'      ~1 day before (due tomorrow or today);
 *   - 'overdue' once the due day has fully elapsed (isActionOverdue).
 * Returns the stage the action is CURRENTLY in, or null when the due date
 * is still more than 7 days out. If an action is created late (e.g. 3 days
 * before its deadline), earlier stages are simply never sent.
 */
export type ActionReminderStage = 'd7' | 'd1' | 'overdue'

export function actionReminderStage(dueDateStr: string, now: Date): ActionReminderStage | null {
  if (isActionOverdue(dueDateStr, now)) return 'overdue'
  const dueStart = new Date(dueDateStr + 'T00:00:00Z').getTime()
  const msUntilDueStart = dueStart - now.getTime()
  if (msUntilDueStart <= DAY_MS) return 'd1' // due today or tomorrow
  if (msUntilDueStart <= 7 * DAY_MS) return 'd7'
  return null
}

/**
 * Human status label for the email's status chip: "Overdue", "Due today",
 * "Due tomorrow", "Due in N days". Day counting is calendar-day based (UTC),
 * matching the stage ladder above.
 */
export function actionDueChipLabel(dueDateStr: string, now: Date): string {
  if (isActionOverdue(dueDateStr, now)) return 'Overdue'
  const dueStart = new Date(dueDateStr + 'T00:00:00Z').getTime()
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const days = Math.round((dueStart - todayStart) / DAY_MS)
  if (days <= 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}
