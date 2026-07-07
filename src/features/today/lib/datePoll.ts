import type { Json } from '../../../types/database.types'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'

/**
 * "Trip dates" date-poll conventions (UX_REDESIGN.md Part 2, trip-creation
 * wizard): when the group votes on dates, the wizard creates a planning
 * section whose options each carry a candidate range in metadata, stores the
 * earliest candidate as the trip's placeholder start/end, and flags
 * `chase_settings.dates_pending` (+ the section id) in the trips jsonb — no
 * schema change. Today shows organizers a "set trip dates from winner" card
 * once the poll closes.
 */

export const TRIP_DATES_SECTION_TITLE = 'Trip dates'

export interface DateRange {
  start: string
  end: string
}

export interface DatesPendingState {
  pending: boolean
  sectionId: string | null
}

export function parseDatesPending(raw: Json | null | undefined): DatesPendingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { pending: false, sectionId: null }
  const r = raw as Record<string, unknown>
  return {
    pending: r.dates_pending === true,
    sectionId: typeof r.dates_section_id === 'string' ? r.dates_section_id : null,
  }
}

/**
 * Merge a patch into the raw chase_settings jsonb WITHOUT dropping keys we
 * don't know about (dates_pending must survive a ChaseSettingsSheet save and
 * vice versa).
 */
export function mergeChaseSettingsJson(raw: Json | null | undefined, patch: Record<string, Json | null>): Json {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, Json>) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k]
    else base[k] = v
  }
  return base as Json
}

/** Candidate range carried in an option's metadata (written by the wizard). */
export function optionDateRange(metadata: Json | null | undefined): DateRange | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const range = (metadata as Record<string, unknown>).date_range
  if (!range || typeof range !== 'object' || Array.isArray(range)) return null
  const r = range as Record<string, unknown>
  if (typeof r.start !== 'string' || typeof r.end !== 'string') return null
  return { start: r.start, end: r.end }
}

export interface DatePollWinner {
  optionId: string
  title: string
  range: DateRange
  votes: number
}

/** True once voting on the section is over (deadline passed or section closed). */
export function isDatePollClosed(section: Pick<SectionWithOptions, 'status' | 'vote_deadline'>, now = Date.now()): boolean {
  if (section.status === 'completed') return true
  if (section.vote_deadline && new Date(section.vote_deadline).getTime() <= now) return true
  return false
}

/**
 * Winning candidate range: most votes; ties break to the earliest start
 * date (predictable, and matches the wizard's "earliest candidate is the
 * placeholder" behavior). Null when no option carries a parseable range.
 */
export function computeDatePollWinner(section: SectionWithOptions, votes: OptionVote[]): DatePollWinner | null {
  const counts = new Map<string, number>()
  for (const v of votes) counts.set(v.option_id, (counts.get(v.option_id) || 0) + 1)

  let winner: DatePollWinner | null = null
  for (const option of section.options ?? []) {
    if (option.status === 'cancelled') continue
    const range = optionDateRange(option.metadata)
    if (!range) continue
    const n = counts.get(option.id) || 0
    if (
      !winner ||
      n > winner.votes ||
      (n === winner.votes && range.start < winner.range.start)
    ) {
      winner = { optionId: option.id, title: option.title, range, votes: n }
    }
  }
  return winner
}
