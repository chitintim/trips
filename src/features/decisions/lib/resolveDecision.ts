/**
 * The ONE winner rule for a planning question (decision).
 *
 * Previously four code paths picked a "winner" four different ways (the date
 * card recounted raw votes, getWinner broke ties by array order, the close
 * flow stamped, legacy fell back to the tally). Everything now goes through
 * `resolveWinner`:
 *
 *   1. RECORDED WINNER: `metadata.decided_option_id` (the organizer's explicit
 *      choice, which may override the tally) when it still points at an
 *      existing, non-cancelled option. Only consulted when the question is
 *      closed (`status === 'completed'`), unless `honourStampWhenOpen`.
 *   2. TALLY: highest score under the question's voting method (cancelled
 *      options excluded). Zero votes = no winner.
 *   3. TIE RULE (deterministic, documented):
 *        a. ranked polls: more first-choice (rank 1) votes wins;
 *        b. candidates that all carry `metadata.date_range` (the trip-dates
 *           poll): earliest start date wins, then earliest end date;
 *        c. lowest `order_index`, then earliest `created_at`, then option id
 *           (lexicographic). The last step makes the result independent of
 *           array order.
 *      `tied` is true whenever step 3 was needed, so the UI can say "tied"
 *      and ask an organizer to pick explicitly.
 *
 * Pure (no React/Supabase) so it is unit-testable.
 */
import { tallyVotes, type VotingMethod } from './voting'
import type { Json } from '../../../types/database.types'

export interface ResolverOption {
  id: string
  status: string
  order_index?: number | null
  created_at?: string | null
  metadata?: Json | null
}

export interface ResolverSection {
  status: string
  metadata: Json | null
  voting_method: string | null
  options: ResolverOption[]
}

export interface ResolverVote {
  option_id: string
  user_id: string
  rank?: number | null
}

export type WinnerSource = 'stamp' | 'tally' | 'tie-break' | 'none'

export interface ResolvedWinner {
  optionId: string | null
  source: WinnerSource
  /** True when more than one option shared the top score (tie rule applied). */
  tied: boolean
  /** Every option that shared the top score (length > 1 when tied). */
  tiedOptionIds: string[]
}

const NONE: ResolvedWinner = { optionId: null, source: 'none', tied: false, tiedOptionIds: [] }

function readStamp(metadata: Json | null | undefined): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, Json | undefined>).decided_option_id
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function dateRangeOf(metadata: Json | null | undefined): { start: string; end: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const r = (metadata as Record<string, unknown>).date_range
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { start, end } = r as Record<string, unknown>
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : null
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Tie-break comparator over the already-tied candidates (step 3b/3c). */
function compareTied(a: ResolverOption, b: ResolverOption): number {
  const ra = dateRangeOf(a.metadata)
  const rb = dateRangeOf(b.metadata)
  if (ra && rb) {
    const byStart = compareStrings(ra.start, rb.start)
    if (byStart !== 0) return byStart
    const byEnd = compareStrings(ra.end, rb.end)
    if (byEnd !== 0) return byEnd
  }
  const byOrder = (a.order_index ?? Number.MAX_SAFE_INTEGER) - (b.order_index ?? Number.MAX_SAFE_INTEGER)
  if (byOrder !== 0) return byOrder
  const byCreated = compareStrings(a.created_at ?? '', b.created_at ?? '')
  if (byCreated !== 0) return byCreated
  return compareStrings(a.id, b.id)
}

export interface ResolveWinnerOptions {
  /** Honour the recorded stamp even if the question is not closed. Default false. */
  honourStampWhenOpen?: boolean
  /** Skip the recorded stamp entirely (tally only), e.g. to pre-select in the close sheet. */
  ignoreStamp?: boolean
}

/** Resolve the winner of a question. See the file header for the rule. */
export function resolveWinner(
  section: ResolverSection,
  votes: ResolverVote[],
  opts: ResolveWinnerOptions = {}
): ResolvedWinner {
  const live = section.options.filter((o) => o.status !== 'cancelled')

  if (!opts.ignoreStamp && (section.status === 'completed' || opts.honourStampWhenOpen)) {
    const stamped = readStamp(section.metadata)
    if (stamped && live.some((o) => o.id === stamped)) {
      return { optionId: stamped, source: 'stamp', tied: false, tiedOptionIds: [] }
    }
  }

  if (live.length === 0) return NONE
  const optionIds = live.map((o) => o.id)
  const idSet = new Set(optionIds)
  const sectionVotes = votes.filter((v) => idSet.has(v.option_id))
  const method = (section.voting_method as VotingMethod) || 'single'
  const tallies = tallyVotes(optionIds, sectionVotes as never, method)

  const top = Math.max(...tallies.map((t) => t.score))
  if (!(top > 0)) return NONE

  let candidates = tallies.filter((t) => t.score === top).map((t) => t.optionId)
  const tiedOptionIds = candidates

  if (candidates.length > 1 && method === 'ranked') {
    const firstPlace = new Map<string, number>(candidates.map((id) => [id, 0]))
    for (const v of sectionVotes) {
      if (v.rank === 1 && firstPlace.has(v.option_id)) firstPlace.set(v.option_id, firstPlace.get(v.option_id)! + 1)
    }
    const bestFirst = Math.max(...firstPlace.values())
    candidates = candidates.filter((id) => firstPlace.get(id) === bestFirst)
  }

  if (candidates.length === 1) {
    return {
      optionId: candidates[0],
      source: tiedOptionIds.length > 1 ? 'tie-break' : 'tally',
      tied: tiedOptionIds.length > 1,
      tiedOptionIds,
    }
  }

  const byId = new Map(live.map((o) => [o.id, o]))
  const sorted = candidates.map((id) => byId.get(id)!).sort(compareTied)
  return { optionId: sorted[0].id, source: 'tie-break', tied: true, tiedOptionIds }
}

/** Convenience: just the winning option id (or null). */
export function resolveWinnerId(section: ResolverSection, votes: ResolverVote[], opts?: ResolveWinnerOptions): string | null {
  return resolveWinner(section, votes, opts).optionId
}

/** Shallow-merge a patch into a section's metadata without dropping other keys (decision stamps etc.). */
export function mergeSectionMetadata(existing: Json | null | undefined, patch: Record<string, Json>): Json {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, Json>) : {}
  return { ...base, ...patch } as Json
}

// ---------------------------------------------------------------------------
// Reopening a closed decision
// ---------------------------------------------------------------------------

/**
 * Metadata for a reopened decision: every other key (decision_shape, ...)
 * survives; the recorded winner and its follow-up link are cleared. Votes are
 * untouched (they live in option_votes).
 */
export function buildReopenedMetadata(existing: Json | null | undefined): Json {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, Json | undefined>) }
      : {}
  delete base.decided_option_id
  delete base.followup_action_id
  return base as Json
}

/** Update payload that reopens a closed question. */
export function buildReopenUpdate(existing: Json | null | undefined): { status: 'in_progress'; metadata: Json } {
  return { status: 'in_progress', metadata: buildReopenedMetadata(existing) }
}

/** Only a closed question can be reopened. */
export function canReopenDecision(section: { status: string }): boolean {
  return section.status === 'completed'
}

/**
 * Deleting the option that a closed question decided would silently promote
 * the runner-up. True when `optionId` is that decided option.
 */
export function isDecidedOption(section: ResolverSection, votes: ResolverVote[], optionId: string): boolean {
  return section.status === 'completed' && resolveWinnerId(section, votes) === optionId
}

/** May a vote be cast/withdrawn on this option? Closed questions and locked options say no. */
export function canVoteOnOption(section: { status: string } | undefined | null, option: { locked?: boolean | null } | undefined | null): { ok: boolean; reason: string | null } {
  if (section && section.status === 'completed') return { ok: false, reason: 'Voting has closed on this question.' }
  if (option?.locked) return { ok: false, reason: 'This option is locked.' }
  return { ok: true, reason: null }
}

/** Friendly text for a failed vote write (server trigger or RLS). */
export function describeVoteError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : ''
  if (/voting is closed|voting_closed/i.test(msg)) return 'Voting has closed on this question, so your vote was not saved.'
  if (/row-level security|permission/i.test(msg)) return "You don't have permission to vote here."
  return msg || 'Your vote could not be saved.'
}
