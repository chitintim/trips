/**
 * The ONE definition of "has this person answered this question?".
 *
 * A person has answered a question when they have ANY of:
 *   - an `option_votes` row on one of its options (Group choice), or
 *   - a `selections` row on one of its options (Own choice, plus v1 / Grid
 *     leftovers on vote-shaped questions), or
 *   - a pass ("No preference" / "None for me") on the question. Passes are
 *     stored in the additive `question_passes` table that arrives in Phase 2;
 *     every function here already accepts them as an optional input so the
 *     rest of the app does not change when the table lands.
 *
 * Every chip ("Needs your answer" / "Answered ✓"), every "N of M answered"
 * line, the to-dos engine, action auto-tick and blockers read through this
 * module, so they cannot disagree. Pure: no React, no Supabase.
 *
 * Scope rule (the only one, used for BOTH who is asked and the "N of M"
 * denominator): an ACTIVE participant who has not declined or cancelled is
 * asked (`isAnswerer`). Pending, interested, conditional and waitlisted people
 * are still potential attendees, so they are asked and counted; only people
 * who are OUT are not. `answerCounts` and the to-dos engine both use it, so
 * "Decide (all 9 answered)" can never coexist with someone still holding the
 * to-do. (Cost splits use the narrower `inScopePeople`; questions deliberately
 * do not, because a no-reply-yet person has not said they are out.)
 *
 * Finished-trip rule: on a Finished trip (effective stage `trip_completed`)
 * a question that was never decided is "Closed — no decision" and is never
 * "Needs your answer". `questionAnswerState` applies it.
 */
import type { Json } from '../../types/database.types'
import type { TripStatus } from '../tripStatus'
import { effectiveTripStage } from '../tripStage'
import { getDecisionShape } from '../../features/decisions/lib/decisionShapes'
import type { InScopeCandidate } from '../../features/people/lib/inScopePeople'
import type { SectionVoterIds } from '../actionCompletion/sectionVoters'

/**
 * PHASE 2 SWITCH. Until "No preference" / "None for me" passes exist, a person
 * who wants nothing from an Own-choice question has no way to clear it, so an
 * Own-choice question WITHOUT a deadline is not a to-do (it stays answerable in
 * Plan and keeps its chip). One with a deadline still is. When
 * `question_passes` and its UI land, set this to `true` and Own-choice
 * questions become to-dos with or without a deadline.
 */
export const OWN_CHOICE_WITHOUT_DEADLINE_IS_TODO = false

// ---------------------------------------------------------------------------
// Input shapes (structural, so generated DB rows and query results fit as-is)
// ---------------------------------------------------------------------------

export type AnswerSource = 'vote' | 'selection' | 'pass'

/** Why someone answered without choosing an option. */
export type PassKind = 'no_preference' | 'none_for_me'

export interface AnswerOption {
  id: string
  /** 'cancelled' options do not make a question answerable but old answers on them still count. */
  status?: string | null
  /** Selections nested on the option (the shape `useSections` returns). */
  selections?: ReadonlyArray<{ user_id: string }> | null
}

export interface AnswerSection {
  id: string
  status?: string | null
  metadata?: Json | null
  options: ReadonlyArray<AnswerOption>
}

export interface AnswerVote {
  option_id: string
  user_id: string
  rank?: number | null
}

export interface AnswerSelection {
  option_id: string
  user_id: string
}

/** A row of the Phase 2 `question_passes` table. */
export interface AnswerPass {
  section_id: string
  user_id: string
  kind: PassKind
}

export interface AnswerInputs {
  votes: ReadonlyArray<AnswerVote>
  /** Flat selection rows. Optional: selections nested on `section.options[].selections` are always read too. */
  selections?: ReadonlyArray<AnswerSelection>
  /** Phase 2 extension point. Omit until `question_passes` exists. */
  passes?: ReadonlyArray<AnswerPass>
}

// ---------------------------------------------------------------------------
// answersFor / hasAnswered
// ---------------------------------------------------------------------------

export interface UserAnswer {
  userId: string
  /** Options this person voted for or selected. */
  optionIds: Set<string>
  /** option id -> rank, for ranked group choices. */
  ranks: Map<string, number>
  /** True when they answered with "No preference" / "None for me". */
  passed: boolean
  passKind: PassKind | null
  /** Where the answer came from (a person can have several). */
  sources: Set<AnswerSource>
}

function emptyAnswer(userId: string): UserAnswer {
  return { userId, optionIds: new Set(), ranks: new Map(), passed: false, passKind: null, sources: new Set() }
}

/** section id -> user id -> their answer. Build once per render with `indexAnswers`. */
export type AnswerIndex = Map<string, Map<string, UserAnswer>>

/**
 * Every answer on ONE question: the union of votes, selections and passes.
 * People with no answer are absent from the map.
 */
export function answersFor(section: AnswerSection, inputs: AnswerInputs): Map<string, UserAnswer> {
  const optionIds = new Set(section.options.map((o) => o.id))
  const result = new Map<string, UserAnswer>()
  const get = (userId: string) => {
    let a = result.get(userId)
    if (!a) {
      a = emptyAnswer(userId)
      result.set(userId, a)
    }
    return a
  }

  for (const v of inputs.votes) {
    if (!optionIds.has(v.option_id)) continue
    const a = get(v.user_id)
    a.optionIds.add(v.option_id)
    a.sources.add('vote')
    if (v.rank != null) a.ranks.set(v.option_id, v.rank)
  }

  const addSelection = (optionId: string, userId: string) => {
    const a = get(userId)
    a.optionIds.add(optionId)
    a.sources.add('selection')
  }
  for (const o of section.options) {
    for (const s of o.selections ?? []) addSelection(o.id, s.user_id)
  }
  for (const s of inputs.selections ?? []) {
    if (optionIds.has(s.option_id)) addSelection(s.option_id, s.user_id)
  }

  for (const p of inputs.passes ?? []) {
    if (p.section_id !== section.id) continue
    const a = get(p.user_id)
    a.passed = true
    a.passKind = p.kind
    a.sources.add('pass')
  }

  return result
}

/** `answersFor` for every section at once. */
export function indexAnswers(sections: ReadonlyArray<AnswerSection>, inputs: AnswerInputs): AnswerIndex {
  const index: AnswerIndex = new Map()
  for (const s of sections) index.set(s.id, answersFor(s, inputs))
  return index
}

/** The single "has this person answered?" predicate. */
export function hasAnsweredIn(index: AnswerIndex, sectionId: string, userId: string): boolean {
  return index.get(sectionId)?.has(userId) ?? false
}

/** Convenience for one-off checks; prefer `indexAnswers` + `hasAnsweredIn` in loops. */
export function hasAnswered(section: AnswerSection, userId: string, inputs: AnswerInputs): boolean {
  return answersFor(section, inputs).has(userId)
}

/**
 * section_id -> ids of everyone who has answered it. This is what action
 * auto-tick reads (a vote-linked to-do ticks itself once you have answered,
 * whether by vote, selection or pass). Same shape as
 * `buildSectionVoters` in lib/actionCompletion/sectionVoters.ts.
 */
export function buildAnsweredSectionVoters(
  sections: ReadonlyArray<AnswerSection>,
  inputs: AnswerInputs
): SectionVoterIds {
  const result: SectionVoterIds = new Map()
  for (const s of sections) {
    const answerers = answersFor(s, inputs)
    if (answerers.size > 0) result.set(s.id, new Set(answerers.keys()))
  }
  return result
}

// ---------------------------------------------------------------------------
// Question state
// ---------------------------------------------------------------------------

/** Own choice = `decision_shape: 'personal'` (each person picks for themselves); everything else is a Group choice. */
export function isOwnChoice(section: Pick<AnswerSection, 'metadata'>): boolean {
  return getDecisionShape(section.metadata) === 'personal'
}

/** Options that can still be answered (not cancelled). */
export function liveOptionCount(section: AnswerSection): number {
  return section.options.filter((o) => o.status !== 'cancelled').length
}

/** A question is Open when it is not completed and has at least one live option. */
export function isQuestionOpen(section: AnswerSection): boolean {
  return section.status !== 'completed' && liveOptionCount(section) > 0
}

/** True when the trip's effective stage is Finished (stored status upgraded by dates, never downgraded). */
export function isTripFinished(
  trip: { status: TripStatus; start_date: string; end_date: string },
  now: Date | string = new Date()
): boolean {
  return effectiveTripStage(trip, now) === 'trip_completed'
}

export type QuestionAnswerState =
  /** Decided (completed). */
  | 'decided'
  /** Finished trip, never decided: "Closed — no decision". */
  | 'closed_no_decision'
  /** Nothing to answer yet (no live options). */
  | 'no_options'
  /** The viewer is out of the trip or inactive. */
  | 'not_applicable'
  /** Open and the viewer has answered: "Answered ✓". */
  | 'answered'
  /** Open and the viewer has not answered: "Needs your answer". */
  | 'needs_answer'

export interface QuestionStateContext {
  index: AnswerIndex
  /** `isTripFinished(trip, now)`. */
  tripFinished: boolean
  /** The viewer declined/cancelled or is inactive, so questions are not theirs to answer. */
  viewerOut?: boolean
}

/** The chip state of a question from one person's side. The to-dos engine uses exactly this. */
export function questionAnswerState(section: AnswerSection, userId: string, ctx: QuestionStateContext): QuestionAnswerState {
  if (section.status === 'completed') return 'decided'
  if (ctx.tripFinished) return 'closed_no_decision'
  if (liveOptionCount(section) === 0) return 'no_options'
  if (ctx.viewerOut) return 'not_applicable'
  return hasAnsweredIn(ctx.index, section.id, userId) ? 'answered' : 'needs_answer'
}

// ---------------------------------------------------------------------------
// Counts ("N of M answered") with ONE denominator
// ---------------------------------------------------------------------------

export interface AnswerCounts {
  /** Asked people who have answered. */
  answered: number
  /** Headcount of people who are asked (`isAnswerer`), the only denominator. */
  total: number
  answeredUserIds: string[]
  /** Asked people who have not answered. */
  waitingUserIds: string[]
}

/** Who owes an answer (and is counted in "N of M"): active and not declined/cancelled. */
export function isAnswerer(p: InScopeCandidate): boolean {
  return p.active !== false && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled'
}

export function answerCounts(
  sectionId: string,
  index: AnswerIndex,
  participants: ReadonlyArray<InScopeCandidate>,
  // Kept for call-site compatibility: the scope no longer depends on it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _confirmationEnabled?: boolean
): AnswerCounts {
  const people = participants.filter(isAnswerer)
  const answeredUserIds: string[] = []
  const waitingUserIds: string[] = []
  for (const p of people) {
    if (hasAnsweredIn(index, sectionId, p.user_id)) answeredUserIds.push(p.user_id)
    else waitingUserIds.push(p.user_id)
  }
  return { answered: answeredUserIds.length, total: people.length, answeredUserIds, waitingUserIds }
}
