/**
 * Shared "days until a date" math, extracted from three near-identical
 * implementations (CountdownHero, TripCard, TripDetail's getCountdown) that
 * had each hand-rolled their own local-midnight diff with slightly
 * different rounding. All three now compute off local midnight so the
 * count doesn't flicker between values within the same day.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days from `from` (default: now) until `dateStr` (a `YYYY-MM-DD`
 * date, interpreted at local midnight). Negative when `dateStr` is in the
 * past. Never NaN for a well-formed date string.
 */
export function daysUntil(dateStr: string, from: Date = new Date()): number {
  const target = new Date(dateStr + 'T00:00:00')
  const today = new Date(from)
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / MS_PER_DAY)
}

/** Non-negative variant (clamped to 0) for "days to go" style countdowns. */
export function daysUntilClamped(dateStr: string, from: Date = new Date()): number {
  return Math.max(0, daysUntil(dateStr, from))
}

// ============================================================================
// DEADLINE URGENCY — single source of truth for countdown-chip thresholds
// ============================================================================

/**
 * Urgency bucket for a deadline countdown chip:
 * - overdue: the deadline has passed (red)
 * - urgent:  due within URGENT_WITHIN_DAYS days, inclusive (red)
 * - soon:    due within SOON_WITHIN_DAYS days, inclusive (amber)
 * - normal:  further out (neutral)
 */
export type DeadlineUrgency = 'overdue' | 'urgent' | 'soon' | 'normal'

/** Red when this close (in whole days) or closer. */
export const URGENT_WITHIN_DAYS = 2
/** Amber when this close (in whole days) or closer. */
export const SOON_WITHIN_DAYS = 7

/**
 * Map "whole days left" (e.g. from daysUntil / daysUntilDue) to an urgency
 * bucket. All deadline chips (action rows, Today countdowns, Deadline
 * component) derive their amber/red state from this one function so the
 * thresholds can't drift apart.
 */
export function deadlineUrgency(daysLeft: number): DeadlineUrgency {
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= URGENT_WITHIN_DAYS) return 'urgent'
  if (daysLeft <= SOON_WITHIN_DAYS) return 'soon'
  return 'normal'
}
