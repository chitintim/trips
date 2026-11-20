/** propose_set_my_travel: the caller's own arrival / departure / extra journey. Executor: setMyTravel(tripId, legs) -> set_my_travel RPC. */
import { z } from 'npm:zod@3'
import { refuse, type Json, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { SetTravelBasis, SetTravelParams, SetTravelPreview } from './cards.ts'
import { baseBasis, cleanLine, dayLabel, daysBetween, FINISHED_MESSAGE, gate, metaObject, parseInput, storeProposal, tripState } from './common.ts'
import { BAD_DATE_MESSAGE, BAD_TIME_MESSAGE, dateFlags, dateLooksRight, isTime, passedMessage, whenLabel } from './tripDates.ts'

export const TRAVEL_TITLE_MAX = 60
export const TRAVEL_REF_MAX = 12
export const MAX_EXTRA_LEGS = 3

const optLine = (max: number, what: string) =>
  z.string().nullable().transform((v) => (v == null ? null : cleanLine(v) || null)).pipe(z.string().max(max, `${what} must be at most ${max} characters`).nullable())

const Input = z
  .object({
    direction: z.enum(['arrival', 'departure']),
    leg: z.enum(['main', 'extra']),
    title: optLine(TRAVEL_TITLE_MAX, 'title'),
    date: z.string(),
    time: z.string().nullable(),
    flight_ref: optLine(TRAVEL_REF_MAX, 'The flight or train reference'),
    airport_code: z.string().nullable(),
    set_off_date: z.string().nullable(),
    set_off_time: z.string().nullable(),
    home_date: z.string().nullable(),
    home_time: z.string().nullable(),
  })
  .strict()

export const setMyTravelSchema = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['arrival', 'departure'], description: 'arrival = getting to the trip (or, for leg "extra", a journey on the way there); departure = leaving (or, for "extra", a journey on the way home).' },
    leg: { type: 'string', enum: ['main', 'extra'], description: '"main" = when they join / leave the group (at most one each). "extra" = another journey, like a flight to Tokyo first.' },
    title: { type: ['string', 'null'], description: 'Extra legs only, up to 60 characters, e.g. "Flight to Tokyo". Null for main legs.' },
    date: { type: 'string', format: 'date', description: 'YYYY-MM-DD. For an arrival that is the day they land; for a departure the day they leave.' },
    time: { type: ['string', 'null'], description: 'HH:MM (24-hour, local time at the place), or null if not known.' },
    flight_ref: { type: ['string', 'null'], description: 'Flight or train number, up to 12 characters, e.g. JL044.' },
    airport_code: { type: ['string', 'null'], description: '3-letter airport code, e.g. LHR.' },
    set_off_date: { type: ['string', 'null'], format: 'date', description: 'Arrival only, overnight travel: the day they set off (0 to 3 days before date), YYYY-MM-DD.' },
    set_off_time: { type: ['string', 'null'], description: 'Arrival only: HH:MM they set off.' },
    home_date: { type: ['string', 'null'], format: 'date', description: 'Departure only: the day they get home if later than date (0 to 3 days after), YYYY-MM-DD.' },
    home_time: { type: ['string', 'null'], description: 'Departure only: HH:MM they get home.' },
  },
  required: ['direction', 'leg', 'title', 'date', 'time', 'flight_ref', 'airport_code', 'set_off_date', 'set_off_time', 'home_date', 'home_time'],
  additionalProperties: false,
}

interface OwnLeg {
  id: string
  direction: 'arrival' | 'departure' | null
  main: boolean
  date: string
  time: string | null
  ref: string | null
  updated_at: string | null
}

/** The caller's own travel rows (participant_ids = [self], metadata.travel_details). null = could not read. */
async function ownTravel(ctx: ToolCtx): Promise<OwnLeg[] | null> {
  try {
    const { data, error } = await ctx.client
      .from('trip_timeline_events')
      .select('id,event_date,start_time,title,metadata,participant_ids,updated_at,source_option_id')
      .eq('trip_id', ctx.tripId)
      .contains('participant_ids', [ctx.userId])
    if (error) return null
    const rows = (data ?? []) as Array<{ id: string; event_date: string; start_time: string | null; title: string; metadata: Json | null; participant_ids: string[] | null; updated_at: string | null; source_option_id: string | null }>
    return rows
      .filter((r) => r.participant_ids?.length === 1 && !r.source_option_id && metaObject(r.metadata).travel_details === true)
      .map((r) => {
        const m = metaObject(r.metadata)
        const dir = m.direction === 'arrival' || m.direction === 'departure' ? m.direction : /arriv/i.test(r.title) ? 'arrival' : /depart/i.test(r.title) ? 'departure' : null
        return {
          id: r.id,
          direction: dir,
          main: m.leg !== 'extra',
          date: String(r.event_date).slice(0, 10),
          time: r.start_time ? String(r.start_time).slice(0, 5) : null,
          ref: typeof m.flight_ref === 'string' && m.flight_ref.trim() ? m.flight_ref.trim() : null,
          updated_at: r.updated_at,
        }
      })
  } catch {
    return null
  }
}

function checkTime(label: string, t: string | null): string | null {
  return t != null && !isTime(t) ? `${label}: ${BAD_TIME_MESSAGE}` : null
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  // Title: extra legs need one, main legs take none (same as the RPC).
  if (v.leg === 'extra' && !v.title) return refuse('Another journey needs a short title, like "Flight to Tokyo".')
  if (v.leg === 'main' && v.title) return refuse('The main arrival and departure take no title. Leave title empty, or use leg="extra" for another journey.')

  // Dates and times.
  if (!dateLooksRight(ctx, v.date)) return refuse(BAD_DATE_MESSAGE)
  if (v.date < ctx.today) return refuse(passedMessage(v.date))
  const timeErr = checkTime('time', v.time)
  if (timeErr) return refuse(timeErr)
  const airport = v.airport_code == null ? null : cleanLine(v.airport_code).toUpperCase() || null
  if (airport && !/^[A-Z]{3}$/.test(airport)) return refuse('The airport code must be 3 letters, like LHR.')

  if (v.direction === 'departure' && (v.set_off_date || v.set_off_time)) return refuse('set_off_date and set_off_time are only for an arrival. For a departure use home_date and home_time.')
  if (v.direction === 'arrival' && (v.home_date || v.home_time)) return refuse('home_date and home_time are only for a departure. For an arrival use set_off_date and set_off_time.')
  if (v.set_off_time && !v.set_off_date) return refuse('set_off_time needs set_off_date.')
  if (v.home_time && !v.home_date) return refuse('home_time needs home_date.')
  const otherTimeErr = checkTime('set_off_time', v.set_off_time) ?? checkTime('home_time', v.home_time)
  if (otherTimeErr) return refuse(otherTimeErr)
  if (v.set_off_date) {
    if (!dateLooksRight(ctx, v.set_off_date)) return refuse(BAD_DATE_MESSAGE)
    const gap = daysBetween(v.set_off_date, v.date)
    if (gap < 0 || gap > 3) return refuse('Setting off must be on or up to 3 days before arriving.')
    if (v.set_off_date < ctx.today) return refuse(passedMessage(v.set_off_date))
  }
  if (v.home_date) {
    if (!dateLooksRight(ctx, v.home_date)) return refuse(BAD_DATE_MESSAGE)
    const gap = daysBetween(v.date, v.home_date)
    if (gap < 0 || gap > 3) return refuse('Getting home must be on or up to 3 days after leaving.')
  }

  // What the person has already saved: a main leg for this direction is replaced; 3 extras per direction at most.
  const own = await ownTravel(ctx)
  const sameDir = (own ?? []).filter((l) => l.direction === v.direction)
  if (v.leg === 'extra' && sameDir.filter((l) => !l.main).length >= MAX_EXTRA_LEGS) {
    return refuse(`You can add up to ${MAX_EXTRA_LEGS} extra journeys each way. Open travel details to remove one first.`)
  }
  const replaced = v.leg === 'main'
    ? [...sameDir.filter((l) => l.main)].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id))[0] ?? null
    : null

  const params: SetTravelParams = {
    id: replaced?.id ?? null,
    direction: v.direction,
    leg: v.leg,
    title: v.leg === 'extra' ? v.title : null,
    date: v.date,
    time: v.time,
    flight_ref: v.flight_ref,
    airport_code: airport,
    set_off_date: v.set_off_date,
    set_off_time: v.set_off_time,
    home_date: v.home_date,
    home_time: v.home_time,
    replaces_event_id: replaced?.id ?? null,
  }

  let otherEnd: string | null = null
  if (v.set_off_date) {
    const n = daysBetween(v.set_off_date, v.date)
    const lands = n === 0 ? '' : n === 1 ? ' · lands next day' : ` · lands ${n} days later`
    otherEnd = `${dayLabel(v.set_off_date, ctx.today)}${v.set_off_time ? ` ${v.set_off_time}` : ''}${lands}`
  } else if (v.home_date) {
    otherEnd = `${dayLabel(v.home_date, ctx.today)}${v.home_time ? ` ${v.home_time}` : ''}`
  }

  const preview: SetTravelPreview = {
    journey_label: v.leg === 'extra' ? `“${v.title}”` : v.direction === 'arrival' ? 'Arriving' : 'Leaving',
    when_label: whenLabel(ctx, v.date, v.time ? `${v.time} local` : null),
    other_end_label: otherEnd,
    ref: v.flight_ref,
    airport,
    ...dateFlags(ctx, v.date),
    replaces_label: replaced ? [`${dayLabel(replaced.date, ctx.today)}${replaced.time ? ` ${replaced.time}` : ''}`, replaced.ref].filter(Boolean).join(' · ') : null,
  }
  const basis: SetTravelBasis = {
    ...baseBasis(ctx, state),
    replaces_updated_at: replaced?.updated_at ?? null,
  }
  // A new leg is a tap; changing a saved one, or not being able to tell, is reviewed.
  const requires = replaced || own === null ? 'review' : 'tap'
  return storeProposal(ctx, { kind: 'set_travel', params, preview, basis, requires })
}

export const proposeSetMyTravel: ToolModule = {
  name: 'propose_set_my_travel',
  description:
    "Suggest saving the person's own travel: when they get to the trip (arrival), when they leave (departure), or another journey before or after (leg extra, e.g. flying to Tokyo first). Overnight flights: date = landing day, set_off_date = the day before. Only for the person asking. Dates a few days before or after the trip are normal. Nothing is saved until the person approves the card.",
  statusLabel: 'Preparing your travel…',
  inputSchema: setMyTravelSchema,
  run,
}
