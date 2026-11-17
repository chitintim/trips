/**
 * Wording and dates shared by the public receipt page (/receipt) and the signed-in screens.
 * ONE RULE for the reader: the deadline is shown on THEIR clock, with the UTC time in brackets (the deadline is a UTC instant: the trip has
 * no timezone). So the same deadline never reads as two different days on two screens. Emails cannot know the reader's zone and spell the
 * day in UTC; the to-dos (src/lib/todos/copy.ts) use the reader's local day too.
 */

const PARTS: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }

function parts(date: Date, timeZone: string | undefined): { day: string; time: string } {
  const out: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-GB', { ...PARTS, ...(timeZone ? { timeZone } : {}) }).formatToParts(date)) out[p.type] = p.value
  return { day: `${out.weekday} ${out.day} ${out.month}`, time: `${out.hour}:${out.minute}` }
}

/**
 * "Sat 21 Nov, 07:00 (Fri 20 Nov, 18:00 UTC)" on the reader's clock; "Fri 20 Nov, 19:00 (18:00 UTC)" when the UTC time is on the same day;
 * just "Fri 20 Nov, 18:00 UTC" when the reader is on UTC. `localZone` is only for tests; the default is the device's own zone.
 */
export function formatDeadline(iso: string, localZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const utc = parts(date, 'UTC')
  const local = parts(date, localZone)
  if (local.day === utc.day && local.time === utc.time) return `${utc.day}, ${utc.time} UTC`
  return `${local.day}, ${local.time} (${local.day === utc.day ? utc.time : `${utc.day}, ${utc.time}`} UTC)`
}

/** "Reply by Sat 21 Nov, 07:00 (Fri 20 Nov, 18:00 UTC)". */
export const replyByLine = (iso: string, localZone?: string): string => `Reply by ${formatDeadline(iso, localZone)}`

/** "Sat 21 Nov": the reader's own day, for short lines (the same day the to-dos show). */
export function formatDeadlineDay(iso: string, localZone?: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : parts(date, localZone).day
}

/** The one rule sentence people are told up front (proposal 2d). */
export const LEFTOVER_RULE =
  "After that, anything nobody has claimed is split between the people who haven't tapped \"That's everything\" (never more than an even share each), and the rest is shared by everyone."

export type DeadlineChoice = 'tomorrow' | 'three_days' | 'week' | 'custom'

export const DEADLINE_CHOICES: ReadonlyArray<{ value: DeadlineChoice; label: string }> = [
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'three_days', label: '3 days' },
  { value: 'week', label: '1 week' },
  { value: 'custom', label: 'Pick a time' },
]

const MAX_DAYS_AHEAD = 90

/** 18:00 UTC, `days` days after `now` (the server's default time of day). */
export function eveningUtc(now: Date, days: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 18, 0, 0))
}

export type DeadlinePick = { ok: true; iso: string; /** null = let the server choose its default (3 days). */ send: string | null } | { ok: false; error: string }

/** The deadline for a choice. `custom` is the value of a datetime-local input (the device's local time). */
export function pickDeadline(choice: DeadlineChoice, now: Date, customLocal = ''): DeadlinePick {
  if (choice === 'custom') {
    const d = new Date(customLocal)
    if (!customLocal || Number.isNaN(d.getTime())) return { ok: false, error: 'Pick a day and time.' }
    if (d.getTime() <= now.getTime()) return { ok: false, error: 'Pick a time in the future.' }
    if (d.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) return { ok: false, error: `Pick a time within ${MAX_DAYS_AHEAD} days.` }
    return { ok: true, iso: d.toISOString(), send: d.toISOString() }
  }
  const days = choice === 'tomorrow' ? 1 : choice === 'week' ? 7 : 3
  const d = eveningUtc(now, days)
  return { ok: true, iso: d.toISOString(), send: choice === 'three_days' ? null : d.toISOString() }
}
