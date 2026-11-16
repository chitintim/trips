// Phase 4D "what moves by itself": the pure rules behind the auto-decide pass,
// the "We have an answer" announcement and the trip-stage sync. No service-role
// client in here (same rationale as ./chaseScope.ts), so every rule is
// unit-testable. index.ts does the I/O and calls these.

import { isOwnChoice } from '../_shared/answers/answers.ts'
import { DEEP_LINKS, formatMoney } from '../_shared/todos/copy.ts'
import { dateDerivedStage, TRIP_STAGE_ORDER, tripStageRank } from '../_shared/todos/deps/tripStage.ts'
import type { TripStatus } from '../_shared/todos/deps/tripStatus.ts'
import type { Json } from '../_shared/todos/deps/json.ts'
import { isAutoDecideOff, parseChaseSettings } from './chaseSettings.ts'
import { isIdeasBucket } from '../_shared/ideasBucket.ts'
import { isTripOpenForReminders } from './chaseScope.ts'

const HOUR_MS = 3600_000

/**
 * RESTRAINT WINDOW. Only questions whose answer-by deadline passed within the
 * last 48 hours are auto-decided. The first run after deploy would otherwise
 * decide every old question with a past deadline at once; older ones surface
 * to organizers as the existing "Decide: X" to-do instead.
 */
export const AUTO_DECIDE_WINDOW_HOURS = 48

/**
 * "We have an answer" is only announced for decisions logged in the last 26
 * hours (one daily run + 2h slack for a late/retried run). Never retroactive:
 * on the first run after deploy older decisions send nothing.
 */
export const DECISION_ANNOUNCE_WINDOW_HOURS = 26

export const DECISION_KIND = 'decision'

/**
 * Dedupe key in the `chase:<kind>:<entityId>:<userId>:<seq>` format. The entity
 * part is `<sectionId>:<optionId>` so the SAME decision is never announced
 * twice (seq is always 1) while a Reopen followed by a DIFFERENT decision is
 * a new key and is announced. (Nothing parses the key apart: the daily cap is
 * `like 'chase:%'` and the cap counter filters on kind/entity_id columns.)
 */
export function decisionDedupeKey(sectionId: string, optionId: string, userId: string): string {
  return `chase:${DECISION_KIND}:${sectionId}:${optionId}:${userId}:1`
}

// ---------------------------------------------------------------------------
// Auto-decide pass
// ---------------------------------------------------------------------------

export interface AutoDecideSectionRow {
  id: string
  title: string
  status: string
  vote_deadline: string | null
  metadata: Json | null
}

export interface AutoDecideTripRow {
  status?: string | null
  end_date?: string | null
  chase_settings?: unknown
}

/** Deadline bounds (ISO) for the candidate query: [now - 48h, now]. */
export function autoDecideDeadlineBounds(now: Date): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - AUTO_DECIDE_WINDOW_HOURS * HOUR_MS).toISOString(),
    to: now.toISOString(),
  }
}

/**
 * Per-trip switch. Automatic decisions are only made on trips where chasing
 * (`enabled`, the flag that gates the announcement emails) is ON, so every
 * automatic decision is announced; within those, `auto_decide` absent = ON and
 * only an explicit off value turns it off (see chaseSettings.isAutoDecideOff).
 */
export function tripAutoDecideOn(chaseSettings: unknown): boolean {
  if (!chaseSettings || typeof chaseSettings !== 'object' || Array.isArray(chaseSettings)) return false
  if (!parseChaseSettings(chaseSettings).enabled) return false
  return !isAutoDecideOff((chaseSettings as Record<string, unknown>).auto_decide)
}

/**
 * Should the job even ask the database to decide this question? (The SQL
 * function re-checks everything; this keeps the calls to the few that matter.)
 */
export function isAutoDecideCandidate(section: AutoDecideSectionRow, trip: AutoDecideTripRow, now: Date): boolean {
  if (section.status === 'completed') return false
  if (isOwnChoice({ metadata: section.metadata })) return false
  if (isIdeasBucket({ metadata: section.metadata })) return false
  if (!section.vote_deadline) return false
  const deadline = new Date(section.vote_deadline).getTime()
  if (Number.isNaN(deadline)) return false
  const t = now.getTime()
  if (deadline > t) return false
  if (deadline < t - AUTO_DECIDE_WINDOW_HOURS * HOUR_MS) return false
  if (!isTripOpenForReminders(trip, now)) return false
  return tripAutoDecideOn(trip.chase_settings)
}

export type AutoDecideOutcome =
  | { kind: 'decided'; sectionId: string; tripId: string | null; title: string; optionId: string | null; optionTitle: string | null }
  | { kind: 'tied'; sectionId: string }
  | { kind: 'skipped'; sectionId: string; reason: string }
  | { kind: 'invalid'; sectionId: string }

/** Read the jsonb `auto_decide_question` returns. Anything unexpected is "invalid" (logged, never fatal). */
export function interpretAutoDecideResult(sectionId: string, raw: unknown): AutoDecideOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid', sectionId }
  const r = raw as Record<string, unknown>
  if (r.decided === true) {
    return {
      kind: 'decided',
      sectionId,
      tripId: typeof r.trip_id === 'string' ? r.trip_id : null,
      title: typeof r.title === 'string' ? r.title : '',
      optionId: typeof r.option_id === 'string' ? r.option_id : null,
      optionTitle: typeof r.option_title === 'string' ? r.option_title : null,
    }
  }
  if (r.tied === true) return { kind: 'tied', sectionId }
  if (typeof r.skipped === 'string') return { kind: 'skipped', sectionId, reason: r.skipped }
  return { kind: 'invalid', sectionId }
}

/** True when an rpc error means "the function is not there yet" (migration not applied). */
export function isRpcMissingError(err: { code?: string; message?: string } | null | undefined, fn: string): boolean {
  if (!err) return false
  if (err.code === 'PGRST202' || err.code === '42883') return true
  const m = (err.message ?? '').toLowerCase()
  return m.includes(fn.toLowerCase()) && (m.includes('could not find') || m.includes('does not exist') || m.includes('schema cache'))
}

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
}

export interface AutoDecideSummary {
  attempted: number
  decided: number
  tied: number
  skipped: number
  errors: number
  /** True when the RPC does not exist; the pass stopped after the first call. */
  rpcMissing: boolean
}

/**
 * Call `auto_decide_question` for each candidate. FAIL-SOFT and idempotent:
 *  - a missing function (migration not applied) stops the pass quietly;
 *  - any other error on one question is logged and the next question runs;
 *  - a tie writes nothing (the organizer's "Tie: choose a winner" to-do is
 *    derived by the to-dos engine);
 *  - a decided question is no longer open, so a re-run never repeats it.
 * Never throws.
 */
export async function runAutoDecide(
  client: RpcClient,
  candidateIds: string[],
  log: { warn: (...a: unknown[]) => void } = console
): Promise<AutoDecideSummary> {
  const s: AutoDecideSummary = { attempted: 0, decided: 0, tied: 0, skipped: 0, errors: 0, rpcMissing: false }
  for (const id of candidateIds) {
    s.attempted++
    try {
      const { data, error } = await client.rpc('auto_decide_question', { p_section_id: id })
      if (error) {
        if (isRpcMissingError(error, 'auto_decide_question')) {
          s.rpcMissing = true
          log.warn('auto-chase: auto_decide_question is not installed yet, skipping auto-decide for this run')
          return s
        }
        s.errors++
        log.warn('auto-chase: auto_decide_question failed for', id, error.message ?? error)
        continue
      }
      const outcome = interpretAutoDecideResult(id, data)
      if (outcome.kind === 'decided') s.decided++
      else if (outcome.kind === 'tied') s.tied++
      else if (outcome.kind === 'skipped') s.skipped++
      else {
        s.errors++
        log.warn('auto-chase: unexpected auto_decide_question result for', id)
      }
    } catch (e) {
      s.errors++
      log.warn('auto-chase: auto_decide_question threw for', id, e instanceof Error ? e.message : e)
    }
  }
  return s
}

// ---------------------------------------------------------------------------
// "We have an answer" announcement
// ---------------------------------------------------------------------------

/** ISO lower bound for activity rows that count as "recently decided". */
export function decisionAnnounceSince(now: Date): string {
  return new Date(now.getTime() - DECISION_ANNOUNCE_WINDOW_HOURS * HOUR_MS).toISOString()
}

export interface DecisionActivityRow {
  actor: string | null
  created_at: string
  entity: Json | null
  metadata: Json | null
}

export interface RecentDecision {
  sectionId: string
  /** The option the activity row CLAIMS won. Only a claim: buildDecisionAnnouncement checks it against the section. */
  optionId: string
  /** Who decided (null for an automatic decision). They are not emailed. */
  actor: string | null
  decidedAt: string
}

function obj(v: Json | null | undefined): Record<string, Json | undefined> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json | undefined>) : {}
}

/**
 * `poll_closed` activity rows (organizer decisions AND auto-decisions log the
 * same verb) that name a winner, inside the announce window. One entry per
 * question (the latest). Own-choice closes carry no `decided_option_id` and are
 * therefore never announced.
 */
export function recentDecisionsFromActivity(rows: DecisionActivityRow[], now: Date): RecentDecision[] {
  const since = new Date(decisionAnnounceSince(now)).getTime()
  const latest = new Map<string, RecentDecision>()
  for (const r of rows) {
    const at = new Date(r.created_at).getTime()
    if (Number.isNaN(at) || at < since || at > now.getTime() + HOUR_MS) continue
    const entity = obj(r.entity)
    const meta = obj(r.metadata)
    if (typeof entity.id !== 'string' || typeof meta.decided_option_id !== 'string') continue
    // One per (question, claimed winner): a forged row naming another option
    // can then never shadow the real decision.
    const k = `${entity.id}:${meta.decided_option_id}`
    const prev = latest.get(k)
    if (!prev || at > new Date(prev.decidedAt).getTime()) {
      latest.set(k, { sectionId: entity.id, optionId: meta.decided_option_id, actor: r.actor, decidedAt: r.created_at })
    }
  }
  return [...latest.values()]
}

export interface DecisionOption {
  id: string
  title: string
  status?: string | null
  price?: number | null
  currency?: string | null
  price_type?: string | null
}

/** Plain-text price line from stored option fields ("£120 per person", "£480 in total"); null when there is none to state. */
export function decisionPriceLine(o: Pick<DecisionOption, 'price' | 'currency' | 'price_type'>): string | null {
  if (o.price == null || !(o.price > 0)) return null
  if (o.price_type === 'per_person_fixed') return `${formatMoney(o.price, o.currency)} per person`
  if (o.price_type === 'total_split') return `${formatMoney(o.price, o.currency)} in total`
  return null // tiered pricing has no single honest figure
}

export interface DecisionAnnouncement {
  sectionId: string
  /** The winner as stored on the section at send time (part of the dedupe key). */
  optionId: string
  /** `"Where to stay" — it's Hotel Kumo` */
  headline: string
  /** Optional detail lines: price, then who is booking it. */
  details: string[]
  link: string
}

export interface DecidedSectionRow {
  id: string
  title: string
  status: string
  metadata: Json | null
  options: DecisionOption[] | null
}

/**
 * Build the announcement for one decided question, or null when it should not
 * be announced (not closed, Own choice, the Ideas list, no winner stamp, winner
 * removed, or the activity row's claimed winner is not what the section really
 * holds). The activity feed is writable by any participant, so it is only a
 * hint: the section itself must be completed with that decided_option_id.
 * `bookerFirstName`: first name of whoever has the open "Book: ..." to-do.
 */
export function buildDecisionAnnouncement(
  section: DecidedSectionRow,
  appBaseUrl: string,
  tripId: string,
  bookerFirstName: string | null,
  claimedOptionId?: string
): DecisionAnnouncement | null {
  if (section.status !== 'completed') return null
  if (isOwnChoice({ metadata: section.metadata })) return null
  if (isIdeasBucket({ metadata: section.metadata })) return null
  const winnerId = obj(section.metadata).decided_option_id
  if (typeof winnerId !== 'string') return null
  if (claimedOptionId !== undefined && claimedOptionId !== winnerId) return null
  const winner = (section.options ?? []).find((o) => o.id === winnerId)
  if (!winner || winner.status === 'cancelled' || !winner.title) return null
  const details: string[] = []
  const price = decisionPriceLine(winner)
  if (price) details.push(price)
  if (bookerFirstName) details.push(`${bookerFirstName} is booking it`)
  return {
    sectionId: section.id,
    optionId: winnerId,
    headline: `"${section.title}" — it's ${winner.title}`,
    details,
    link: `${appBaseUrl}/${tripId}${DEEP_LINKS.question(section.id)}`,
  }
}

/**
 * Who receives the announcement: the people who were asked (the caller passes
 * the active, not-out participants), minus whoever made the decision. Pure.
 */
export function decisionRecipients(askedUserIds: string[], actor: string | null): string[] {
  return askedUserIds.filter((u) => u !== actor)
}

// ---------------------------------------------------------------------------
// Stage sync
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const DAY_MS = 86400_000

/** 00:00 UTC of a YYYY-MM-DD date, plus `addDays`. */
function utcBoundary(date: string, addDays: number): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + addDays * DAY_MS
}

/**
 * The stored status a trip should move FORWARD to because its dates say so,
 * or null. Setting-free rule: never touches a trip with a missing/odd/inverted
 * date, never moves backwards, never moves a finished trip.
 *
 * It must not fight an organizer: `lastHumanStatusChangeAt` is the newest
 * `status_changed` activity row written by a person (actor not null / not
 * auto). When one is NEWER than the relevant date boundary (start 00:00 UTC for
 * trip_ongoing, end_date + 1 day 00:00 UTC for trip_completed) the person
 * decided the status after the dates passed, so it is left alone. Completion
 * waits until that boundary (the day AFTER end_date, UTC) has passed.
 */
export function stageSyncTarget(
  trip: { status: string | null; start_date: string | null; end_date: string | null },
  todayIso: string,
  lastHumanStatusChangeAt: string | null = null
): TripStatus | null {
  if (!trip.status || !trip.start_date || !trip.end_date) return null
  if (!DATE_RE.test(trip.start_date) || !DATE_RE.test(trip.end_date)) return null
  if (trip.start_date.slice(0, 10) > trip.end_date.slice(0, 10)) return null
  const derived = dateDerivedStage({ start_date: trip.start_date, end_date: trip.end_date }, todayIso.slice(0, 10))
  if (!derived) return null
  const stored = trip.status as TripStatus
  if (!TRIP_STAGE_ORDER.includes(stored)) return null // unknown stored value: leave it alone
  if (!(tripStageRank(derived) > tripStageRank(stored))) return null
  const boundary = derived === 'trip_completed' ? utcBoundary(trip.end_date, 1) : utcBoundary(trip.start_date, 0)
  // Completion only once the day after end_date has begun (UTC).
  if (derived === 'trip_completed' && Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`) < boundary) return null
  if (lastHumanStatusChangeAt) {
    const at = Date.parse(lastHumanStatusChangeAt)
    if (!Number.isNaN(at) && at > boundary) return null
  }
  return derived
}

/** Newest created_at among status_changed rows a person wrote (not the job's own `auto` rows). */
export function lastHumanStatusChange(rows: Array<{ actor: string | null; created_at: string; metadata: Json | null }>): string | null {
  let best: string | null = null
  for (const r of rows) {
    if (obj(r.metadata).auto === true) continue
    if (!best || Date.parse(r.created_at) > Date.parse(best)) best = r.created_at
  }
  return best
}
