import type { TripStatus } from '../types'

/**
 * Trip status: derived, suggested, never nagging (UX_REDESIGN.md Part 2
 * addendum). Stored `trips.status` stays authoritative for the chaser and
 * queries, but ALL stage-driven UX (Today variant, default space, StageRail
 * display, FAB defaults) runs on `effectiveTripStage(trip, today)`:
 *
 *   effective = max(stored, date-derived)
 *
 * where the date-derived stage is `trip_ongoing` while today is within the
 * trip's dates and `trip_completed` once today is past end_date. The
 * effective stage never goes BACKWARDS from the stored value — an organizer
 * who already marked the trip completed keeps that even if dates change.
 */

/** Lifecycle order, earliest → latest. */
export const TRIP_STAGE_ORDER: TripStatus[] = [
  'gathering_interest',
  'confirming_participants',
  'booking_details',
  'booked_awaiting_departure',
  'trip_ongoing',
  'trip_completed',
]

export function tripStageRank(status: TripStatus): number {
  const idx = TRIP_STAGE_ORDER.indexOf(status)
  return idx === -1 ? 0 : idx
}

/** YYYY-MM-DD of a Date in LOCAL time (trip dates are destination-local naive). */
function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * The stage the trip's DATES imply, ignoring the stored status entirely.
 * Compares date-only strings so time-of-day and timezone offsets never
 * shift a boundary day: the start day counts as ongoing, the end day counts
 * as ongoing, and completion begins the day AFTER end_date.
 */
export function dateDerivedStage(
  trip: { start_date: string; end_date: string },
  today: Date | string = new Date()
): TripStatus | null {
  const todayOnly = typeof today === 'string' ? today.slice(0, 10) : toDateOnly(today)
  const start = trip.start_date.slice(0, 10)
  const end = trip.end_date.slice(0, 10)
  if (todayOnly > end) return 'trip_completed'
  if (todayOnly >= start) return 'trip_ongoing'
  return null
}

/**
 * The stage the UI should treat the trip as being in: the stored status,
 * upgraded (never downgraded) by what the dates say.
 */
export function effectiveTripStage(
  trip: { status: TripStatus; start_date: string; end_date: string },
  today: Date | string = new Date()
): TripStatus {
  const derived = dateDerivedStage(trip, today)
  if (!derived) return trip.status
  return tripStageRank(derived) > tripStageRank(trip.status) ? derived : trip.status
}
