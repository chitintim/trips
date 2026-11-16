/**
 * Plan-side question chips and counts. A thin delegate to the one shared
 * definition in src/lib/answers/answers.ts (see its header), so the Plan
 * chips, the "N of M answered" lines, Today's to-dos and the header count
 * cannot disagree:
 *
 *  - "answered" is the union of option_votes, selections and passes, so
 *    answering through the grid / own-choice path (which writes `selections`)
 *    clears "Needs your answer" the same as a vote does;
 *  - the denominator is the in-scope headcount (declined / cancelled /
 *    inactive people are not counted);
 *  - a Finished trip never says "Needs your answer".
 *
 * Chip words: "Needs your answer" / "Answered ✓" / "Decided" /
 * "Closed — no decision". Pure (no React/Supabase).
 */
import { TODO_EMPTY_STATE } from '../../../lib/todos/copy'
import {
  answerCounts,
  indexAnswers,
  isOwnChoice,
  isTripFinished,
  questionAnswerState,
  type AnswerIndex,
  type AnswerSection,
  type AnswerVote,
  type QuestionAnswerState,
} from '../../../lib/answers/answers'
import type { InScopeCandidate } from '../../people/lib/inScopePeople'
import type { TripStatus } from '../../../lib/tripStatus'

export type ResponseState = QuestionAnswerState

export type QuestionShape = 'group' | 'own'

export interface QuestionState {
  sectionId: string
  shape: QuestionShape
  state: QuestionAnswerState
  /** Chip text, or null when no chip should show (no options / viewer out of the trip). */
  label: string | null
  /** Chip colour. */
  tone: 'success' | 'warning' | 'neutral' | null
  /** In-scope people who have answered. */
  answered: number
  /** In-scope headcount: the only denominator. */
  total: number
  /** "4 of 9 answered" */
  countLabel: string
}

export const CHIP_NEEDS_ANSWER = 'Needs your answer'
export const CHIP_ANSWERED = 'Answered ✓'
export const CHIP_DECIDED = 'Decided'
export const CHIP_CLOSED_NO_DECISION = 'Closed — no decision'

export function formatAnsweredCount(answered: number, total: number): string {
  return `${answered} of ${total} answered`
}

const CHIPS: Record<QuestionAnswerState, { label: string | null; tone: QuestionState['tone'] }> = {
  needs_answer: { label: CHIP_NEEDS_ANSWER, tone: 'warning' },
  answered: { label: CHIP_ANSWERED, tone: 'success' },
  decided: { label: CHIP_DECIDED, tone: 'success' },
  closed_no_decision: { label: CHIP_CLOSED_NO_DECISION, tone: 'neutral' },
  no_options: { label: null, tone: null },
  not_applicable: { label: null, tone: null },
}

export interface QuestionStateInput {
  sections: ReadonlyArray<AnswerSection>
  votes: ReadonlyArray<AnswerVote>
  userId: string | null
  trip: { status: TripStatus; start_date: string; end_date: string; confirmation_enabled: boolean | null }
  participants: ReadonlyArray<InScopeCandidate>
  now?: Date | string
}

/** question state per section id, all from answers.ts. */
export function computeQuestionStates(input: QuestionStateInput): Map<string, QuestionState> {
  const { sections, votes, userId, trip, participants, now } = input
  const confirmationEnabled = trip.confirmation_enabled === true
  const index: AnswerIndex = indexAnswers(sections, { votes })
  const tripFinished = isTripFinished(trip, now)
  const me = userId ? participants.find((p) => p.user_id === userId) : undefined
  const viewerOut =
    !userId ||
    (!!me && (me.active === false || me.confirmation_status === 'declined' || me.confirmation_status === 'cancelled'))

  const result = new Map<string, QuestionState>()
  for (const section of sections) {
    const state = questionAnswerState(section, userId ?? '', { index, tripFinished, viewerOut })
    const { answered, total } = answerCounts(section.id, index, participants, confirmationEnabled)
    result.set(section.id, {
      sectionId: section.id,
      shape: isOwnChoice(section) ? 'own' : 'group',
      state,
      ...CHIPS[state],
      answered,
      total,
      countLabel: formatAnsweredCount(answered, total),
    })
  }
  return result
}

export interface GroupProgress {
  answered: number
  total: number
  /** "4 of 9 answered" */
  label: string
}

export function computeGroupProgress(states: Pick<QuestionState, 'state'>[]): GroupProgress {
  const total = states.length
  const answered = states.filter((s) => s.state === 'answered').length
  return { answered, total, label: formatAnsweredCount(answered, total) }
}

/** 30 seconds per open question, rounded to the nearest whole minute (minimum 1 when there's at least one open question). */
export function estimateAnswerMinutes(openCount: number): number {
  if (openCount <= 0) return 0
  return Math.max(1, Math.round(openCount * 0.5))
}

/** "3 questions need your answer · ~2 min" for the Decide lens entry card, or a calm all-done message when nothing's open. */
export function formatEntryCardLabel(openCount: number): string {
  if (openCount <= 0) return TODO_EMPTY_STATE.headline
  const minutes = estimateAnswerMinutes(openCount)
  return `${openCount} question${openCount === 1 ? '' : 's'} need${openCount === 1 ? 's' : ''} your answer · ~${minutes} min`
}
