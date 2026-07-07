/**
 * Calendar edge cases (UX_REDESIGN.md Part 3 "Calendar edge cases (handle
 * explicitly)", numbered 1-8 in the spec — #6 pre/post-trip expenses lives
 * in the expenses feature's own module since it's a Money-space concern,
 * see `src/features/expenses/lib/prePostTripExpenses.ts`). Pure logic only
 * — no React, no Supabase — so every rule here is unit-testable in
 * isolation.
 */
import type { PlanItem } from './planItems'
import { optionDateRange, type DateRange } from '../../today/lib/datePoll'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'

// ---------------------------------------------------------------------------
// #1 Dates changed after planning: items outside the (possibly-updated)
// trip range get an "outside trip dates" flag with a re-anchor affordance
// (the caller opens the event editor for the item so the organizer can pick
// a new date) — items are NEVER auto-deleted or auto-moved.
// ---------------------------------------------------------------------------

/** True when a dated PlanItem's date falls outside the trip's [start_date, end_date] window. */
export function isOutsideTripDates(item: Pick<PlanItem, 'date'>, tripStartDate: string, tripEndDate: string): boolean {
  if (!item.date) return false
  return item.date < tripStartDate || item.date > tripEndDate
}

// ---------------------------------------------------------------------------
// #2 No dates yet (date poll pending): the board renders a RELATIVE
// "Day 1..N" sequence anchored on the longest candidate range from the
// "Trip dates" section's options (metadata.date_range, see datePoll.ts),
// falling back to the trip's placeholder dates if no candidates exist yet.
// ---------------------------------------------------------------------------

/** The longest candidate date range across a section's options (by number of days inclusive), or null if none carry a parseable range. */
export function longestCandidateRange(section: Pick<SectionWithOptions, 'options'> | undefined | null): DateRange | null {
  if (!section) return null
  let longest: DateRange | null = null
  let longestDays = -1
  for (const option of section.options ?? []) {
    const range = optionDateRange(option.metadata)
    if (!range) continue
    const days = daysBetweenInclusive(range.start, range.end)
    if (days > longestDays) {
      longest = range
      longestDays = days
    }
  }
  return longest
}

function daysBetweenInclusive(start: string, end: string): number {
  const a = new Date(start + 'T00:00:00').getTime()
  const b = new Date(end + 'T00:00:00').getTime()
  return Math.round((b - a) / 86_400_000) + 1
}

/** The date range the Plan board should anchor on: the trip's real dates unless dates are pending, in which case the longest date-poll candidate (falling back to the trip's placeholder dates if there is no candidate yet). */
export function resolveBoardAnchorRange(
  trip: { start_date: string; end_date: string },
  datesPending: boolean,
  datesSection: Pick<SectionWithOptions, 'options'> | undefined | null
): DateRange {
  if (!datesPending) return { start: trip.start_date, end: trip.end_date }
  const candidate = longestCandidateRange(datesSection)
  return candidate ?? { start: trip.start_date, end: trip.end_date }
}

// ---------------------------------------------------------------------------
// #4 Overnight events (end_time < start_time): assume the event continues
// into the next day and label it "→ next day" rather than treating it as a
// data error.
// ---------------------------------------------------------------------------

export function isOvernightEvent(startTime: string | null, endTime: string | null): boolean {
  if (!startTime || !endTime) return false
  return endTime < startTime
}

/** "19:00 – 02:00 → next day" style label; falls back gracefully when only one side is present. */
export function formatOvernightTimeRange(startTime: string | null, endTime: string | null, formatTime: (t: string) => string): string | null {
  if (!startTime && !endTime) return null
  if (startTime && endTime) {
    const overnight = isOvernightEvent(startTime, endTime)
    return `${formatTime(startTime)} – ${formatTime(endTime)}${overnight ? ' → next day' : ''}`
  }
  return formatTime(startTime ?? endTime!)
}

// ---------------------------------------------------------------------------
// #5 Long trips (>14 days) collapse full weeks with an expander; short/
// 1-day trips skip day-grouping chrome entirely.
// ---------------------------------------------------------------------------

export const LONG_TRIP_COLLAPSE_THRESHOLD_DAYS = 14

/** True when the Plan board should skip per-day headers/dividers entirely (a single-day trip has nothing to group). */
export function shouldSkipDayGroupingChrome(allDates: string[]): boolean {
  return allDates.length <= 1
}

/** True when the trip is long enough that full, empty (no-item) weeks should collapse behind an expander rather than rendering 14+ empty day rows. */
export function isLongTrip(allDates: string[]): boolean {
  return allDates.length > LONG_TRIP_COLLAPSE_THRESHOLD_DAYS
}

export interface WeekChunk {
  /** ISO dates in this chunk, in order. */
  dates: string[]
  /** True when NONE of this chunk's dates have any items — a candidate for collapsing. */
  isEmpty: boolean
  /** First/last date, for the collapsed summary label ("12–18 Aug — nothing planned"). */
  start: string
  end: string
}

/**
 * Chunks a long trip's dates into 7-day weeks and flags fully-empty weeks
 * so the board can render them as a single collapsed "N days, nothing
 * planned yet" expander row instead of N empty day headers. Only used when
 * `isLongTrip` is true — short trips render every day normally regardless
 * of how many are empty.
 */
export function chunkIntoWeeks(allDates: string[], itemsByDate: Map<string, unknown[]>): WeekChunk[] {
  const chunks: WeekChunk[] = []
  for (let i = 0; i < allDates.length; i += 7) {
    const dates = allDates.slice(i, i + 7)
    const isEmpty = dates.every((d) => (itemsByDate.get(d)?.length ?? 0) === 0)
    chunks.push({ dates, isEmpty, start: dates[0], end: dates[dates.length - 1] })
  }
  return chunks
}

// ---------------------------------------------------------------------------
// #7 Late arrival / early departure: per-user NOW/NEXT should be filtered by
// the user's own presence window when travel-details events exist for
// them, rather than assuming they're present for the whole trip.
// ---------------------------------------------------------------------------

export interface PresenceWindow {
  /** First date this user is present, inclusive. Null = "no travel details, assume present from trip start". */
  arrivalDate: string | null
  /** Last date this user is present, inclusive. Null = "no travel details, assume present until trip end". */
  departureDate: string | null
}

/**
 * Derives a user's presence window from their travel-details events
 * (arrival/departure category events tagged to them via participant_ids,
 * or untagged = everyone). Falls back to the full trip range when no
 * travel-details events exist for them — the common case, and exactly
 * "normal" per the spec (late arrival/early departure is the exception).
 */
export function computeUserPresenceWindow(
  events: Array<{ category: string; event_date: string; participant_ids: string[] | null }>,
  userId: string
): PresenceWindow {
  const mine = events.filter((e) => e.participant_ids === null || e.participant_ids.includes(userId))
  const arrivals = mine.filter((e) => e.category === 'flight' || e.category === 'transfer').map((e) => e.event_date)
  if (arrivals.length === 0) return { arrivalDate: null, departureDate: null }
  const sorted = [...arrivals].sort()
  return { arrivalDate: sorted[0], departureDate: sorted[sorted.length - 1] }
}

/** True when `date` falls within the user's presence window (both bounds inclusive; null bound = unbounded on that side). */
export function isWithinPresenceWindow(date: string, window: PresenceWindow): boolean {
  if (window.arrivalDate && date < window.arrivalDate) return false
  if (window.departureDate && date > window.departureDate) return false
  return true
}

// ---------------------------------------------------------------------------
// #8 Times are destination-local naive; always label "local time"; no TZ
// conversion. Small formatting helper shared by Plan/Today time displays.
// ---------------------------------------------------------------------------

export function localTimeLabel(formattedTime: string): string {
  return `${formattedTime} local`
}
