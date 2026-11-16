/**
 * Pure model behind QuestionCard (proposal 5.3): the four states, the visible
 * lifecycle strip, the chip, "N of M answered" and the deadline. Everything is
 * derived from answers.ts so the chip here can never disagree with Today's
 * to-dos or the header count.
 *
 *   Open, needs your answer   chip "Needs your answer"   control expanded
 *   Open, answered            chip "Answered ✓"          control collapsed
 *   Decided                   chip "Decided"             strip Open ● Decided ● Booked ○
 *   Booked                    chip "Booked"              strip ● ● ●
 *   (Finished trip, never decided) muted "Closed — no decision recorded", no chip, no strip
 *
 * Own choices read the same way, with their own wording ("Answers closed" once
 * decided, "N of M done").
 */
import { isIdeasBucket } from '../../../lib/ideasBucket'
import {
  answerCounts,
  indexAnswers,
  isAnswerTodoCandidate,
  isOwnChoice,
  isTripFinished,
  questionAnswerState,
  type AnswerSection,
  type QuestionAnswerState,
} from '../../../lib/answers/answers'
import type { InScopeCandidate } from '../../people/lib/inScopePeople'
import type { TripStatus } from '../../../lib/tripStatus'
import { closesLabel } from '../../../lib/todos/copy'
import { resolveWinner } from './resolveDecision'
import { CLOSED_NO_DECISION, SHAPE_LABEL, INSTRUCTION } from './answerCopy'
import { answerMode, isViewerOut, liveOptions, type ModelPass, type ModelSection, type ModelVote } from './answerModel'

export const CARD_CHIP = {
  needsAnswer: 'Needs your answer',
  answered: 'Answered ✓',
  decided: 'Decided',
  booked: 'Booked',
} as const

export type CardStage = 'open' | 'decided' | 'booked' | 'closed'
export type ChipTone = 'warning' | 'success' | 'info' | 'neutral'

export interface CardChip {
  label: string
  tone: ChipTone
}

export interface StripStep {
  key: 'open' | 'decided' | 'booked'
  label: string
  state: 'done' | 'current' | 'todo'
}

export interface CardSection extends ModelSection {
  title: string
}

export interface CardInput {
  section: CardSection
  userId: string | null
  votes: ReadonlyArray<ModelVote>
  /** `undefined` when the passes query is unavailable: answers are then read from votes + selections only. */
  passes: ReadonlyArray<ModelPass> | undefined
  participants: ReadonlyArray<InScopeCandidate>
  trip: { status: TripStatus; start_date: string; end_date: string }
  /** Option ids with a live (non-cancelled) `bookings` row. Legacy `option.status === 'booked'` is read from the options. */
  bookedOptionIds?: ReadonlySet<string>
  now?: Date
}

export interface QuestionCardModel {
  sectionId: string
  title: string
  stage: CardStage
  /** Engine state from answers.ts (what the to-dos use). */
  viewerState: QuestionAnswerState
  chip: CardChip | null
  /** Dimmed card (Finished, never decided). */
  muted: boolean
  /** "Closed — no decision recorded" or null. */
  closedNote: string | null
  shape: 'group' | 'own'
  /** ["Group choice", "Pick one", "4 of 9 answered", "closes Fri 21 Nov"] joined with " · ". */
  subtitle: string
  counts: { answered: number; total: number; label: string }
  deadline: { iso: string; label: string; passed: boolean } | null
  /** Lifecycle strip; null when it would be noise (open own choice? no: shown for all non-closed). */
  strip: StripStep[] | null
  /** The winning option on Decided / Booked cards (group choices only). */
  decided: { optionId: string; title: string } | null
  /** Own choices: "Answers closed" once decided. */
  ownClosedLabel: string | null
  /** Show the answer control open by default (only when this person still needs to answer). */
  defaultExpanded: boolean
  /** The answer control is read-only here (Decided / Booked / closed): pass `closed` to AnswerControl. */
  answersClosed: boolean
}

function countLabel(shape: 'group' | 'own', answered: number, total: number): string {
  return shape === 'own' ? `${answered} of ${total} done` : `${answered} of ${total} answered`
}

export function buildQuestionCardModel(input: CardInput): QuestionCardModel {
  const { section, userId, votes, passes, participants, trip } = input
  const now = input.now ?? new Date()
  const own = isOwnChoice(section)
  const shape: 'group' | 'own' = own ? 'own' : 'group'
  const mode = answerMode(section)

  const finished = isTripFinished(trip, now)
  const viewerOut = isViewerOut(userId, participants)

  const index = indexAnswers([section as AnswerSection], { votes, passes })
  const viewerState = questionAnswerState(section as AnswerSection, userId ?? '', { index, tripFinished: finished, viewerOut })
  const counts = answerCounts(section.id, index, participants)

  // ---- winner / booked (group choices) ----------------------------------
  const live = liveOptions(section)
  const legacyBooked = live.find((o) => o.status === 'booked')
  const decidedByStatus = section.status === 'completed' || !!legacyBooked
  let decided: QuestionCardModel['decided'] = null
  if (!own && decidedByStatus) {
    // A booked option wins over the tally when the question was never stamped (display rule, proposal 2.3).
    const winner = resolveWinner(
      { status: 'completed', metadata: section.metadata ?? null, voting_method: section.voting_method ?? null, options: live.map((o) => ({ id: o.id, status: o.status ?? 'available', order_index: o.order_index, created_at: o.created_at, metadata: o.metadata })) },
      votes as never,
      { honourStampWhenOpen: true }
    )
    const stamped = winner.source === 'stamp'
    const winnerId = !stamped && legacyBooked ? legacyBooked.id : winner.optionId
    const option = live.find((o) => o.id === winnerId)
    if (option) decided = { optionId: option.id, title: option.title }
  }
  if (own && legacyBooked) decided = { optionId: legacyBooked.id, title: legacyBooked.title }
  const booked = !!decided && (input.bookedOptionIds?.has(decided.optionId) === true || live.find((o) => o.id === decided!.optionId)?.status === 'booked')

  // ---- stage -------------------------------------------------------------
  let stage: CardStage
  if (decidedByStatus) stage = booked ? 'booked' : 'decided'
  else if (finished) stage = 'closed'
  else stage = 'open'

  // The Ideas bucket is never owed: no "Needs your answer" chip, not expanded by default.
  const owed = !isIdeasBucket(section) && isAnswerTodoCandidate(section as AnswerSection, passes !== undefined)

  // ---- chip --------------------------------------------------------------
  let chip: CardChip | null = null
  if (stage === 'booked') chip = { label: CARD_CHIP.booked, tone: 'success' }
  else if (stage === 'decided') chip = { label: CARD_CHIP.decided, tone: 'success' }
  else if (stage === 'open') {
    // Same rule as the to-do: with the passes table missing, an Own choice without a deadline is not owed.
    if (viewerState === 'needs_answer' && !owed) chip = null
    else if (viewerState === 'needs_answer') chip = { label: CARD_CHIP.needsAnswer, tone: 'warning' }
    else if (viewerState === 'answered') chip = { label: CARD_CHIP.answered, tone: 'success' }
  }

  // ---- deadline ----------------------------------------------------------
  const deadline =
    stage === 'open' && section.vote_deadline
      ? { iso: section.vote_deadline, label: closesLabel(section.vote_deadline, now), passed: new Date(section.vote_deadline).getTime() < now.getTime() }
      : null

  const subtitleParts: string[] = [SHAPE_LABEL[shape]]
  if (stage === 'open') subtitleParts.push(INSTRUCTION[mode])
  // A decided/booked/closed question nobody answered (legacy decisions) must not say "0 of 9 answered".
  const hideCount = stage !== 'open' && counts.answered === 0
  if (!hideCount) subtitleParts.push(countLabel(shape, counts.answered, counts.total))
  if (deadline) subtitleParts.push(deadline.label)

  const strip: StripStep[] | null =
    stage === 'closed'
      ? null
      : (() => {
          const current = stage === 'open' ? 0 : stage === 'decided' ? 1 : 2
          const steps: Array<[StripStep['key'], string]> = [
            ['open', 'Open'],
            ['decided', 'Decided'],
            ['booked', 'Booked'],
          ]
          return steps.map(([key, label], i): StripStep => ({ key, label, state: i < current ? 'done' : i === current ? 'current' : 'todo' }))
        })()

  return {
    sectionId: section.id,
    title: section.title,
    stage,
    viewerState,
    chip,
    muted: stage === 'closed',
    closedNote: stage === 'closed' ? CLOSED_NO_DECISION : null,
    shape,
    subtitle: subtitleParts.join(' · '),
    counts: { answered: counts.answered, total: counts.total, label: hideCount ? '' : countLabel(shape, counts.answered, counts.total) },
    deadline,
    strip,
    decided,
    ownClosedLabel: own && stage !== 'open' && stage !== 'closed' ? 'Answers closed' : null,
    defaultExpanded: stage === 'open' && viewerState === 'needs_answer' && owed,
    answersClosed: stage !== 'open',
  }
}
