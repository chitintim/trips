// Travel window: people travel up to a week either side of the trip. Pure, no imports.
// A twin lives at supabase/functions/_shared/tripWindow.ts (kept identical by the drift check).
// All date maths is UTC on YYYY-MM-DD strings, so local time zones never shift a day.

export const TRAVEL_WINDOW_DAYS = 7

export type TripDatePlace = 'way_before' | 'before' | 'during' | 'after' | 'way_after'
export interface TripDateInfo { place: TripDatePlace; daysOutside: number; inWindow: boolean }

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

function toUtcMs(date: string): number | null {
  const m = DATE_RE.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: string, n: number): string {
  const ms = toUtcMs(date)
  if (ms === null) return date
  return fromUtcMs(ms + n * DAY_MS)
}

export function travelWindow(start: string, end: string): { start: string; end: string } {
  return { start: addDays(start, -TRAVEL_WINDOW_DAYS), end: addDays(end, TRAVEL_WINDOW_DAYS) }
}

export function placeDate(date: string, start: string, end: string): TripDateInfo {
  const d = toUtcMs(date)
  const s = toUtcMs(start)
  const e = toUtcMs(end)
  if (d === null || s === null || e === null) return { place: 'during', daysOutside: 0, inWindow: true }
  if (d < s) {
    const daysOutside = Math.round((s - d) / DAY_MS)
    const inWindow = daysOutside <= TRAVEL_WINDOW_DAYS
    return { place: inWindow ? 'before' : 'way_before', daysOutside, inWindow }
  }
  if (d > e) {
    const daysOutside = Math.round((d - e) / DAY_MS)
    const inWindow = daysOutside <= TRAVEL_WINDOW_DAYS
    return { place: inWindow ? 'after' : 'way_after', daysOutside, inWindow }
  }
  return { place: 'during', daysOutside: 0, inWindow: true }
}

export function isBeyondTravelWindow(date: string | null | undefined, start: string, end: string): boolean {
  if (!date) return false
  const { place } = placeDate(date, start, end)
  return place === 'way_before' || place === 'way_after'
}

export function dayHeaderLabel(date: string, start: string, end: string): string {
  const { place } = placeDate(date, start, end)
  if (place === 'way_before' || place === 'before') return 'Before the trip'
  if (place === 'way_after' || place === 'after') return 'After the trip'
  const s = toUtcMs(start)
  const d = toUtcMs(date)
  if (s === null || d === null) return 'Day 1'
  return `Day ${Math.round((d - s) / DAY_MS) + 1}`
}

export function shortDayLabel(date: string, start: string, end: string): string {
  const { place } = placeDate(date, start, end)
  if (place === 'way_before' || place === 'before') return 'Before'
  if (place === 'way_after' || place === 'after') return 'After'
  return dayHeaderLabel(date, start, end)
}

export function dateNote(date: string, start: string, end: string): { tone: 'neutral' | 'check'; text: string } | null {
  const { place, daysOutside } = placeDate(date, start, end)
  if (place === 'during') return null
  const before = place === 'before' || place === 'way_before'
  const beyond = place === 'way_before' || place === 'way_after'
  const n = daysOutside
  if (beyond) {
    return {
      tone: 'check',
      text: before
        ? `${n} days before the trip starts. Check the date is right.`
        : `${n} days after the trip ends. Check the date is right.`,
    }
  }
  if (before) {
    return { tone: 'neutral', text: n === 1 ? 'The day before the trip starts.' : `${n} days before the trip starts.` }
  }
  return { tone: 'neutral', text: n === 1 ? 'The day after the trip ends.' : `${n} days after the trip ends.` }
}

// All trip days, plus a continuous run out to the furthest in-window item date on each side,
// plus each beyond-window item date on its own (not filled in); sorted, unique.
export function boardDays(itemDates: string[], start: string, end: string): string[] {
  const s = toUtcMs(start)
  const e = toUtcMs(end)
  if (s === null || e === null || e < s) return Array.from(new Set(itemDates.filter(d => toUtcMs(d) !== null))).sort()
  let lo = start
  let hi = end
  const extra = new Set<string>()
  for (const d of itemDates) {
    const info = placeDate(d, start, end)
    if (info.place === 'before' && d < lo) lo = d
    else if (info.place === 'after' && d > hi) hi = d
    else if (info.place === 'way_before' || info.place === 'way_after') extra.add(d)
  }
  const out = new Set<string>(extra)
  for (let ms = toUtcMs(lo) as number; ms <= (toUtcMs(hi) as number); ms += DAY_MS) out.add(fromUtcMs(ms))
  return Array.from(out).sort()
}
