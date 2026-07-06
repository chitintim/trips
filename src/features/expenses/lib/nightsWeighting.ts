/**
 * Split-by-nights-present (plan §10): for accommodation-category expenses,
 * derive each tagged participant's number of nights from their arrival/
 * departure timeline events, falling back to the trip's start/end dates
 * when a participant has no explicit arrival/departure event. The result
 * is a set of integer weights fed straight into
 * largestRemainderDistribute() (src/lib/money/distribute.ts) so shares
 * always sum exactly to the expense amount.
 *
 * "Arrival"/"departure" are not first-class timeline_event_category values
 * (the enum is flight|accommodation|transport|activity|dining|transfer|
 * meeting_point|free_time|other) -- v1/v2 schema has no dedicated field for
 * this, so we infer intent from event title text (English-language trip
 * planning convention: "Arrival", "Arrives", "Departure", "Leaves", etc.)
 * combined with category (flight/transport/transfer are the categories
 * that plausibly mark arrival/departure). This is a heuristic, documented
 * as such, with the trip-date fallback guaranteeing a sane result even
 * when it misses.
 */
import type { TimelineEvent } from '../../../types'

export interface NightsWeightInput {
  participantId: string
}

export interface NightsWeightResult {
  participantId: string
  nights: number
  /** True if derived from an explicit arrival/departure event; false if the trip-date fallback was used for this participant. */
  derivedFromEvents: boolean
}

const ARRIVAL_RE = /\b(arriv(e|al|ing|es)|check[- ]?in|land(s|ing)?)\b/i
const DEPARTURE_RE = /\b(depart(ure|s|ing)?|check[- ]?out|leav(e|es|ing)|flight home|fly(ing)? home)\b/i

const ARRIVAL_DEPARTURE_CATEGORIES = new Set(['flight', 'transport', 'transfer'])

function parseDateOnly(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Finds the best-guess arrival/departure date (YYYY-MM-DD) for a participant
 * from the trip's timeline events, or null if none match.
 */
function findParticipantEventDate(
  events: TimelineEvent[],
  participantId: string,
  matcher: RegExp
): string | null {
  const candidates = events.filter((e) => {
    const involved = e.participant_ids ? e.participant_ids.includes(participantId) : true
    if (!involved) return false
    if (!ARRIVAL_DEPARTURE_CATEGORIES.has(e.category) && !matcher.test(e.title)) return false
    return matcher.test(e.title)
  })
  if (candidates.length === 0) return null
  // Earliest match for arrival, latest for departure -- callers pass the
  // right matcher, and sorting by event_date covers both by using the
  // matcher's own semantics (arrival: first; departure: last).
  const sorted = [...candidates].sort((a, b) => parseDateOnly(a.event_date) - parseDateOnly(b.event_date))
  return matcher === ARRIVAL_RE ? sorted[0].event_date : sorted[sorted.length - 1].event_date
}

/**
 * Computes nights-present weights for a set of participants tagged on an
 * accommodation expense. Each participant's window is
 * [arrivalDate, departureDate) clamped to [tripStart, tripEnd], falling
 * back to the full trip range when no arrival/departure event is found.
 * Nights is departureDate - arrivalDate in whole days, minimum 1 (a
 * same-day visitor still owes something towards the room).
 */
export function computeNightsWeights(
  participantIds: string[],
  events: TimelineEvent[],
  tripStartDate: string,
  tripEndDate: string
): NightsWeightResult[] {
  const tripStartMs = parseDateOnly(tripStartDate)
  const tripEndMs = parseDateOnly(tripEndDate)

  return participantIds.map((participantId) => {
    const arrivalEventDate = findParticipantEventDate(events, participantId, ARRIVAL_RE)
    const departureEventDate = findParticipantEventDate(events, participantId, DEPARTURE_RE)

    const derivedFromEvents = !!arrivalEventDate || !!departureEventDate

    let arrivalMs = arrivalEventDate ? parseDateOnly(arrivalEventDate) : tripStartMs
    let departureMs = departureEventDate ? parseDateOnly(departureEventDate) : tripEndMs

    // Clamp to trip bounds -- an event outside the trip window (bad data,
    // or a pre-trip flight booked a different day) shouldn't produce a
    // nonsensical night count.
    arrivalMs = Math.min(Math.max(arrivalMs, tripStartMs), tripEndMs)
    departureMs = Math.min(Math.max(departureMs, tripStartMs), tripEndMs)

    let nights = Math.round((departureMs - arrivalMs) / MS_PER_DAY)
    if (nights < 1) nights = 1

    return { participantId, nights, derivedFromEvents }
  })
}

/** Convenience: nights-weight results -> integer weights array, same order, for largestRemainderDistribute. */
export function nightsWeightsToWeightArray(results: NightsWeightResult[]): number[] {
  return results.map((r) => r.nights)
}
