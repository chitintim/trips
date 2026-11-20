import type { TimelineEvent } from '../../../types'
import type { Json } from '../../../types/database.types'

/**
 * Self-service travel details (UX_REDESIGN.md Part 2 "People additions"):
 * each participant's arrival/departure lives as ordinary
 * trip_timeline_events rows (category transfer/flight,
 * participant_ids=[self], metadata.travel_details=true) so they appear on
 * the Plan board and feed nights-weighting automatically — no new tables.
 */

export type TravelDirection = 'arrival' | 'departure'

export interface TravelDetailsMetadata {
  travel_details: true
  /** Extra legs: 'arrival' = on the way there, 'departure' = on the way home. */
  direction: TravelDirection
  /** Absent = main (every row saved before extra journeys existed). */
  leg?: TravelLegKind
  flight_ref?: string
  /** 3-letter IATA-style airport code, uppercase, optional — not everyone knows theirs. */
  airport_code?: string
  /** Arrival only: the day the person sets off, for overnight journeys. */
  set_off_date?: string
  set_off_time?: string
  /** Departure only: the day the person gets home. */
  home_date?: string
  home_time?: string
}

export type TravelLegKind = 'main' | 'extra'

export function isTravelDetailsEvent(event: Pick<TimelineEvent, 'metadata'>): boolean {
  const m = event.metadata
  return !!m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).travel_details === true
}

export function travelEventDirection(event: Pick<TimelineEvent, 'metadata' | 'title'>): TravelDirection | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const dir = (m as Record<string, unknown>).direction
    if (dir === 'arrival' || dir === 'departure') return dir
  }
  if (/arriv/i.test(event.title)) return 'arrival'
  if (/depart/i.test(event.title)) return 'departure'
  return null
}

export function travelEventFlightRef(event: Pick<TimelineEvent, 'metadata'>): string | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const ref = (m as Record<string, unknown>).flight_ref
    if (typeof ref === 'string' && ref.trim()) return ref
  }
  return null
}

export function travelEventAirportCode(event: Pick<TimelineEvent, 'metadata'>): string | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const code = (m as Record<string, unknown>).airport_code
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase()
  }
  return null
}

function metaString(event: Pick<TimelineEvent, 'metadata'>, key: string): string | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const v = (m as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/** A travel row that says when the person joins or leaves the group. Rows saved before extra journeys existed have no `leg`. */
export function isMainTravelLeg(event: Pick<TimelineEvent, 'metadata'>): boolean {
  return isTravelDetailsEvent(event) && metaString(event, 'leg') !== 'extra'
}

export function isExtraTravelLeg(event: Pick<TimelineEvent, 'metadata'>): boolean {
  return isTravelDetailsEvent(event) && metaString(event, 'leg') === 'extra'
}

export interface MyTravelEvents {
  arrival: TimelineEvent | null
  departure: TimelineEvent | null
}

/** True when `a` should win over `b` as the current row: most recently updated, then id. */
function isNewerRow(a: TimelineEvent, b: TimelineEvent): boolean {
  const au = a.updated_at ?? ''
  const bu = b.updated_at ?? ''
  if (au !== bu) return au > bu
  return a.id > b.id
}

/** The user's own main travel legs (one per direction; the most recently updated wins if duplicated). */
export function getMyTravelEvents(events: TimelineEvent[], userId: string | undefined): MyTravelEvents {
  const result: MyTravelEvents = { arrival: null, departure: null }
  if (!userId) return result
  for (const event of events) {
    if (!isMainTravelLeg(event)) continue
    if (!(event.participant_ids ?? []).includes(userId)) continue
    const direction = travelEventDirection(event)
    if (!direction) continue
    const current = result[direction]
    if (!current || isNewerRow(event, current)) result[direction] = event
  }
  return result
}

function byWhen(a: TimelineEvent, b: TimelineEvent): number {
  return (
    (a.event_date ?? '').localeCompare(b.event_date ?? '') ||
    (a.start_time ?? '').localeCompare(b.start_time ?? '') ||
    a.id.localeCompare(b.id)
  )
}

/** The user's extra journeys: `before` is on the way there, `after` on the way home. Sorted by date and time. */
export function getMyExtraTravelLegs(
  events: TimelineEvent[],
  userId: string | undefined,
): { before: TimelineEvent[]; after: TimelineEvent[] } {
  const result = { before: [] as TimelineEvent[], after: [] as TimelineEvent[] }
  if (!userId) return result
  for (const event of events) {
    if (!isExtraTravelLeg(event)) continue
    if (!(event.participant_ids ?? []).includes(userId)) continue
    const direction = travelEventDirection(event)
    if (direction === 'arrival') result.before.push(event)
    else if (direction === 'departure') result.after.push(event)
  }
  result.before.sort(byWhen)
  result.after.sort(byWhen)
  return result
}

const timeOnly = (t: string | null): string | null => {
  if (!t) return null
  const m = /^(\d{2}:\d{2})/.exec(t)
  return m ? m[1] : null
}

export function travelLegOtherEnd(event: Pick<TimelineEvent, 'metadata'>): {
  setOffDate: string | null
  setOffTime: string | null
  homeDate: string | null
  homeTime: string | null
} {
  return {
    setOffDate: metaString(event, 'set_off_date'),
    setOffTime: timeOnly(metaString(event, 'set_off_time')),
    homeDate: metaString(event, 'home_date'),
    homeTime: timeOnly(metaString(event, 'home_time')),
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function utcMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(ms) ? null : ms
}

function shortDate(date: string): string | null {
  const ms = utcMs(date)
  if (ms === null) return null
  const d = new Date(ms)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** One plain line about the other end of a main leg, or null when there is none. */
export function travelLegSummary(event: Pick<TimelineEvent, 'metadata' | 'event_date' | 'title'>): string | null {
  const other = travelLegOtherEnd(event)
  if (other.setOffDate) {
    const day = shortDate(other.setOffDate)
    if (!day) return null
    let text = `Sets off ${day}${other.setOffTime ? ` ${other.setOffTime}` : ''}`
    const from = utcMs(other.setOffDate)
    const to = event.event_date ? utcMs(event.event_date) : null
    if (from !== null && to !== null) {
      const days = Math.round((to - from) / 86_400_000)
      if (days === 1) text += ' · lands next day'
      else if (days > 1) text += ` · lands ${days} days later`
    }
    return text
  }
  if (other.homeDate) {
    const day = shortDate(other.homeDate)
    if (!day) return null
    return `Gets home ${day}${other.homeTime ? ` ${other.homeTime}` : ''}`
  }
  return null
}

/** The earliest day this person starts travelling: a set-off day, an arrival day, or an extra journey before the trip. */
export function earliestOwnTravelDate(events: TimelineEvent[], userId: string | undefined): string | null {
  if (!userId) return null
  const dates: string[] = []
  const { arrival } = getMyTravelEvents(events, userId)
  if (arrival) {
    const setOff = travelLegOtherEnd(arrival).setOffDate
    const d = setOff ?? arrival.event_date
    if (d) dates.push(d)
  }
  for (const e of getMyExtraTravelLegs(events, userId).before) {
    if (e.event_date) dates.push(e.event_date)
  }
  if (dates.length === 0) return null
  return dates.reduce((min, d) => (d < min ? d : min))
}

export interface TravelMetadataExtras {
  leg?: TravelLegKind
  setOffDate?: string | null
  setOffTime?: string | null
  homeDate?: string | null
  homeTime?: string | null
}

export function buildTravelMetadata(
  direction: TravelDirection,
  flightRef: string,
  airportCode = '',
  extra: TravelMetadataExtras = {},
): Json {
  const metadata: TravelDetailsMetadata = { travel_details: true, direction }
  if (extra.leg) metadata.leg = extra.leg
  if (flightRef.trim()) metadata.flight_ref = flightRef.trim()
  const code = airportCode.trim().toUpperCase()
  if (code) metadata.airport_code = code
  if (extra.setOffDate) metadata.set_off_date = extra.setOffDate
  if (extra.setOffTime) metadata.set_off_time = extra.setOffTime
  if (extra.homeDate) metadata.home_date = extra.homeDate
  if (extra.homeTime) metadata.home_time = extra.homeTime
  return metadata as unknown as Json
}
