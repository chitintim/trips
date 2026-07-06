/**
 * Pure day-grouping / collapse logic for the Timeline tab (plan §6.5,
 * §Form & Flow Standard). Extracted from the legacy TimelineTab.tsx so the
 * date-range math and the "smart default collapse" behaviour (past days
 * collapsed, today prominent, future expanded) are independently testable
 * without mounting React.
 */
import type { TimelineEvent } from '../../../types'

/** Format a Date as a local (not UTC) YYYY-MM-DD string. */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Every calendar date from startDate to endDate inclusive, both YYYY-MM-DD. */
export function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    dates.push(formatLocalDate(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

export interface DayHeaderInfo {
  /** "Day 3", "Pre-trip", or "Post-trip". */
  dayLabel: string
  /** "Friday, 12 Sep" style weekday + date label. */
  label: string
  /** 1-indexed day-of-trip, only meaningful when dayLabel is "Day N". */
  dayNumber: number | null
}

/** Weekday + date + day-N-of-trip label for a sticky day header. */
export function formatDayHeader(dateStr: string, tripStartDate: string, tripEndDate: string): DayHeaderInfo {
  const date = new Date(dateStr + 'T00:00:00')
  const start = new Date(tripStartDate + 'T00:00:00')
  const end = new Date(tripEndDate + 'T00:00:00')
  const dayNum = Math.floor((date.getTime() - start.getTime()) / 86400000) + 1
  const label = date.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' })

  if (date < start) {
    return { dayLabel: 'Pre-trip', label, dayNumber: null }
  }
  if (date > end) {
    return { dayLabel: 'Post-trip', label, dayNumber: null }
  }
  return { dayLabel: `Day ${dayNum}`, label, dayNumber: dayNum }
}

/**
 * Full inclusive date range the timeline should render: the planned trip
 * dates, expanded to cover any events that fall outside that range (early
 * arrivals, late departures, post-trip debrief notes, etc).
 */
export function computeTimelineDateRange(
  events: Pick<TimelineEvent, 'event_date'>[],
  tripStartDate: string,
  tripEndDate: string
): string[] {
  const eventDates = events.map((e) => e.event_date)
  const minDate = [tripStartDate, ...eventDates].sort()[0]
  const maxDate = [tripEndDate, ...eventDates].sort().pop()!
  return generateDateRange(minDate, maxDate)
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
