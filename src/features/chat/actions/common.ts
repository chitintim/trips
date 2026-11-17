import { toLocalDateString } from '../../../lib/localDate'
import { formatMoneyMinor } from '../../../lib/money'
import type { LiveData } from './types'

export const isStr = (v: unknown): v is string => typeof v === 'string'
export const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
export const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

const labelCache = new WeakMap<LiveData['roster'], Map<string, string>>()

/**
 * How each person on the roster is named on a card. "You" appears ONLY for the signed-in person (matched by user id, never by
 * name). Everyone else is shown by full name; a name that starts with "You" is marked "(not you)", and when two people would
 * read the same (same full name, or the same name as the viewer) a last initial, else "(not you)" / a number, tells them apart.
 */
function labelsFor(live: LiveData): Map<string, string> {
  const hit = labelCache.get(live.roster)
  if (hit) return hit
  const base = new Map<string, string>()
  for (const p of live.roster) {
    if (p.user_id === live.userId) continue
    const full = (p.name || '').trim().replace(/\s+/g, ' ') || 'Someone'
    base.set(p.user_id, /^you\b/i.test(full) ? `${full} (not you)` : full)
  }
  const me = live.roster.find((p) => p.user_id === live.userId)
  const myName = (me?.name || '').trim().toLowerCase()
  const out = new Map<string, string>()
  const groups = new Map<string, string[]>()
  for (const [id, label] of base) groups.set(label.toLowerCase(), [...(groups.get(label.toLowerCase()) ?? []), id])
  for (const [id, label] of base) {
    const same = groups.get(label.toLowerCase()) ?? []
    let l = label
    if (!l.endsWith('(not you)') && myName && l.toLowerCase() === myName) l = `${l} (not you)`
    if (same.length > 1) l = `${l} (${same.indexOf(id) + 1})`
    out.set(id, l)
  }
  labelCache.set(live.roster, out)
  return out
}

/** The name a card shows for someone ("You" only for the signed-in user, matched by id). */
export function personName(live: LiveData, userId: string | null | undefined, opts: { you?: 'You' | 'you' } = { you: 'You' }): string {
  if (!userId) return 'Someone'
  if (userId === live.userId) return opts.you ?? 'You'
  return labelsFor(live).get(userId) ?? 'Someone'
}

export function personActive(live: LiveData, userId: string): boolean {
  const p = live.roster.find((x) => x.user_id === userId)
  return !!p && p.active && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Fri 21 Nov" from YYYY-MM-DD (calendar maths in UTC, so it never shifts a day). */
export function formatDay(day: string, now: Date = new Date()): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  const year = d.getUTCFullYear() === now.getFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`
}

/** A visible warning for a date that is probably a mistake: any future date, or more than 60 days ago. */
export function dayWarning(day: string, now: Date = new Date()): string | null {
  const d = Date.parse(`${day}T00:00:00Z`)
  const t = Date.parse(`${toLocalDateString(now)}T00:00:00Z`)
  if (Number.isNaN(d)) return null
  if (d > t) return `This date (${formatDay(day, now)}) is in the future. Check it before you confirm.`
  const ago = Math.round((t - d) / 86_400_000)
  return ago > 60 ? `This date (${formatDay(day, now)}) is ${ago} days ago. Check it before you confirm.` : null
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** "Thu 20 Nov, 18:00" style deadline from an ISO time (viewer's clock). */
export function formatDeadline(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`
}

/** Exact money from integer minor units ("£40.00"). */
export function money(minor: number, currency: string): string {
  return formatMoneyMinor(minor, currency, { mode: 'exact' })
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

/** A plain list: "A, B and C". */
export function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export const FROZEN_CARD_MESSAGE = "Balances are frozen, so expenses can't be added. Ask an organizer to unfreeze them."
export const FINISHED_CARD_MESSAGE = 'This trip has finished, so this can no longer be added.'

const SOURCE_WORD: Record<string, string> = { todo: 'to-do', option: 'option', expense: 'expense' }

/**
 * Adds "from Sam's note"-style labels to quoted rows using the server's structured `content_origin`
 * (author name + source kind, computed from the trip's own data), never any model text.
 */
export function withOrigins<T extends { rows: Array<{ field?: string; quoted?: boolean; from?: string }> }>(view: T, preview: Record<string, unknown>): T {
  const origin = isObj(preview.content_origin) ? preview.content_origin : {}
  return {
    ...view,
    rows: view.rows.map((r) => {
      const o = r.field ? origin[r.field] : undefined
      if (!r.quoted || !isObj(o) || typeof o.author_name !== 'string' || !o.author_name.trim()) return r
      const word = typeof o.source === 'string' ? (SOURCE_WORD[o.source] ?? 'note') : 'note'
      return { ...r, from: `from ${o.author_name.trim().slice(0, 40)}'s ${word}` }
    }),
  }
}
