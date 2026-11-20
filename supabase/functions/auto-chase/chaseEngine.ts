// Bridge between auto-chase's candidate loops and the shared "Your to-dos"
// engine (_shared/todos, a mirror of src/lib/todos). Pure and unit-testable:
// no service-role client in here.
//
// HOW THE ENGINE IS USED (Phase 1, slice 1F). auto-chase still generates its
// own CANDIDATES with today's narrow rules (a deadline inside 48h, an RSVP
// deadline inside 72h, T-14 travel, ...). The engine then acts as a FILTER:
// a candidate is only emailed while the engine agrees it is still a to-do for
// that person. The result is the intersection of the old and the new rule, so
// the set of emails can only shrink, never grow:
//   - selections (own-choice questions, grid answers) now count as answered;
//   - questions with no live option are not chased;
//   - RSVP / "date arrived" chases need RSVP tracking switched on;
//   - travel details are only chased for confirmed people (when RSVP is on),
//     and only until the trip starts.
// Questions with no deadline ARE to-dos in the app but are deliberately not
// emailed this phase (the candidate loops still require a deadline).
//
// The snapshot passed to the engine never marks anyone as an organiser, so
// the organiser-only kinds (decide / book / setup) are never produced here.

import { computeTodos } from '../_shared/todos/computeTodos.ts'
import { DEEP_LINKS } from '../_shared/todos/copy.ts'
import { type RsvpStanding, rsvpStanding, tripPlaces } from '../_shared/todos/deps/rsvpStanding.ts'
import { effectiveTripStage } from '../_shared/todos/deps/tripStage.ts'
import type { SnapshotSection, SnapshotTravelEvent, SnapshotVote, TripSnapshot } from '../_shared/todos/types.ts'
import { isOwnChoice, passKindFor, type AnswerPass } from '../_shared/answers/answers.ts'
import type { SectionVoterIds } from '../_shared/actionCompletion/sectionVoters.ts'
import type { Json } from '../_shared/todos/deps/json.ts'

export { DEEP_LINKS }

/** Absolute email link for a `?open=...` deep link (`link` comes from DEEP_LINKS). */
export function emailLink(appBaseUrl: string, tripId: string, link: string = ''): string {
  return `${appBaseUrl}/${tripId}${link}`
}

export const answerTodoId = (sectionId: string) => `answer:${sectionId}`
export const rsvpTodoId = (tripId: string) => `rsvp:${tripId}`
export const travelTodoId = (tripId: string) => `travel:${tripId}`

/** True for an "Own choice" question (`metadata.decision_shape === 'personal'`). */
export function isOwnChoiceSection(metadata: Json | null | undefined): boolean {
  return isOwnChoice({ metadata })
}

/** A `planning_sections` row as auto-chase selects it (options with nested votes + selections). */
export interface ChaseSectionRow {
  id: string
  title: string
  status: string
  vote_deadline: string | null
  voting_method: string | null
  metadata: Json | null
  options: Array<{
    id: string
    status: string | null
    option_votes: Array<{ user_id: string }> | null
    selections: Array<{ user_id: string }> | null
  }> | null
}

/** Reshape selected rows into the engine's section + vote inputs. */
export function toEngineSections(rows: ChaseSectionRow[]): { sections: SnapshotSection[]; votes: SnapshotVote[] } {
  const votes: SnapshotVote[] = []
  const sections: SnapshotSection[] = rows.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    vote_deadline: s.vote_deadline,
    voting_method: s.voting_method,
    metadata: s.metadata,
    options: (s.options ?? []).map((o) => {
      for (const v of o.option_votes ?? []) votes.push({ option_id: o.id, user_id: v.user_id })
      return { id: o.id, status: o.status ?? 'proposed', selections: o.selections ?? [] }
    }),
  }))
  return { sections, votes }
}

export interface EngineTripRow {
  id: string
  name: string
  status: string
  start_date: string
  end_date: string
  confirmation_enabled: boolean | null
  confirmation_deadline: string | null
  capacity_limit?: number | null
  base_currency?: string | null
}

export interface EngineParticipantRow {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
  conditional_type?: string | null
  conditional_date?: string | null
}

export interface EngineInput {
  trip: EngineTripRow
  participants: EngineParticipantRow[]
  sections?: SnapshotSection[]
  votes?: SnapshotVote[]
  /**
   * `question_passes` rows ("No preference" / "None for me") for the sections
   * above. A pass counts as answered, exactly as in the app. Omit (or []) when
   * the table is missing: the result is then identical to before passes existed.
   */
  passes?: AnswerPass[]
  travelEvents?: SnapshotTravelEvent[]
}

/**
 * Run the shared engine for each of `userIds` and return the ids of the
 * to-dos each one owes (`answer:<sectionId>`, `rsvp:<tripId>`, `travel:<tripId>`,
 * plus money/task ids when those inputs exist -- this bridge passes none).
 */
export function engineTodoIds(input: EngineInput, userIds: string[], now: Date): Map<string, Set<string>> {
  const snapshot: TripSnapshot = {
    trip: {
      id: input.trip.id,
      name: input.trip.name,
      status: input.trip.status as TripSnapshot['trip']['status'],
      start_date: input.trip.start_date,
      end_date: input.trip.end_date,
      confirmation_enabled: input.trip.confirmation_enabled,
      confirmation_deadline: input.trip.confirmation_deadline,
      capacity_limit: input.trip.capacity_limit ?? null,
      base_currency: input.trip.base_currency ?? 'GBP',
      created_by: null, // never an organiser: see header
    },
    participants: input.participants.map((p) => ({
      user_id: p.user_id,
      role: null,
      active: p.active,
      confirmation_status: p.confirmation_status,
      conditional_type: p.conditional_type,
      conditional_date: p.conditional_date,
    })),
    sections: input.sections ?? [],
    votes: input.votes ?? [],
    passes: input.passes ?? [],
    // passesAvailable stays unset on purpose: the email side stays conservative,
    // so an Own-choice question without a deadline is never emailed (the
    // candidate loops require a deadline anyway).
    actions: [],
    checklists: [],
    expenses: [],
    settlements: [],
    travelEvents: input.travelEvents ?? [],
  }
  const out = new Map<string, Set<string>>()
  for (const uid of userIds) out.set(uid, new Set(computeTodos(snapshot, uid, now).map((t) => t.id)))
  return out
}

/**
 * Who still owes an answer to "Are you coming?", per the one shared rule
 * (_shared/todos/deps/rsvpStanding.ts). `chaseable` is true only for `open`:
 * nobody is chased for an answer that can no longer change anything (trip
 * full, replies closed). Keyed by user id; includes every participant given.
 */
export function engineRsvpStandings(input: EngineInput, now: Date): Map<string, RsvpStanding> {
  const trip = input.trip
  const stage = effectiveTripStage(
    { status: trip.status as Parameters<typeof effectiveTripStage>[0]['status'], start_date: trip.start_date, end_date: trip.end_date },
    now
  )
  const places = tripPlaces({ ...trip, capacity_limit: trip.capacity_limit ?? null }, input.participants)
  const today = now.toISOString().slice(0, 10) // the server runs in UTC, like the engine's own local date
  const out = new Map<string, RsvpStanding>()
  for (const p of input.participants) {
    out.set(p.user_id, rsvpStanding({ trip: { ...trip, capacity_limit: trip.capacity_limit ?? null }, stage, person: p, places, today, now }))
  }
  return out
}

/**
 * Loop (c): who gets the "pending RSVP" reminder (the 72h window is checked by the caller). Needs
 * all three: a pending/interested answer, the engine still lists "Are you coming?" for them, and the
 * shared rule says they are `chaseable` (not when the trip is full or replies have closed).
 */
export function pendingRsvpChaseRecipients(input: EngineInput, now: Date): string[] {
  const ids = input.participants.map((p) => p.user_id)
  const owed = engineTodoIds(input, ids, now)
  const standings = engineRsvpStandings(input, now)
  return input.participants
    .filter((p) => p.confirmation_status === 'pending' || p.confirmation_status === 'interested')
    .filter((p) => owed.get(p.user_id)?.has(rsvpTodoId(input.trip.id)) === true)
    .filter((p) => standings.get(p.user_id)?.chaseable === true)
    .map((p) => p.user_id)
}

/**
 * Loop (d): who gets the "your date has arrived" reminder: a conditional answer whose stated date has
 * arrived (today, UTC), still a to-do for them, and `chaseable` under the shared rule.
 */
export function conditionalDateChaseRecipients(input: EngineInput, now: Date): string[] {
  const todayStr = now.toISOString().split('T')[0]
  const owed = engineTodoIds(input, input.participants.map((p) => p.user_id), now)
  const standings = engineRsvpStandings(input, now)
  return input.participants
    .filter((p) => owed.get(p.user_id)?.has(rsvpTodoId(input.trip.id)) === true)
    .filter((p) => standings.get(p.user_id)?.chaseable === true)
    .filter(
      (p) =>
        p.confirmation_status === 'conditional' &&
        (p.conditional_type === 'date' || p.conditional_type === 'both') &&
        !!p.conditional_date &&
        p.conditional_date <= todayStr
    )
    .map((p) => p.user_id)
}

/**
 * Is `now` inside the reminder window for a reply-by deadline: not yet past the
 * END of the deadline's calendar day (UTC), and at most 72h before that end.
 * A deadline stored at any time of day counts as its whole date.
 */
export function withinRsvpChaseWindow(deadlineIso: string, now: Date): boolean {
  const day = deadlineIso.slice(0, 10)
  const end = Date.parse(`${day}T00:00:00Z`) + 24 * 3600_000
  if (Number.isNaN(end)) return false
  const left = end - now.getTime()
  return left > 0 && left <= 72 * 3600_000
}

/** Claims are locked once balances are frozen (`trips.settlement_snapshot` set), so nobody is chased to claim. */
export function claimChaseOpen(settlementSnapshot: unknown): boolean {
  return settlementSnapshot == null
}

/**
 * Where a claim reminder points. The /claim/:code page works without the app;
 * with no code there is nothing to claim on, so fall back to the money tab
 * (`?open=settle`) rather than a dead "Claiming isn't open" page.
 */
export function claimEmailLink(appBaseUrl: string, tripId: string, claimCode: string | null | undefined): string {
  return claimCode ? `${appBaseUrl}/claim/${encodeURIComponent(claimCode)}` : emailLink(appBaseUrl, tripId, DEEP_LINKS.settle())
}

/**
 * Add pass-answers to a section -> answered-user-ids map (the action
 * auto-tick input), so a person who passed on a question is not chased for a
 * to-do linked to it. Only a pass of the kind the question accepts counts
 * (`passKindFor`), as in the app. Pure; can only ADD answered people, so the
 * set of recipients can only shrink. `sectionMetadata` maps section id -> its
 * `metadata`; sections missing from it are treated as Group choices.
 */
export function addPassesToSectionVoters(
  voters: SectionVoterIds,
  passes: ReadonlyArray<AnswerPass>,
  sectionMetadata: ReadonlyMap<string, Json | null>
): SectionVoterIds {
  if (passes.length === 0) return voters
  const out: SectionVoterIds = new Map([...voters].map(([k, v]) => [k, new Set(v)]))
  for (const p of passes) {
    if (p.kind !== passKindFor({ metadata: sectionMetadata.get(p.section_id) ?? null })) continue
    const set = out.get(p.section_id)
    if (set) set.add(p.user_id)
    else out.set(p.section_id, new Set([p.user_id]))
  }
  return out
}
