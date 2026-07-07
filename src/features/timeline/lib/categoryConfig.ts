/**
 * Per-category icon + accent config for timeline events (plan §Timeline:
 * "per-category icon/color accents"). Colors use the design system's
 * semantic Tailwind v4 scales (accent/success/warn/danger/neutral) rather
 * than one-off hex values, so dark mode keeps working for free.
 */
import type { TimelineEventCategory } from '../../../types'

export interface CategoryStyle {
  emoji: string
  label: string
  /** Tailwind classes for a small badge/dot using this category's accent. */
  badgeClassName: string
  /** Tailwind classes for the left accent bar / icon chip background. */
  accentClassName: string
}

export const CATEGORY_CONFIG: Record<TimelineEventCategory, CategoryStyle> = {
  flight: {
    emoji: '✈️',
    label: 'Flight',
    badgeClassName: 'bg-accent-100 text-accent-800 dark:bg-accent-950 dark:text-accent-300',
    accentClassName: 'bg-accent-500',
  },
  accommodation: {
    emoji: '🏨',
    label: 'Accommodation',
    badgeClassName: 'bg-warn-100 text-warn-800 dark:bg-warn-950 dark:text-warn-300',
    accentClassName: 'bg-warn-500',
  },
  transport: {
    emoji: '🚐',
    label: 'Transport',
    badgeClassName: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300',
    accentClassName: 'bg-neutral-500',
  },
  activity: {
    emoji: '⛷️',
    label: 'Activity',
    badgeClassName: 'bg-success-100 text-success-800 dark:bg-success-950 dark:text-success-300',
    accentClassName: 'bg-success-500',
  },
  dining: {
    emoji: '🍽️',
    label: 'Dining',
    badgeClassName: 'bg-danger-100 text-danger-800 dark:bg-danger-950 dark:text-danger-300',
    accentClassName: 'bg-danger-500',
  },
  transfer: {
    emoji: '🚌',
    label: 'Transfer',
    badgeClassName: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    accentClassName: 'bg-neutral-400',
  },
  meeting_point: {
    emoji: '📍',
    label: 'Meeting Point',
    badgeClassName: 'bg-accent-100 text-accent-700 dark:bg-accent-950 dark:text-accent-300',
    accentClassName: 'bg-accent-400',
  },
  free_time: {
    emoji: '🌴',
    label: 'Free Time',
    badgeClassName: 'bg-success-100 text-success-700 dark:bg-success-950 dark:text-success-300',
    accentClassName: 'bg-success-400',
  },
  other: {
    emoji: '📌',
    label: 'Other',
    badgeClassName: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
    accentClassName: 'bg-neutral-400',
  },
}

export const CATEGORY_OPTIONS: { value: TimelineEventCategory; label: string }[] = (
  Object.keys(CATEGORY_CONFIG) as TimelineEventCategory[]
).map((value) => ({ value, label: `${CATEGORY_CONFIG[value].emoji} ${CATEGORY_CONFIG[value].label}` }))

/** 12h display of a "HH:MM[:SS]" time string, e.g. "14:30" -> "2:30 PM". */
export function formatTime(time: string | null): string {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${displayHour}:${m} ${ampm}`
}

/**
 * Human time-range display for an event: "All day", "2:30 PM", or
 * "2:30 PM - 4:00 PM". Overnight events (end_time < start_time, calendar
 * edge case #4, UX_REDESIGN.md Part 3) are assumed to continue into the
 * next day rather than treated as a data error, and labeled accordingly —
 * see calendarEdgeCases.ts's `isOvernightEvent` for the pure predicate this
 * mirrors.
 */
export function formatTimeRange(allDay: boolean | null, startTime: string | null, endTime: string | null): string {
  if (allDay) return 'All day'
  if (!startTime) return ''
  if (!endTime) return formatTime(startTime)
  const overnight = endTime < startTime
  return `${formatTime(startTime)} - ${formatTime(endTime)}${overnight ? ' → next day' : ''}`
}
