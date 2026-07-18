// Pure date-math helpers for the trip_actions chase loop (Task D). Kept
// separate from index.ts so they're unit-testable without spinning up the
// edge function's Deno.serve handler or a service-role client.

/** A minimal shape of the fields we need off a trip_actions row. */
export interface ActionDueDateInput {
  deadline_kind: 'fixed' | 'before_trip'
  due_date: string | null
  tripStartDate: string | null
}

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
 * True when the effective due date is already overdue (< now) or falls
 * within the next `lookaheadHours` (mirrors the existing poll-deadline
 * 48h lookahead in index.ts section b).
 */
export function isActionDueOrOverdue(dueDateStr: string, now: Date, lookaheadHours = 48): boolean {
  const due = new Date(dueDateStr + 'T00:00:00Z')
  const lookaheadMs = lookaheadHours * 3600_000
  return due.getTime() - now.getTime() < lookaheadMs
}

/** True when the effective due date is strictly in the past relative to `now`. */
export function isActionOverdue(dueDateStr: string, now: Date): boolean {
  const due = new Date(dueDateStr + 'T00:00:00Z')
  return due.getTime() < now.getTime()
}
