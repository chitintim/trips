import { queryKeys } from '../../../lib/queries/queryKeys'
import { legsFromEvents, ownTravelRowIds, travelSaveErrorMessage, validateTravelLegs, type TravelLegInput } from '../../people/lib/myTravel'
import type { SetTravelParams } from '../lib/payload'
import type { ActionModule } from './types'
import { FINISHED_CARD_MESSAGE, formatDay, isDay, isNonEmptyStr, isObj, isStrOrNull } from './common'

export const TRAVEL_CHANGED_MESSAGE = 'Your travel has changed since. Open travel details to check.'
export const TRAVEL_UNCHECKED_MESSAGE = "Your travel couldn't be checked just now. Open travel details to check."

/** Plain words for a failed travel save; the server's "stale" refusal reads as the changed-since card message. */
function saveError(err: unknown): Error {
  const hint = err && typeof err === 'object' ? (err as { hint?: unknown }).hint : undefined
  return new Error(hint === 'stale' ? TRAVEL_CHANGED_MESSAGE : travelSaveErrorMessage(err))
}

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as SetTravelParams

/** A short line from the server's preview (labels it worked out from the trip's dates), or null. Never used for anything but display. */
function label(preview: Record<string, unknown>, key: string): string | null {
  const v = preview[key]
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null
}

function sameStamp(a: unknown, b: unknown): boolean {
  const x = typeof a === 'string' ? a : null
  const y = typeof b === 'string' ? b : null
  if (x === null || y === null) return x === y
  const tx = Date.parse(x)
  const ty = Date.parse(y)
  return Number.isFinite(tx) && Number.isFinite(ty) ? tx === ty : x === y
}

const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null)

/** One leg as it is compared: the same values whichever side (saved row or just-sent) it came from. */
function fingerprint(l: TravelLegInput): string {
  return JSON.stringify([l.direction, l.leg, clean(l.title), clean(l.date), clean(l.time), clean(l.flightRef), clean(l.airportCode)?.toUpperCase() ?? null, clean(l.setOffDate), clean(l.setOffTime), clean(l.homeDate), clean(l.homeTime)])
}
const sameLegs = (a: TravelLegInput[], b: TravelLegInput[]) => {
  const x = a.map(fingerprint).sort()
  const y = b.map(fingerprint).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function readLegs(v: unknown): TravelLegInput[] | null {
  if (!Array.isArray(v)) return null
  const out: TravelLegInput[] = []
  for (const x of v) {
    if (!isObj(x)) return null
    if ((x.direction !== 'arrival' && x.direction !== 'departure') || (x.leg !== 'main' && x.leg !== 'extra') || typeof x.date !== 'string') return null
    const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : null)
    out.push({
      id: s('id'),
      direction: x.direction,
      leg: x.leg,
      title: s('title'),
      date: x.date,
      time: s('time'),
      flightRef: s('flightRef'),
      airportCode: s('airportCode'),
      setOffDate: s('setOffDate'),
      setOffTime: s('setOffTime'),
      homeDate: s('homeDate'),
      homeTime: s('homeTime'),
    })
  }
  return out
}

/** The caller's saved legs with this one applied: a main leg replaces that direction's main (keeping its id), an extra is added. */
function applyLeg(before: TravelLegInput[], params: SetTravelParams): TravelLegInput[] {
  const incoming: TravelLegInput = {
    id: null,
    direction: params.direction,
    leg: params.leg,
    title: params.leg === 'extra' ? params.title : null,
    date: params.date,
    time: params.time,
    flightRef: params.flight_ref,
    airportCode: params.airport_code,
    setOffDate: params.direction === 'arrival' && params.leg === 'main' ? params.set_off_date : null,
    setOffTime: params.direction === 'arrival' && params.leg === 'main' ? params.set_off_time : null,
    homeDate: params.direction === 'departure' && params.leg === 'main' ? params.home_date : null,
    homeTime: params.direction === 'departure' && params.leg === 'main' ? params.home_time : null,
  }
  if (params.leg === 'extra') return [...before, incoming]
  const at = before.findIndex((l) => l.direction === params.direction && l.leg === 'main')
  if (at < 0) return [...before, incoming]
  // The id comes from the live row, never from the card.
  return before.map((l, i) => (i === at ? { ...incoming, id: l.id } : l))
}

function journeyLabel(params: SetTravelParams, preview: Record<string, unknown>): string {
  return label(preview, 'journey_label') ?? (params.leg === 'extra' ? `“${params.title ?? ''}”` : params.direction === 'arrival' ? 'Arriving' : 'Leaving')
}

export const setTravelModule: ActionModule = {
  validate(x) {
    return (
      (x.direction === 'arrival' || x.direction === 'departure') &&
      (x.leg === 'main' || x.leg === 'extra') &&
      (x.leg !== 'extra' || isNonEmptyStr(x.title)) &&
      isDay(x.date) &&
      isStrOrNull(x.id) &&
      isStrOrNull(x.title) &&
      isStrOrNull(x.time) &&
      isStrOrNull(x.flight_ref) &&
      isStrOrNull(x.airport_code) &&
      (x.set_off_date === null || isDay(x.set_off_date)) &&
      isStrOrNull(x.set_off_time) &&
      (x.home_date === null || isDay(x.home_date)) &&
      isStrOrNull(x.home_time) &&
      isStrOrNull(x.replaces_event_id)
    )
  },

  view(action) {
    const params = p(action)
    const pv = action.preview
    const replacing = !!params.replaces_event_id
    const journey = journeyLabel(params, pv)
    const when = label(pv, 'when_label') ?? `${formatDay(params.date)}${params.time ? ` ${params.time} local` : ''}`
    const otherEnd = label(pv, 'other_end_label')
    const ref = label(pv, 'ref') ?? clean(params.flight_ref)
    const airport = label(pv, 'airport') ?? clean(params.airport_code)
    const replaces = label(pv, 'replaces_label')
    const note = pv.date_check === true ? label(pv, 'date_note') : null
    return {
      icon: '✈️',
      title: replacing ? 'Change your travel' : 'Add your travel',
      rows: [
        { label: 'Journey', value: journey },
        { label: 'When', value: when },
        ...(otherEnd ? [{ label: params.direction === 'arrival' ? 'Sets off' : 'Gets home', value: otherEnd }] : []),
        ...(ref ? [{ label: 'Flight or train', value: ref }] : []),
        ...(airport ? [{ label: 'Airport', value: airport }] : []),
        ...(replacing && replaces ? [{ label: 'Replaces', value: replaces }] : []),
      ],
      line: `${replacing ? 'Change' : 'Save'} your travel: ${journey.replace(/[“”]/g, '"')}, ${when}`,
      confirmLabel: 'Save travel',
      notes: [],
      ...(note ? { warnings: [note] } : {}),
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (live.finished) return FINISHED_CARD_MESSAGE
    if (!live.events) return TRAVEL_UNCHECKED_MESSAGE
    const events = live.events
    const before = legsFromEvents(events, live.userId)
    if (params.leg === 'main') {
      const liveMain = before.find((l) => l.direction === params.direction && l.leg === 'main')
      const rid = params.replaces_event_id
      if (rid) {
        const ev = events.find((e) => e.id === rid)
        if (!liveMain || liveMain.id !== rid || !ev || !sameStamp(ev.updated_at, action.basis.replaces_updated_at)) return TRAVEL_CHANGED_MESSAGE
      } else if (liveMain) {
        return TRAVEL_CHANGED_MESSAGE
      }
    }
    return validateTravelLegs(applyLeg(before, params))
  },

  async execute(action, ctx) {
    const params = p(action)
    const events = ctx.live().events
    if (!events) throw new Error(TRAVEL_UNCHECKED_MESSAGE)
    const before = legsFromEvents(events, ctx.userId)
    const next = applyLeg(before, params)
    const problem = validateTravelLegs(next)
    if (problem) throw new Error(problem)
    let saved
    try {
      saved = await ctx.deps.setMyTravel(ctx.tripId, next, ownTravelRowIds(events, ctx.userId))
    } catch (err) {
      // The RPC's error is a database error object: only its known, plain sentences may reach the card.
      throw saveError(err)
    }
    const ids = saved.legs.map((l) => l.id)
    const after = next.map((l, i) => ({ ...l, id: ids.length === next.length ? ids[i] : l.id }))
    return { result: { before, after, after_ids: ids }, doneText: 'Travel saved.' }
  },

  undoBlocked(action, live) {
    const after = readLegs(action.result?.after)
    if (!after || !readLegs(action.result?.before)) return 'Nothing to undo.'
    if (!live.events) return TRAVEL_UNCHECKED_MESSAGE
    if (!sameLegs(legsFromEvents(live.events, live.userId), after)) return 'Your travel has been changed since, so it stays.'
    return null
  },

  async undo(action, ctx) {
    const before = readLegs(action.result?.before)
    if (!before) throw new Error('Nothing to undo.')
    // A row that no longer exists would be refused by the save: send those as new legs.
    const events = ctx.live().events
    if (!events) throw new Error(TRAVEL_UNCHECKED_MESSAGE)
    const liveIds = new Set(events.map((e) => e.id))
    const legs = before.map((l) => ({ ...l, id: l.id && liveIds.has(l.id) ? l.id : null }))
    try {
      await ctx.deps.setMyTravel(ctx.tripId, legs, ownTravelRowIds(events, ctx.userId))
    } catch (err) {
      throw saveError(err)
    }
  },

  invalidate(ctx) {
    void ctx.queryClient.invalidateQueries({ queryKey: queryKeys.timeline(ctx.tripId) })
  },
}
