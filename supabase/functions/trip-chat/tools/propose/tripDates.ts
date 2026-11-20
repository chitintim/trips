/** Date and time checks shared by the travel and plan-item tools. Wording matches the set_my_travel / save_my_plan_item RPCs. */
import { dateNote, isBeyondTravelWindow, placeDate } from '../../../_shared/tripWindow.ts'
import type { ToolCtx } from '../types.ts'
import { daysBetween, dayLabel, isRealDate } from './common.ts'

export const BAD_DATE_MESSAGE = 'That date looks wrong. Check the year.'
export const BAD_TIME_MESSAGE = 'Times must be like 09:30 (24-hour, HH:MM).'

export const isTime = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

export const tripStart = (ctx: ToolCtx): string => ctx.trip.start_date.slice(0, 10)
export const tripEnd = (ctx: ToolCtx): string => ctx.trip.end_date.slice(0, 10)

/** A real date within 366 days of the trip start (the RPC's typo guard). Not a trip-date rule. */
export function dateLooksRight(ctx: ToolCtx, d: string): boolean {
  return isRealDate(d) && Math.abs(daysBetween(tripStart(ctx), d)) <= 366
}

export const passedMessage = (d: string): string => `That date (${d}) has already passed.`

/** "2 days before the trip" / "1 day after the trip", or null during the trip. Plain, never a warning. */
export function relativeToTrip(ctx: ToolCtx, d: string): string | null {
  const { place, daysOutside } = placeDate(d, tripStart(ctx), tripEnd(ctx))
  if (place === 'during') return null
  const n = `${daysOutside} day${daysOutside === 1 ? '' : 's'}`
  return place === 'before' || place === 'way_before' ? `${n} before the trip` : `${n} after the trip`
}

/** "Tue 8 Dec" + optional time + relative part. */
export function whenLabel(ctx: ToolCtx, d: string, timePart: string | null): string {
  const base = `${dayLabel(d, ctx.today)}${timePart ? ` ${timePart}` : ''}`
  const rel = relativeToTrip(ctx, d)
  return rel ? `${base} · ${rel}` : base
}

/** The note shown on the card, and whether to flag the date as far off. Never a reason to refuse. */
export function dateFlags(ctx: ToolCtx, d: string): { date_note: string | null; date_check: boolean } {
  return {
    date_note: dateNote(d, tripStart(ctx), tripEnd(ctx))?.text ?? null,
    date_check: isBeyondTravelWindow(d, tripStart(ctx), tripEnd(ctx)),
  }
}
