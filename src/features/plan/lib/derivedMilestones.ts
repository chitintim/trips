/**
 * Date-derived presets (UX_REDESIGN.md Part 3 "Date-derived presets
 * (rendered, not stored)"): pure computation of system rows the Plan board
 * shows alongside real PlanItems, WITHOUT ever writing them to the
 * database. Every derived row disappears the instant a real event exists
 * that "covers" it (materialize, or the organizer adds the same thing by
 * hand) — dedup is by `metadata.derived_key` on `trip_timeline_events`
 * (see `materializedDerivedKeys` below and `MATERIALIZE_METADATA_FIELD`).
 *
 * Inputs are exactly what's already loaded for the Plan board (trip,
 * bookings, timeline events) — no new queries. Every function here is
 * deterministic given its inputs (no Date.now()), so this module is fully
 * unit-testable without mounting React or touching Supabase.
 */
import type { Booking } from '../../../lib/queries/useBookings'
import type { TimelineEvent } from '../../../types'
import type { Json } from '../../../types/database.types'
import { generateDateRange } from '../../timeline/lib/dayGrouping'

/** The metadata key written onto a materialized event so the derived row that spawned it can dedupe against it forever (survives edits to title/date). */
export const MATERIALIZE_METADATA_FIELD = 'derived_key'

export type DerivedMilestoneKind =
  | 'arrival_day'
  | 'departure_day'
  | 'accommodation_span'
  | 'flight_day'

export interface DerivedMilestone {
  /** Stable id: `${kind}:${sourceId}` — used as the React key and as the materialize dedupe key. */
  derivedKey: string
  kind: DerivedMilestoneKind
  title: string
  /** Short muted-style subtitle, e.g. "Check-in" or "Arrival day". */
  subtitle: string | null
  /** Start date this row is anchored to (for single-day rows, the only date). */
  date: string
  /** Inclusive end date for span banners (accommodation). Equal to `date` for single-day rows. */
  endDate: string
  /** True for multi-day span banners (accommodation) that should render once, not once per day. */
  isSpan: boolean
  /** The booking this row was derived from, if any — materialize can prefill from it. */
  sourceBookingId: string | null
  emoji: string
}

/** Reads `trip_timeline_events.metadata.derived_key` (additive, optional field — untyped Json column). */
export function readDerivedKey(metadata: Json | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const key = (metadata as Record<string, unknown>)[MATERIALIZE_METADATA_FIELD]
  return typeof key === 'string' ? key : null
}

/** Every derived_key already materialized as a real event — these derived rows must not render. */
export function materializedDerivedKeys(events: Pick<TimelineEvent, 'metadata'>[]): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    const key = readDerivedKey(event.metadata)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * Heuristic: does this booking look like accommodation? Bookings carry no
 * category column (see `bookings` schema) — only a title/vendor. This
 * matches common vendor/title vocabulary; a false negative just means the
 * booking doesn't get a span banner; a false positive is harmless (an
 * over-eager banner the organizer can ignore or materialize away).
 */
const ACCOMMODATION_WORDS = /\b(hotel|hostel|airbnb|apartment|chalet|resort|lodge|inn|villa|guesthouse|guest house|b&b|bnb|room|stay|accommodation)\b/i
const FLIGHT_WORDS = /\b(flight|airline|airways|air lines|boarding|departure gate|terminal)\b/i

export function bookingLooksLikeAccommodation(booking: Pick<Booking, 'title' | 'vendor' | 'notes'>): boolean {
  return ACCOMMODATION_WORDS.test(`${booking.title} ${booking.vendor ?? ''} ${booking.notes ?? ''}`)
}

export function bookingLooksLikeFlight(booking: Pick<Booking, 'title' | 'vendor' | 'notes'>): boolean {
  return FLIGHT_WORDS.test(`${booking.title} ${booking.vendor ?? ''} ${booking.notes ?? ''}`)
}

export interface DeriveMilestonesInput {
  trip: { start_date: string; end_date: string }
  bookings: Booking[]
  events: Pick<TimelineEvent, 'metadata'>[]
}

/**
 * Computes every derived milestone row for the trip, already filtered to
 * exclude anything materialized. Callers group by `date` the same way
 * `groupPlanItemsByDate` does for real PlanItems (or use `date`/`endDate`
 * directly to render span banners once across their covered days).
 */
export function deriveMilestones(input: DeriveMilestonesInput): DerivedMilestone[] {
  const { trip, bookings, events } = input
  const materialized = materializedDerivedKeys(events)
  const out: DerivedMilestone[] = []

  // ---- Arrival / departure day markers (always present, one each) ----
  const arrivalKey = 'arrival_day:trip'
  if (!materialized.has(arrivalKey)) {
    out.push({
      derivedKey: arrivalKey,
      kind: 'arrival_day',
      title: 'Arrival day',
      subtitle: 'Trip begins',
      date: trip.start_date,
      endDate: trip.start_date,
      isSpan: false,
      sourceBookingId: null,
      emoji: '🛬',
    })
  }
  const departureKey = 'departure_day:trip'
  if (!materialized.has(departureKey) && trip.end_date !== trip.start_date) {
    out.push({
      derivedKey: departureKey,
      kind: 'departure_day',
      title: 'Departure day',
      subtitle: 'Trip ends',
      date: trip.end_date,
      endDate: trip.end_date,
      isSpan: false,
      sourceBookingId: null,
      emoji: '🛫',
    })
  }

  // ---- Accommodation check-in/check-out span banners, from bookings ----
  for (const booking of bookings) {
    if (!bookingLooksLikeAccommodation(booking)) continue
    if (!booking.booking_date) continue
    const key = `accommodation_span:${booking.id}`
    if (materialized.has(key)) continue
    // A single booking_date is the only date column available on `bookings`
    // (no separate checkout column) — treat it as check-in and span to the
    // trip's end_date, which is the best available signal for "covers the
    // rest of the stay" without a dedicated checkout field. This keeps the
    // banner honest (a span, not a fabricated exact checkout) while still
    // giving the "once, not per day" span-banner behavior spec item 3 asks
    // for. If a future column carries an explicit checkout date, prefer it.
    const start = booking.booking_date
    const end = trip.end_date > start ? trip.end_date : start
    out.push({
      derivedKey: key,
      kind: 'accommodation_span',
      title: booking.title,
      subtitle: 'Check-in',
      date: start,
      endDate: end,
      isSpan: end !== start,
      sourceBookingId: booking.id,
      emoji: '🏨',
    })
  }

  // ---- Flight/airport-day markers, from bookings ----
  for (const booking of bookings) {
    if (!bookingLooksLikeFlight(booking)) continue
    if (!booking.booking_date) continue
    const key = `flight_day:${booking.id}`
    if (materialized.has(key)) continue
    out.push({
      derivedKey: key,
      kind: 'flight_day',
      title: booking.title,
      subtitle: 'Flight',
      date: booking.booking_date,
      endDate: booking.booking_date,
      isSpan: false,
      sourceBookingId: booking.id,
      emoji: '✈️',
    })
  }

  return out
}

/** Groups non-span milestones by their single date, and returns spans separately (spans render once, banner-style, above/below their covered days rather than being duplicated into every day's bucket). */
export function groupDerivedMilestones(milestones: DerivedMilestone[]): {
  byDate: Map<string, DerivedMilestone[]>
  spans: DerivedMilestone[]
} {
  const byDate = new Map<string, DerivedMilestone[]>()
  const spans: DerivedMilestone[] = []
  for (const m of milestones) {
    if (m.isSpan) {
      spans.push(m)
      continue
    }
    const list = byDate.get(m.date) ?? []
    list.push(m)
    byDate.set(m.date, list)
  }
  return { byDate, spans }
}

/** True when a span milestone covers the given date (inclusive), for "does this banner show above today's group". */
export function spanCoversDate(span: DerivedMilestone, date: string): boolean {
  return date >= span.date && date <= span.endDate
}

/**
 * Day-N-of-M label (unifies the partial "Day N" logic in dayGrouping.ts
 * with a total-days figure for the "Day N of M" wording UX_REDESIGN Part 3
 * asks for). Returns null when `date` falls outside the trip's dates
 * (pre/post-trip days use dayGrouping's "Pre-trip"/"Post-trip" label
 * instead — this function is only for in-range days).
 */
export function dayNofM(date: string, tripStartDate: string, tripEndDate: string): { n: number; m: number } | null {
  if (date < tripStartDate || date > tripEndDate) return null
  const allDays = generateDateRange(tripStartDate, tripEndDate)
  const n = allDays.indexOf(date) + 1
  if (n <= 0) return null
  return { n, m: allDays.length }
}

/** Progress fraction (0..1) through an ongoing trip, for a Today-hero progress indicator. Null when trip hasn't started or has ended. */
export function tripProgressFraction(today: string, tripStartDate: string, tripEndDate: string): number | null {
  const dm = dayNofM(today, tripStartDate, tripEndDate)
  if (!dm) return null
  if (dm.m <= 1) return 1
  return (dm.n - 1) / (dm.m - 1)
}
