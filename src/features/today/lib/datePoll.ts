import type { Json } from '../../../types/database.types'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import { resolveWinner } from '../../decisions/lib/resolveDecision'

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
  /** Where the answer came from (see resolveDecision.ts): recorded stamp, tally, tie rule, or no-votes fallback. */
  source: 'stamp' | 'tally' | 'tie-break' | 'earliest-candidate'
}

/** True once voting on the section is over (deadline passed or section closed). */
export function isDatePollClosed(section: Pick<SectionWithOptions, 'status' | 'vote_deadline'>, now = Date.now()): boolean {
  if (section.status === 'completed') return true
  if (section.vote_deadline && new Date(section.vote_deadline).getTime() <= now) return true
  return false
}

/**
 * Winning candidate range, via the shared resolver (decisions/lib/
 * resolveDecision.ts): the organizer's recorded winner first (so an explicit
 * tie-break is honoured), else the tally leader with the shared tie rule
 * (candidates with date ranges tie-break to the earliest start). With no
 * votes at all it falls back to the earliest candidate (the wizard's
 * placeholder). Null when no option carries a parseable range.
 */
export function computeDatePollWinner(section: SectionWithOptions, votes: OptionVote[]): DatePollWinner | null {
  const candidates = (section.options ?? []).filter((o) => o.status !== 'cancelled' && optionDateRange(o.metadata))
  if (candidates.length === 0) return null

  const resolved = resolveWinner({ ...section, options: candidates }, votes, { honourStampWhenOpen: true })
  let chosen = resolved.optionId ? candidates.find((o) => o.id === resolved.optionId) : undefined
  let source: DatePollWinner['source'] = resolved.source === 'none' ? 'earliest-candidate' : resolved.source
  if (!chosen) {
    chosen = [...candidates].sort((a, b) => optionDateRange(a.metadata)!.start.localeCompare(optionDateRange(b.metadata)!.start))[0]
    source = 'earliest-candidate'
  }
  const count = votes.filter((v) => v.option_id === chosen!.id).length
  return { optionId: chosen.id, title: chosen.title, range: optionDateRange(chosen.metadata)!, votes: count, source }
}
