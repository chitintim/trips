/**
 * Pure rule behind the Manage sheet (proposal 5.3 / 5.7): which organiser
 * actions exist for a question in which state. No React; unit-tested.
 *
 *   Open (and the muted "Closed -- no decision" on a finished trip)
 *     Decide, See everyone's answers, Nudge, Question settings, Add option, Delete question
 *   Decided
 *     See everyone's answers, Put it on the plan (only when not on the plan yet), Add a to-do,
 *     Mark booked (+ Track booking when a booking row exists), Question settings, Reopen, Delete question
 *   Finished trip (any state): See everyone's answers, Reopen (decided/booked only), Delete question
 *   Booked / Done
 *     See everyone's answers, Track booking, Not booked after all, Reopen  (read-only summary)
 *
 * Participants (not `canManage`) get nothing at all.
 */
import type { CardStage } from './questionCardModel'

export type ManageActionId =
  | 'decide'
  | 'answers'
  | 'nudge'
  | 'settings'
  | 'add_option'
  | 'delete'
  | 'schedule'
  | 'add_todo'
  | 'booking'
  | 'mark_booked'
  | 'unmark_booked'
  | 'reopen'

export type ManageActionTone = 'primary' | 'default' | 'danger'

export interface ManageAction {
  id: ManageActionId
  label: string
  /** One short sentence under the label. */
  hint: string
  tone: ManageActionTone
}

export interface ManageContext {
  /** useTripPermissions().canManageTrip. */
  canManage: boolean
  stage: CardStage
  /** The trip is Finished: only read actions plus tidy-up (Reopen, Delete) are offered. */
  finished: boolean
  shape: 'group' | 'own'
  /** The question has at least one live option. */
  hasOptions: boolean
  /** Number of asked people who have not answered. */
  waitingCount: number
  /** A winner is recorded (group choice). */
  hasWinner: boolean
  /** The winner is already on the plan. */
  onThePlan: boolean
  /** A linked to-do already exists for the decision. */
  hasFollowupTodo: boolean
  /** A live booking row exists for the winner. */
  hasBooking: boolean
  /** The trip's Ideas bucket: collects suggestions, so it is never decided or nudged. */
  ideas?: boolean
}

export const MANAGE_COPY = {
  decide: { group: 'Decide', own: 'Close answers' },
  decideHint: {
    group: 'Choose the winner. This closes the question and shows everyone the results.',
    own: 'Stop taking answers. Everyone can still see what was chosen.',
  },
  decideNow: 'Decide now',
  decideNowHint: 'Record the outcome after the fact.',
  answers: 'See everyone’s answers',
  answersHint: 'Who answered what, and who has not answered yet.',
  nudge: 'Nudge people who haven’t answered',
  settings: 'Question settings',
  settingsHint: 'Title, kind, how people answer, answer-by date and when results show.',
  addOption: 'Add option',
  addOptionHint: 'Add another thing people can choose.',
  addIdea: 'Add an idea',
  addIdeaHint: 'Drop another suggestion on the list.',
  deleteIdeas: 'Delete the Ideas list',
  deleteIdeasHint: 'Removes the list and every idea on it.',
  delete: 'Delete question',
  deleteHint: 'Removes the question, its options and everyone’s answers.',
  schedule: 'Put it on the plan',
  scheduleHint: 'Give the winner a day and time on the plan.',
  addTodo: 'Add a to-do',
  addTodoHint: 'Something someone has to do now it is decided, like booking it.',
  markBooked: 'Mark booked',
  markBookedHint: 'Record the booking, the reference and what was paid.',
  unmarkBooked: 'Not booked after all',
  unmarkBookedHint: 'Undo Booked. The booking is cancelled and the to-do to book it comes back.',
  trackBooking: 'Track booking',
  trackBookingHint: 'See or update the booking details.',
  reopen: 'Reopen',
  reopenHint: 'Open the question again. Answers are kept.',
} as const

export function getManageActions(ctx: ManageContext): ManageAction[] {
  if (!ctx.canManage) return []
  const out: ManageAction[] = []
  const answers: ManageAction = { id: 'answers', label: MANAGE_COPY.answers, hint: MANAGE_COPY.answersHint, tone: 'default' }
  const settings: ManageAction = { id: 'settings', label: MANAGE_COPY.settings, hint: MANAGE_COPY.settingsHint, tone: 'default' }
  const del: ManageAction = { id: 'delete', label: MANAGE_COPY.delete, hint: MANAGE_COPY.deleteHint, tone: 'danger' }
  const reopen: ManageAction = { id: 'reopen', label: MANAGE_COPY.reopen, hint: MANAGE_COPY.reopenHint, tone: 'default' }
  const track: ManageAction = { id: 'booking', label: MANAGE_COPY.trackBooking, hint: MANAGE_COPY.trackBookingHint, tone: 'default' }
  const markBooked: ManageAction = { id: 'mark_booked', label: MANAGE_COPY.markBooked, hint: MANAGE_COPY.markBookedHint, tone: 'default' }
  const unmarkBooked: ManageAction = { id: 'unmark_booked', label: MANAGE_COPY.unmarkBooked, hint: MANAGE_COPY.unmarkBookedHint, tone: 'default' }

  // The Ideas list is never decided, nudged, booked or answered: only add an idea or delete the list.
  // (Each idea is edited or deleted from its own row.)
  if (ctx.ideas) {
    if (!ctx.finished) out.push({ id: 'add_option', label: MANAGE_COPY.addIdea, hint: MANAGE_COPY.addIdeaHint, tone: 'default' })
    out.push({ ...del, label: MANAGE_COPY.deleteIdeas, hint: MANAGE_COPY.deleteIdeasHint })
    return out
  }

  // Finished trip: read-only plus tidy-up. Nothing that starts new work.
  if (ctx.finished) {
    out.push(answers)
    if (ctx.stage === 'decided' || ctx.stage === 'booked') out.push(reopen)
    out.push(del)
    return out
  }

  if (ctx.stage === 'open' || ctx.stage === 'closed') {
    // "Close answers" only on a question that is still taking answers; a closed
    // one (decided after the fact) says "Decide now".
    if (ctx.hasOptions && !ctx.ideas) {
      out.push(
        ctx.stage === 'closed'
          ? { id: 'decide', label: MANAGE_COPY.decideNow, hint: MANAGE_COPY.decideNowHint, tone: 'primary' }
          : { id: 'decide', label: MANAGE_COPY.decide[ctx.shape], hint: MANAGE_COPY.decideHint[ctx.shape], tone: 'primary' }
      )
    }
    out.push(answers)
    if (ctx.stage === 'open' && ctx.waitingCount > 0 && !ctx.ideas) {
      out.push({
        id: 'nudge',
        label: MANAGE_COPY.nudge,
        hint: `${ctx.waitingCount} ${ctx.waitingCount === 1 ? 'person has' : 'people have'} not answered.`,
        tone: 'default',
      })
    }
    out.push(settings)
    out.push({ id: 'add_option', label: MANAGE_COPY.addOption, hint: MANAGE_COPY.addOptionHint, tone: 'default' })
    out.push(del)
    return out
  }

  if (ctx.stage === 'decided') {
    out.push(answers)
    if (ctx.hasWinner && !ctx.onThePlan) {
      out.push({ id: 'schedule', label: MANAGE_COPY.schedule, hint: MANAGE_COPY.scheduleHint, tone: 'primary' })
    }
    if (ctx.hasWinner && !ctx.hasFollowupTodo) {
      out.push({ id: 'add_todo', label: MANAGE_COPY.addTodo, hint: MANAGE_COPY.addTodoHint, tone: 'default' })
    }
    if (ctx.hasWinner) out.push(markBooked)
    if (ctx.hasWinner && ctx.hasBooking) out.push(track)
    out.push(settings, reopen, del)
    return out
  }

  // booked / done: read-only summary + the escape hatches that make sense
  out.push(answers)
  if (ctx.hasWinner && ctx.hasBooking) out.push(track)
  if (ctx.hasWinner) out.push(unmarkBooked)
  out.push(reopen)
  return out
}

/** Settings warning when the way people answer changes while answers already exist. */
export function answerKindChangeWarning(args: {
  answerCount: number
  oldKind: 'vote' | 'personal'
  newKind: 'vote' | 'personal'
  oldMethod?: string | null
  newMethod?: string | null
}): string | null {
  if (args.answerCount <= 0) return null
  if (args.oldKind !== args.newKind) {
    return `${args.answerCount} ${args.answerCount === 1 ? 'person has' : 'people have'} already answered. Their answers stay saved, but answers to the old kind stop counting for the new kind, so people will be asked to answer again. If you switch back, they count again.`
  }
  if (args.oldKind === 'vote' && (args.oldMethod ?? 'single') !== (args.newMethod ?? 'single')) {
    return `${args.answerCount} ${args.answerCount === 1 ? 'person has' : 'people have'} already answered. Their answers are kept, but may count differently, for example a ranked order read as plain picks.`
  }
  return null
}
