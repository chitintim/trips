import { supabase } from '../../../lib/supabase'
import { addDays } from '../../../lib/tripWindow'
import type { TimelineEvent } from '../../../types'
import type { Json } from '../../../types/database.types'
import {
  getMyExtraTravelLegs,
  getMyTravelEvents,
  travelEventAirportCode,
  travelEventDirection,
  travelEventFlightRef,
  travelLegOtherEnd,
} from './travelDetails'
import type { TravelDirection, TravelLegKind } from './travelDetails'

/**
 * The only client write path for a person's own travel. Every save, organisers included, goes through the
 * `set_my_travel` RPC, because the table itself only lets organisers write. The call replaces the caller's whole set.
 */

export interface TravelLegInput {
  /** The saved row's id, or null for a new leg. */
  id: string | null
  direction: TravelDirection
  leg: TravelLegKind
  title: string | null
  date: string
  time: string | null
  flightRef: string | null
  airportCode: string | null
  setOffDate: string | null
  setOffTime: string | null
  homeDate: string | null
  homeTime: string | null
}

export type TravelLegField =
  | 'title'
  | 'date'
  | 'time'
  | 'flightRef'
  | 'airportCode'
  | 'setOffDate'
  | 'setOffTime'
  | 'homeDate'
  | 'homeTime'

export interface TravelLegError {
  /** Index into the legs array; -1 when the problem is about the set as a whole. */
  index: number
  field: TravelLegField | null
  message: string
}

const MSG = {
  noDate: 'Add the date, or clear this journey.',
  title: 'Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.',
  date: 'That date looks wrong. Check the year.',
  time: "That time doesn't look right. Use hours and minutes, like 21:30.",
  ref: 'The flight or train number is too long (12 characters at most).',
  airport: 'The airport code should be three letters, like LHR.',
  setOff: 'Setting off must be on or up to 3 days before arriving.',
  setOffMissing: 'Add the day you set off, or clear it.',
  home: 'Getting home must be on or up to 3 days after leaving.',
  homeMissing: 'Add the day you get home, or clear it.',
  tooMany: 'You can have one arrival, one departure and up to 3 extra journeys each way.',
  shape: "Those travel details don't look right. Check them and try again.",
  generic: "Couldn't save your travel. Check your connection and try again.",
} as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_LEGS = 8

function isRealDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false
  const [y, m, day] = d.split('-').map(Number)
  const back = new Date(Date.UTC(y, m - 1, day))
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === day
}

const clean = (v: string | null | undefined): string => (v ?? '').trim()

function hasAnyField(l: TravelLegInput): boolean {
  return [l.title, l.time, l.flightRef, l.airportCode, l.setOffDate, l.setOffTime, l.homeDate, l.homeTime].some((v) => clean(v) !== '')
}

/** The server's ownership rule: a travel row is yours only when it is for you alone. Rows shared between people are not yours to rewrite. */
export function isOwnTravelRow(event: TimelineEvent, userId: string): boolean {
  const m = event.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m) || (m as Record<string, unknown>).travel_details !== true) return false
  if (event.source_option_id) return false
  const ids = event.participant_ids ?? []
  return ids.length === 1 && ids[0] === userId
}

/** Every travel row the server counts as the caller's, including duplicate main rows that `legsFromEvents` drops. */
export function ownTravelRowIds(events: TimelineEvent[], userId: string): string[] {
  return events.filter((e) => isOwnTravelRow(e, userId)).map((e) => e.id).sort()
}

/** The caller's current legs: one main per direction (the same winner the rest of the app shows), then the extra journeys. */
export function legsFromEvents(events: TimelineEvent[], userId: string): TravelLegInput[] {
  const toLeg = (event: TimelineEvent, direction: TravelDirection, leg: TravelLegKind): TravelLegInput => {
    const other = travelLegOtherEnd(event)
    return {
      id: event.id,
      direction,
      leg,
      title: leg === 'extra' ? event.title : null,
      date: event.event_date ?? '',
      time: event.start_time ? event.start_time.slice(0, 5) : null,
      flightRef: travelEventFlightRef(event),
      airportCode: travelEventAirportCode(event),
      setOffDate: direction === 'arrival' && leg === 'main' ? other.setOffDate : null,
      setOffTime: direction === 'arrival' && leg === 'main' ? other.setOffTime : null,
      homeDate: direction === 'departure' && leg === 'main' ? other.homeDate : null,
      homeTime: direction === 'departure' && leg === 'main' ? other.homeTime : null,
    }
  }
  const own = events.filter((e) => isOwnTravelRow(e, userId))
  const main = getMyTravelEvents(own, userId)
  const extra = getMyExtraTravelLegs(own, userId)
  const out: TravelLegInput[] = []
  if (main.arrival) out.push(toLeg(main.arrival, 'arrival', 'main'))
  if (main.departure) out.push(toLeg(main.departure, 'departure', 'main'))
  for (const e of extra.before) out.push(toLeg(e, travelEventDirection(e) ?? 'arrival', 'extra'))
  for (const e of extra.after) out.push(toLeg(e, travelEventDirection(e) ?? 'departure', 'extra'))
  return out
}

/**
 * Every problem the server would reject, with the server's words. `tripStart` adds the "within 366 days" date sanity check;
 * leave it out when the trip's start is not to hand (the server still checks).
 */
export function travelLegErrors(legs: TravelLegInput[], tripStart?: string | null): TravelLegError[] {
  const errors: TravelLegError[] = []
  if (legs.length > MAX_LEGS) return [{ index: -1, field: null, message: MSG.shape }]
  const counts = { 'arrival:main': 0, 'arrival:extra': 0, 'departure:main': 0, 'departure:extra': 0 }

  legs.forEach((l, index) => {
    const push = (field: TravelLegField, message: string) => errors.push({ index, field, message })
    const date = clean(l.date)
    const title = clean(l.title)
    const time = clean(l.time)

    if (l.leg === 'extra') {
      if (!title || title.length > 60) push('title', MSG.title)
    } else if (title) push('title', MSG.title)

    if (!date && !hasAnyField(l)) {
      push('date', MSG.noDate)
      return
    }
    if (!date) {
      push('date', MSG.noDate)
    } else if (!isRealDate(date) || (tripStart && isRealDate(tripStart) && Math.abs(daysBetween(tripStart, date)) > 366)) {
      push('date', MSG.date)
    }
    if (time && !TIME_RE.test(time)) push('time', MSG.time)
    if (clean(l.flightRef).length > 12) push('flightRef', MSG.ref)
    const code = clean(l.airportCode)
    if (code && !/^[A-Za-z]{3}$/.test(code)) push('airportCode', MSG.airport)

    const dateOk = isRealDate(date)
    const isArrivalMain = l.direction === 'arrival' && l.leg === 'main'
    const isDepartureMain = l.direction === 'departure' && l.leg === 'main'
    if (!isArrivalMain && (clean(l.setOffDate) || clean(l.setOffTime))) push('setOffDate', MSG.shape)
    if (!isDepartureMain && (clean(l.homeDate) || clean(l.homeTime))) push('homeDate', MSG.shape)

    if (isArrivalMain && (clean(l.setOffDate) || clean(l.setOffTime))) {
      const d = clean(l.setOffDate)
      if (!d) push('setOffDate', MSG.setOffMissing)
      else if (!isRealDate(d) || (dateOk && (d > date || d < addDays(date, -3)))) push('setOffDate', MSG.setOff)
      if (clean(l.setOffTime) && !TIME_RE.test(clean(l.setOffTime))) push('setOffTime', MSG.time)
    }
    if (isDepartureMain && (clean(l.homeDate) || clean(l.homeTime))) {
      const d = clean(l.homeDate)
      if (!d) push('homeDate', MSG.homeMissing)
      else if (!isRealDate(d) || (dateOk && (d < date || d > addDays(date, 3)))) push('homeDate', MSG.home)
      if (clean(l.homeTime) && !TIME_RE.test(clean(l.homeTime))) push('homeTime', MSG.time)
    }
    counts[`${l.direction}:${l.leg}`] += 1
  })

  if (counts['arrival:main'] > 1 || counts['departure:main'] > 1 || counts['arrival:extra'] > 3 || counts['departure:extra'] > 3) {
    errors.push({ index: -1, field: null, message: MSG.tooMany })
  }
  return errors
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** The first problem in plain words, or null when the legs are fine to send. Same rules as the RPC, same words. */
export function validateTravelLegs(legs: TravelLegInput[], tripStart?: string | null): string | null {
  return travelLegErrors(legs, tripStart)[0]?.message ?? null
}

function toWire(l: TravelLegInput) {
  const orNull = (v: string | null) => (clean(v) === '' ? null : clean(v))
  return {
    id: l.id,
    direction: l.direction,
    leg: l.leg,
    title: l.leg === 'extra' ? orNull(l.title) : null,
    date: clean(l.date),
    time: orNull(l.time),
    flight_ref: orNull(l.flightRef),
    airport_code: orNull(l.airportCode)?.toUpperCase() ?? null,
    set_off_date: orNull(l.setOffDate),
    set_off_time: orNull(l.setOffTime),
    home_date: orNull(l.homeDate),
    home_time: orNull(l.homeTime),
  }
}

/**
 * Replaces the caller's whole travel set: a leg left out is deleted, and an empty array clears everything.
 * `knownIds` are the own row ids the legs were built from (`ownTravelRowIds`); the server refuses with hint `stale` if there are others.
 */
export async function setMyTravel(
  tripId: string,
  legs: TravelLegInput[],
  knownIds: string[],
): Promise<{ legs: { id: string; direction: string; leg: string }[] }> {
  const { data, error } = await supabase.rpc('set_my_travel', { p_trip_id: tripId, p_legs: legs.map(toWire) as unknown as Json, p_known_ids: knownIds })
  if (error) throw error
  const out = (data as { legs?: { id: string; direction: string; leg: string }[] } | null)?.legs
  return { legs: Array.isArray(out) ? out : [] }
}

const KNOWN_HINTS = new Set([
  'not_participant',
  'not_authenticated',
  'bad_legs',
  'too_many',
  'bad_date',
  'bad_time',
  'bad_ref',
  'bad_airport',
  'bad_title',
  'bad_set_off',
  'bad_home',
  'bad_id',
  'stale',
])

/** A message safe to show: the RPC's own words when it sent a known hint, otherwise a plain generic sentence. Never raw Postgres text. */
export function travelSaveErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const { hint, message } = err as { hint?: unknown; message?: unknown }
    if (typeof hint === 'string' && KNOWN_HINTS.has(hint) && typeof message === 'string' && message.trim()) return message.trim()
  }
  return MSG.generic
}
