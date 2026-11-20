/**
 * Pure day-grouping / collapse logic for the Timeline tab (plan §6.5,
 * §Form & Flow Standard). Extracted from the legacy TimelineTab.tsx so the
 * date-range math and the "smart default collapse" behaviour (past days
 * collapsed, today prominent, future expanded) are independently testable
 * without mounting React.
 */
import type { TimelineEvent } from '../../../types'
import { addDays, boardDays, dayHeaderLabel, placeDate } from '../../../lib/tripWindow'

/** Format a Date as a local (not UTC) YYYY-MM-DD string. */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Every calendar date from startDate to endDate inclusive, both YYYY-MM-DD (UTC maths, no DST drift). */
export function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let d = startDate; d <= endDate && dates.length < 3660; d = addDays(d, 1)) dates.push(d)
  return dates
}

export interface DayHeaderInfo {
  /** "Day 3", "Before the trip" or "After the trip". */
  dayLabel: string
  /** "Sunday 8 Dec" style weekday + date label (en-GB). */
  label: string
  /** 1-indexed day-of-trip, only set during the trip (null for before/after days). */
  dayNumber: number | null
}

/** Weekday + date + day-N-of-trip label for a sticky day header. */
export function formatDayHeader(dateStr: string, tripStartDate: string, tripEndDate: string): DayHeaderInfo {
  const label = new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
  const dayLabel = dayHeaderLabel(dateStr, tripStartDate, tripEndDate)
  const during = placeDate(dateStr, tripStartDate, tripEndDate).place === 'during'
  const dayNumber = during ? Number(dayLabel.replace('Day ', '')) : null
  return { dayLabel, label, dayNumber }
}

/**
 * Full inclusive date range the timeline should render: the trip days, a
 * continuous run out to the furthest event within a week either side, and
 * any event further out on its own day (not filled in).
 */
export function computeTimelineDateRange(
  events: Pick<TimelineEvent, 'event_date'>[],
  tripStartDate: string,
  tripEndDate: string
): string[] {
  return boardDays(events.map((e) => e.event_date), tripStartDate, tripEndDate)
}

/** Group events by their event_date, preserving each day's existing order. */
export function groupEventsByDate(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const byDate = new Map<string, TimelineEvent[]>()
  for (const event of events) {
    const existing = byDate.get(event.event_date) || []
    existing.push(event)
    byDate.set(event.event_date, existing)
  }
  return byDate
}

/**
 * Smart default collapse (plan: "past days collapsed, today/future
 * expanded"): every date before today starts collapsed; today and every
 * future date start expanded. `today` is injected for testability.
 */
export function computeDefaultCollapsedDays(allDates: string[], today: string): Set<string> {
  return new Set(allDates.filter((d) => d < today))
}

export interface DayBucket {
  dateStr: string
  isToday: boolean
  isPast: boolean
  isFuture: boolean
}

/** Classify a date relative to `today` (both YYYY-MM-DD) for styling/collapse decisions. */
export function classifyDay(dateStr: string, today: string): DayBucket {
  return {
    dateStr,
    isToday: dateStr === today,
    isPast: dateStr < today,
    isFuture: dateStr > today,
  }
}

/**
 * The "next up" event during trip_ongoing: the earliest event today or
 * later (by date, then start_time, then sort_order — matching the fetch
 * order) that hasn't already started. All-day events on a future date
 * count; all-day events today are considered "already covering now" and
 * are skipped in favour of a timed event if one exists later today.
 */
export function findNextUpEvent(
  events: TimelineEvent[],
  today: string,
  nowTime: string // "HH:MM" 24h, local
): TimelineEvent | null {
  const upcoming = events
    .filter((e) => e.event_date > today || (e.event_date === today && (e.all_day || (e.start_time ?? '') >= nowTime)))
    .sort((a, b) => {
      if (a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1
      const aTime = a.all_day ? '' : a.start_time ?? ''
      const bTime = b.all_day ? '' : b.start_time ?? ''
      if (aTime !== bTime) return aTime < bTime ? -1 : 1
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
  return upcoming[0] ?? null
}
