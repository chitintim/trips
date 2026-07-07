/**
 * Companion suggestions (UX_REDESIGN.md Part 3 "Ambient AI" #3): a
 * conservative rule engine over data ALREADY loaded for the Plan board
 * (plan items + bookings) — no AI calls for v1, exactly per the spec.
 * Every rule below is pure and independently testable; the caller
 * (PlanBoard/Today) renders the resulting suggestions as dismissible
 * cards, persists dismissals in localStorage per trip+key, and turns
 * "accept" into opening EventEditorSheet prefilled from the suggestion.
 *
 * Rules implemented (spec's exact list):
 *  1. Flight booking -> suggest an airport transfer near landing time, IF
 *     no transfer/transport item exists within 3h after the flight.
 *  2. Accommodation booking -> suggest check-in/out events, IF neither is
 *     already present as a real (decided/booked) plan item OR a derived
 *     milestone that's already been materialized (the caller passes
 *     materialized derived_keys so this rule doesn't duplicate
 *     derivedMilestones.ts's own accommodation_span row).
 *  3. Two items at overlapping times on the same day -> TIME CLASH flag on
 *     BOTH items (not a create-suggestion — a warning attached to existing
 *     items).
 *  4. A booking whose date falls outside the trip's [start_date, end_date]
 *     -> mismatch flag (reuses calendarEdgeCases.isOutsideTripDates'
 *     concept, but keyed to the booking rather than a PlanItem since a
 *     booking can exist unlinked to any item — see planItems.ts's
 *     `unlinkedBookings`).
 */
import type { PlanItem } from './planItems'
import type { Booking } from '../../../lib/queries/useBookings'
import { bookingLooksLikeAccommodation, bookingLooksLikeFlight } from './derivedMilestones'

export type CompanionSuggestionKind = 'suggest_transfer' | 'suggest_checkin' | 'suggest_checkout'

export interface CompanionSuggestion {
  /** Stable key for React + localStorage dismissal (see dismissals.ts convention in src/features/today/lib). */
  key: string
  kind: CompanionSuggestionKind
  title: string
  description: string
  /** Prefill for EventEditorSheet when accepted. */
  prefill: {
    title: string
    category: 'transfer' | 'accommodation'
    event_date: string
    start_time?: string | null
  }
  sourceBookingId: string
}

export interface TimeClashFlag {
  /** The two PlanItem ids in the clash (order-independent; both get flagged). */
  itemIds: [string, string]
  date: string
}

export interface BookingMismatchFlag {
  bookingId: string
  bookingTitle: string
  bookingDate: string
}

const THREE_HOURS_MINUTES = 3 * 60

function parseTimeToMinutes(time: string | null): number | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function addMinutes(date: string, minutes: number): { date: string; time: number } {
  // Times are destination-local naive (calendar edge case #8) — plain
  // arithmetic on a synthetic minute-of-epoch value, no Date/timezone
  // involved, matching every other pure date function in this feature.
  const dayMinutes = 24 * 60
  const totalDayOffset = Math.floor(minutes / dayMinutes)
  const remainder = ((minutes % dayMinutes) + dayMinutes) % dayMinutes
  if (totalDayOffset === 0) return { date, time: remainder }
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + totalDayOffset)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return { date: `${y}-${mo}-${da}`, time: remainder }
}

/**
 * Rule 1: flight booking -> suggest an airport transfer near landing, when
 * no transport/transfer item exists on the same day within 3h after the
 * flight's time (if the booking/linked event carries one; a flight with no
 * time at all still gets a same-day suggestion since "when exactly" isn't
 * knowable, and the prefill leaves the time blank for the user to fill).
 */
export function suggestTransfers(bookings: Booking[], items: PlanItem[], flightTimesByBookingId: Map<string, string | null>): CompanionSuggestion[] {
  const suggestions: CompanionSuggestion[] = []
  for (const booking of bookings) {
    if (!booking.booking_date) continue
    if (!bookingLooksLikeFlight(booking)) continue

    const flightTime = flightTimesByBookingId.get(booking.id) ?? null
    const flightMinutes = parseTimeToMinutes(flightTime)

    const hasNearbyTransfer = items.some((item) => {
      if (item.category !== 'transfer' && item.category !== 'transport') return false
      if (item.date !== booking.booking_date) return false
      if (flightMinutes == null || !item.startTime) return true // can't compare times precisely — treat any same-day transfer as covering it
      const itemMinutes = parseTimeToMinutes(item.startTime)
      if (itemMinutes == null) return true
      const windowEnd = addMinutes(booking.booking_date!, flightMinutes + THREE_HOURS_MINUTES)
      return item.date === windowEnd.date ? itemMinutes <= windowEnd.time && itemMinutes >= flightMinutes : itemMinutes <= windowEnd.time
    })
    if (hasNearbyTransfer) continue

    suggestions.push({
      key: `suggest_transfer:${booking.id}`,
      kind: 'suggest_transfer',
      title: 'Add an airport transfer?',
      description: `No transfer is on the plan for "${booking.title}" yet — worth adding one for after landing?`,
      prefill: { title: 'Airport transfer', category: 'transfer', event_date: booking.booking_date, start_time: flightTime },
      sourceBookingId: booking.id,
    })
  }
  return suggestions
}

/**
 * Rule 2: accommodation booking -> suggest check-in/out events, unless
 * already present as a real plan item OR already materialized as a
 * derived milestone (caller passes the same materializedDerivedKeys set
 * derivedMilestones.ts computes, so the two systems never double-suggest
 * the same thing).
 */
export function suggestAccommodationEvents(
  bookings: Booking[],
  items: PlanItem[],
  materializedDerivedKeys: Set<string>,
  tripEndDate: string
): CompanionSuggestion[] {
  const suggestions: CompanionSuggestion[] = []
  for (const booking of bookings) {
    if (!booking.booking_date) continue
    if (!bookingLooksLikeAccommodation(booking)) continue

    const checkinKey = `accommodation_span:${booking.id}`
    const alreadyCheckin =
      materializedDerivedKeys.has(checkinKey) ||
      items.some((i) => i.category === 'accommodation' && i.date === booking.booking_date && (i.stage === 'decided' || i.stage === 'booked'))
    if (!alreadyCheckin) {
      suggestions.push({
        key: `suggest_checkin:${booking.id}`,
        kind: 'suggest_checkin',
        title: 'Add a check-in event?',
        description: `Put "${booking.title}" check-in on the plan so everyone can see when/where.`,
        prefill: { title: `Check in: ${booking.title}`, category: 'accommodation', event_date: booking.booking_date },
        sourceBookingId: booking.id,
      })
    }

    const alreadyCheckout = items.some(
      (i) => i.category === 'accommodation' && i.date === tripEndDate && (i.stage === 'decided' || i.stage === 'booked') && i.id !== booking.timeline_event_id
    )
    if (!alreadyCheckout) {
      suggestions.push({
        key: `suggest_checkout:${booking.id}`,
        kind: 'suggest_checkout',
        title: 'Add a check-out event?',
        description: `Put "${booking.title}" check-out on the plan too.`,
        prefill: { title: `Check out: ${booking.title}`, category: 'accommodation', event_date: tripEndDate },
        sourceBookingId: booking.id,
      })
    }
  }
  return suggestions
}

/**
 * Rule 3: TIME CLASH — two dated, timed items on the same day whose
 * [start,end) windows overlap. All-day items and undated items never
 * clash (nothing to compare). Symmetric: both items are flagged.
 */
export function detectTimeClashes(items: PlanItem[]): TimeClashFlag[] {
  const flags: TimeClashFlag[] = []
  const byDate = new Map<string, PlanItem[]>()
  for (const item of items) {
    if (!item.date || item.allDay || !item.startTime) continue
    const list = byDate.get(item.date) ?? []
    list.push(item)
    byDate.set(item.date, list)
  }

  for (const [date, dayItems] of byDate) {
    for (let i = 0; i < dayItems.length; i++) {
      for (let j = i + 1; j < dayItems.length; j++) {
        const a = dayItems[i]
        const b = dayItems[j]
        if (itemsOverlap(a, b)) {
          flags.push({ itemIds: [a.id, b.id], date })
        }
      }
    }
  }
  return flags
}

function itemsOverlap(a: PlanItem, b: PlanItem): boolean {
  const aStart = parseTimeToMinutes(a.startTime)
  const bStart = parseTimeToMinutes(b.startTime)
  if (aStart == null || bStart == null) return false
  // Overnight events (end < start) are treated as extending into the next
  // day (calendar edge case #4) — for same-day overlap purposes, an
  // overnight item's "end" on THIS day is treated as end-of-day (24:00) so
  // it correctly clashes with anything starting after it today.
  const aEndRaw = parseTimeToMinutes(a.endTime)
  const bEndRaw = parseTimeToMinutes(b.endTime)
  const aEnd = aEndRaw == null ? aStart + 1 : aEndRaw < aStart ? 24 * 60 : aEndRaw
  const bEnd = bEndRaw == null ? bStart + 1 : bEndRaw < bStart ? 24 * 60 : bEndRaw
  return aStart < bEnd && bStart < aEnd
}

/** Returns the set of PlanItem ids involved in ANY time clash, for a card-level flag lookup. */
export function clashedItemIds(flags: TimeClashFlag[]): Set<string> {
  const ids = new Set<string>()
  for (const flag of flags) {
    ids.add(flag.itemIds[0])
    ids.add(flag.itemIds[1])
  }
  return ids
}

/**
 * Rule 4: a booking whose date falls outside the trip's range -> mismatch
 * flag. Distinct from calendarEdgeCases.isOutsideTripDates (which flags
 * PlanItems) because a booking can be entirely unlinked to any item.
 */
export function detectBookingDateMismatches(bookings: Booking[], tripStartDate: string, tripEndDate: string): BookingMismatchFlag[] {
  const flags: BookingMismatchFlag[] = []
  for (const booking of bookings) {
    if (!booking.booking_date) continue
    if (booking.booking_date < tripStartDate || booking.booking_date > tripEndDate) {
      flags.push({ bookingId: booking.id, bookingTitle: booking.title, bookingDate: booking.booking_date })
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// Dismissal persistence (localStorage per trip+key, per the spec).
// ---------------------------------------------------------------------------

function dismissalStorageKey(tripId: string): string {
  return `trips:companion-dismissals:${tripId}`
}

export function loadDismissedKeys(tripId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(dismissalStorageKey(tripId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function dismissSuggestion(tripId: string, key: string): void {
  try {
    const keys = loadDismissedKeys(tripId)
    keys.add(key)
    window.localStorage.setItem(dismissalStorageKey(tripId), JSON.stringify([...keys]))
  } catch {
    // Storage unavailable — the suggestion just reappears next load, which is a safe failure mode.
  }
}
