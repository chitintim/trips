/**
 * TRIP_CHAT_ACTIONS: off (default) | on | comma-separated tokens, each a trip id or `upcoming`
 * (e.g. `upcoming,<trip-id>`). Unknown tokens simply match nothing.
 *
 * `upcoming` matches a trip that has not finished long ago, using trips.end_date, or trips.start_date when
 * there is no end date: that date is today (UTC) or later, or at most UPCOMING_GRACE_DAYS days in the past
 * (people keep adding expenses and settling up just after a trip). A trip with neither date (still being
 * planned) matches too. If the dates were not loaded or are malformed it does NOT match (fail closed).
 * Ids, `on` and `off` behave as always.
 *
 * Gates ALL propose_* tools (they stay declared, so the tools array and the
 * prompt cache never change; they just answer "not switched on"). The LEGACY
 * organiser-only `propose_actions` changeset tool is NOT gated by it (as before).
 * The handler calls this once per turn; everything else reads that one decision.
 */
export const UPCOMING_GRACE_DAYS = 30

export interface TripDates { start_date?: string | null; end_date?: string | null }

function dateOnly(v: string | null | undefined): string | null | 'bad' {
  if (v === null) return null
  if (typeof v !== 'string') return 'bad'
  const d = v.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) return 'bad'
  return d
}

/** True when the trip is not long finished (see header). `now` is injectable for tests. */
export function tripIsUpcoming(trip: TripDates | null | undefined, now: Date = new Date()): boolean {
  if (!trip || trip.start_date === undefined || trip.end_date === undefined) return false
  const end = dateOnly(trip.end_date)
  const start = dateOnly(trip.start_date)
  if (end === 'bad' || start === 'bad') return false
  const ref = end ?? start
  if (ref === null) return true
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - UPCOMING_GRACE_DAYS)).toISOString().slice(0, 10)
  return ref >= cutoff
}

export function actionsEnabledFor(flag: string | undefined | null, tripId: string, trip?: TripDates | null, now: Date = new Date()): boolean {
  const v = (flag ?? '').trim().toLowerCase()
  if (!v || v === 'off' || v === 'false' || v === '0') return false
  if (v === 'on' || v === 'true' || v === '1' || v === 'all') return true
  const tokens = v.split(',').map((s) => s.trim()).filter(Boolean)
  if (tokens.includes(tripId.toLowerCase())) return true
  return tokens.includes('upcoming') && tripIsUpcoming(trip, now)
}
