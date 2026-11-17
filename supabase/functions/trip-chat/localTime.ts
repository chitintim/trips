/**
 * "Today" for the person asking. The client may send `tz` (an IANA zone such as "America/Los_Angeles", or a fixed
 * offset such as "-08:00" / "+0530"); without it the day is the UTC day, as before.
 *
 * The shared to-do engine reads the calendar day with d.getFullYear()/getMonth()/getDate() (it mirrors the app,
 * where the browser's local day is used) while it compares deadlines with getTime(). LocalDay therefore keeps the
 * real instant and only changes the calendar getters, exactly like a browser Date does.
 */

/** Minutes east of UTC for a "+05:30" / "-0800" / "Z" style offset, or null. */
export function parseOffsetMinutes(tz: string): number | null {
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz.trim())
  if (!m) return /^(z|utc|gmt)$/i.test(tz.trim()) ? 0 : null
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0)
  if (Number(m[2]) > 14 || Number(m[3] ?? 0) > 59) return null
  return m[1] === '-' ? -mins : mins
}

/** Minutes east of UTC at `at` for an IANA zone, or null if the zone is unknown. */
function zoneOffsetMinutes(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
  } catch {
    return null
  }
}

/** Offset in minutes east of UTC for a client-sent tz string; 0 (UTC) when missing or unusable. */
export function resolveOffsetMinutes(tz: unknown, at: Date): number {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return 0
  return parseOffsetMinutes(tz) ?? zoneOffsetMinutes(tz, at) ?? 0
}

export class LocalDay extends Date {
  private readonly shifted: Date
  readonly offsetMinutes: number
  constructor(instant: number, offsetMinutes: number) {
    super(instant)
    this.offsetMinutes = offsetMinutes
    this.shifted = new Date(instant + offsetMinutes * 60_000)
  }
  override getFullYear(): number { return this.shifted.getUTCFullYear() }
  override getMonth(): number { return this.shifted.getUTCMonth() }
  override getDate(): number { return this.shifted.getUTCDate() }
  override getDay(): number { return this.shifted.getUTCDay() }
  override getHours(): number { return this.shifted.getUTCHours() }
  override getMinutes(): number { return this.shifted.getUTCMinutes() }
}

export function localNow(now: Date, tz: unknown): { now: LocalDay; today: string; offsetMinutes: number } {
  const offsetMinutes = resolveOffsetMinutes(tz, now)
  const d = new LocalDay(now.getTime(), offsetMinutes)
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { now: d, today, offsetMinutes }
}
