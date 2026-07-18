import { daysUntil } from '../../../lib/dates'
import type { Database } from '../../../types/database.types'

export type ActionRow = Database['public']['Tables']['trip_actions']['Row']
export type ActionCompletionRow = Database['public']['Tables']['trip_action_completions']['Row']

/** Minimal completion shape needed for per-user/per-group completeness checks. */
export interface CompletionRef {
  user_id: string
  completed_at: string
}

/** An action row with its (optionally embedded) group-completion rows. */
export type ActionWithCompletions = ActionRow & {
  trip_action_completions?: CompletionRef[] | null
}

/** Minimal trip shape needed to resolve a "before_trip" deadline. */
export interface TripForActionStatus {
  start_date?: string | null
}

/**
 * The due date (a `YYYY-MM-DD` string) an action resolves to, or null when
 * it can't be resolved yet (e.g. a "before_trip" action on a trip whose
 * dates aren't set).
 */
export function resolveDueDate(action: ActionRow, trip: TripForActionStatus | null | undefined): string | null {
  if (action.deadline_kind === 'before_trip') {
    return trip?.start_date ?? null
  }
  return action.due_date ?? null
}

/** Whole days until the action's resolved due date, or null if unresolvable. */
export function daysUntilDue(action: ActionRow, trip: TripForActionStatus | null | undefined): number | null {
  const dueDate = resolveDueDate(action, trip)
  if (!dueDate) return null
  return daysUntil(dueDate)
}

/** True iff the action has a resolved due date strictly before today. Due today is not overdue. */
export function isOverdue(action: ActionRow, trip: TripForActionStatus | null | undefined): boolean {
  const days = daysUntilDue(action, trip)
  if (days === null) return false
  return days < 0
}

/**
 * Whether `userId` has completed this action.
 * - Individual actions (assigned_to set): driven by `completed_at`.
 * - Group actions (assigned_to null): driven by a matching completion row.
 */
export function isActionCompleteForUser(action: ActionWithCompletions, userId: string): boolean {
  if (action.assigned_to) {
    return action.completed_at != null
  }
  const completions = action.trip_action_completions ?? []
  return completions.some((c) => c.user_id === userId)
}

/**
 * Whether a group action is complete for the whole group — every currently
 * active participant has a completion row. Participants who are no longer
 * active (removed/left) never block completeness even without a row.
 */
export function isGroupComplete(action: ActionWithCompletions, activeParticipantIds: string[]): boolean {
  const completions = action.trip_action_completions ?? []
  const completedIds = new Set(completions.map((c) => c.user_id))
  return activeParticipantIds.every((id) => completedIds.has(id))
}

/**
 * Human-readable countdown copy, matching the Today tab's due-soon/overdue
 * tone (e.g. CountdownHero's "N days to go" style, "Due today" for zero).
 */
export function countdownLabel(action: ActionRow, trip: TripForActionStatus | null | undefined): string {
  const days = daysUntilDue(action, trip)
  const prefix = action.deadline_kind === 'before_trip' ? 'Before trip · ' : ''

  if (days === null) return prefix ? 'Before trip' : 'No due date'
  if (days === 0) return `${prefix}Due today`
  if (days < 0) return `${prefix}${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
  return `${prefix}${days} day${days === 1 ? '' : 's'} left`
}
