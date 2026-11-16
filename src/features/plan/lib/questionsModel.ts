/**
 * Pure logic behind Plan's Questions and Days lenses (proposal 5.1, 5.3, 5.8).
 *
 * - `groupQuestions`: one list of questions grouped Open -> Decided -> Booked -> Closed, "needs your answer" first inside Open. Stage and viewer state come
 *   from `buildQuestionCardModel`, so the grouping always agrees with the chip
 *   on the card and with the to-dos engine.
 * - `defaultLens`: Questions while the viewer owes an answer, otherwise Days.
 * - `questionsEmptyState`: truthful empty copy.
 * - `selectDaysItems`: what the Days lens shows (no open-question options).
 *
 * No React, no vote logic: answering is QuestionCard / AnswerControl / useAnswer.
 */
import {
  buildQuestionCardModel,
  type CardInput,
  type CardSection,
  type CardStage,
} from '../../decisions/lib/questionCardModel'
import { isIdeasBucket } from '../../../lib/ideasBucket'
import type { PlanItem } from './planItems'

export type PlanLens = 'questions' | 'days' | 'map'

export interface GroupableSection extends CardSection {
  order_index?: number | null
}

export interface GroupQuestionsInput<S extends GroupableSection> {
  sections: ReadonlyArray<S>
  userId: string | null
  votes: CardInput['votes']
  passes: CardInput['passes']
  participants: CardInput['participants']
  trip: CardInput['trip']
  bookedOptionIds?: ReadonlySet<string>
  /** Organizers also see an open question that has no live options yet, so it can be given some (Manage > Add option). */
  canManage?: boolean
  now?: Date
}

export interface QuestionEntry<S extends GroupableSection> {
  section: S
  stage: CardStage
  needsAnswer: boolean
}

export interface QuestionGroups<S extends GroupableSection> {
  /** Open questions: needs-your-answer first, then answered (original order inside each). */
  open: QuestionEntry<S>[]
  decided: QuestionEntry<S>[]
  booked: QuestionEntry<S>[]
  /** "Closed, no decision": never decided and the trip is over (or the question was closed). Collapsed in the UI. */
  closed: QuestionEntry<S>[]
  /** Open questions the viewer still owes an answer to. */
  needsAnswerCount: number
  /** open + decided + booked + closed. */
  total: number
}

/**
 * A question with no live option has nothing to answer, so participants do not
 * see it. Organizers still do, otherwise it would be invisible and could never
 * be given options. Decided questions always show.
 */
export function isListable(section: GroupableSection, canManage = false): boolean {
  if (section.status === 'completed') return true
  if (canManage) return true
  return section.options.some((o) => o.status !== 'cancelled')
}

export function groupQuestions<S extends GroupableSection>(input: GroupQuestionsInput<S>): QuestionGroups<S> {
  const open: QuestionEntry<S>[] = []
  const answered: QuestionEntry<S>[] = []
  const decided: QuestionEntry<S>[] = []
  const booked: QuestionEntry<S>[] = []
  const closed: QuestionEntry<S>[] = []

  for (const section of input.sections) {
    if (!isListable(section, input.canManage)) continue
    const model = buildQuestionCardModel({
      section,
      userId: input.userId,
      votes: input.votes,
      passes: input.passes,
      participants: input.participants,
      trip: input.trip,
      bookedOptionIds: input.bookedOptionIds,
      now: input.now,
    })
    const entry: QuestionEntry<S> = { section, stage: model.stage, needsAnswer: model.viewerState === 'needs_answer' && model.stage === 'open' && !isIdeasBucket(section) }
    if (model.stage === 'open') (entry.needsAnswer ? open : answered).push(entry)
    else if (model.stage === 'decided') decided.push(entry)
    else if (model.stage === 'booked') booked.push(entry)
    else closed.push(entry)
  }

  const needsAnswerCount = open.length
  const openAll = [...open, ...answered]
  return {
    open: openAll,
    decided,
    booked,
    closed,
    needsAnswerCount,
    total: openAll.length + decided.length + booked.length + closed.length,
  }
}

/** Questions while the viewer owes any answer, otherwise Days. Never Map. */
export function defaultLens(groups: Pick<QuestionGroups<GroupableSection>, 'needsAnswerCount'>): PlanLens {
  return groups.needsAnswerCount > 0 ? 'questions' : 'days'
}

/** "Answer all (n)" shows when the viewer owes two or more answers. */
export function showAnswerAll(needsAnswerCount: number): boolean {
  return needsAnswerCount >= 2
}

/** `?open=answer-all` (handled by the trip shell). */
export const ANSWER_ALL_SEARCH = '?open=answer-all'

/** Group headings, matched to what each group holds. */
export const GROUP_HEADINGS = { open: 'Open', decided: 'Decided', booked: 'Booked', closed: 'Closed \u2014 no decision' } as const

export function groupHeading(label: string, count: number): string {
  return `${label} (${count})`
}

export interface QuestionsEmptyState {
  title: string
  description: string
  /** Organisers get "Ask the group" and the starter questions. */
  showAsk: boolean
  showStarters: boolean
}

/**
 * Empty states (5.8). Only called when there is nothing to list.
 * `allClear` is the separate, positive state: questions exist but none is open.
 */
export function questionsEmptyState(isOrganizer: boolean): QuestionsEmptyState {
  return {
    title: 'No questions yet.',
    description: "When the group needs to decide something, it'll show up here.",
    showAsk: isOrganizer,
    showStarters: isOrganizer,
  }
}

/** One quiet line shown above Decided when nothing is open but things have been decided. */
export const NOTHING_OPEN_NOTE = 'Nothing is open right now.'

export function daysBannerText(needsAnswerCount: number): string | null {
  if (needsAnswerCount <= 0) return null
  return `${needsAnswerCount} question${needsAnswerCount === 1 ? ' needs' : 's need'} your answer →`
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export interface DaysItems {
  /** Events plus booked/decided items; the board puts the dated ones on their day. */
  scheduled: PlanItem[]
  /** Decided or booked, but with no event/date yet: the small "Not scheduled yet" group. */
  notScheduled: PlanItem[]
}

/**
 * The Days lens shows what is happening, not what is being asked. Options of
 * open (or losing) questions never appear; they live in Questions. An option
 * appears only when its question is decided and it is the winner, or when it
 * is booked. Winners without a date go to `notScheduled`.
 */
export function selectDaysItems(items: ReadonlyArray<PlanItem>, decidedSectionIds: ReadonlySet<string>): DaysItems {
  const scheduled: PlanItem[] = []
  const notScheduled: PlanItem[] = []
  for (const item of items) {
    if (item.idKind === 'event') {
      scheduled.push(item)
      continue
    }
    const decidedWinner = item.isUnscheduledWinner && !!item.sectionId && decidedSectionIds.has(item.sectionId)
    const booked = item.stage === 'booked'
    if (!decidedWinner && !booked) continue
    if (decidedWinner && !booked) {
      // A decided winner with no event yet is "not scheduled", whatever date the option proposes.
      notScheduled.push(item)
    } else if (item.date) scheduled.push(item)
    else notScheduled.push(item)
  }
  return { scheduled, notScheduled }
}
