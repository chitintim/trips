/**
 * What the app hides, the read tools hide too (RLS lets every trip member
 * read every vote row; the UI is the only thing that hides them).
 *
 * Rule (src/features/decisions/lib/answerModel.ts areResultsVisible + voting.ts
 * areVotesVisible):
 *   Group choice: hide_votes_until_close (null counts as the database default,
 *                 true) hides who voted what and the leader.
 *   Own choice:   visible, unless the organiser set metadata.hide_own_choice_answers.
 *   Either way a decided question (status completed) and a passed answer-by
 *   deadline reveal everything.
 *
 * The signed-in person's OWN answer is always visible to them.
 * Organisers see everyone's answers in the app even while hidden ("See
 * everyone's answers", EveryonesAnswers.tsx: "Only organizers can see this
 * until then"), so a person who canManageTrip does here too.
 */
import { areVotesVisible } from '../../../_shared/todos/deps/voting.ts'
import { isOwnChoice } from '../../../_shared/answers/answers.ts'
import type { Json } from '../../../_shared/todos/deps/json.ts'

/** Flip to false to hide answers from organisers as well (stricter than the app). */
export const ORGANISERS_SEE_HIDDEN_ANSWERS = true

export const HIDE_OWN_CHOICE_ANSWERS_KEY = 'hide_own_choice_answers'

export interface VisibilitySection {
  status: string
  metadata?: Json | null
  vote_deadline?: string | null
  hide_votes_until_close?: boolean | null
}

function ownChoiceAnswersHidden(metadata: Json | null | undefined): boolean {
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && (metadata as Record<string, Json>)[HIDE_OWN_CHOICE_ANSWERS_KEY] === true
}

/** Can participants see who chose what on this question right now? (the app's areResultsVisible) */
export function areResultsVisible(section: VisibilitySection, now: Date): boolean {
  const hide = isOwnChoice(section) ? ownChoiceAnswersHidden(section.metadata) : section.hide_votes_until_close !== false
  return areVotesVisible({ vote_deadline: section.vote_deadline ?? null, hide_votes_until_close: hide, status: section.status }, now.getTime())
}

export interface AnswerVisibility {
  /** True when other people's answers (who chose what, the leader, per-option counts) may be shown to this viewer. */
  canSeeOthers: boolean
  /** The app shows everybody's answers to this viewer only because they are an organiser. */
  viaOrganiser: boolean
  /** The results are hidden from participants right now (whoever is asking). */
  hiddenFromParticipants: boolean
}

export function answerVisibility(section: VisibilitySection, viewer: { canManageTrip: boolean }, now: Date, replyIsPrivate = true): AnswerVisibility {
  const visible = areResultsVisible(section, now)
  if (visible) return { canSeeOthers: true, viaOrganiser: false, hiddenFromParticipants: false }
  // A reply stored in the shared (legacy) thread is readable by everyone: apply the strictest rule, never the organiser one.
  const organiser = ORGANISERS_SEE_HIDDEN_ANSWERS && viewer.canManageTrip && replyIsPrivate
  return { canSeeOthers: organiser, viaOrganiser: organiser, hiddenFromParticipants: true }
}

export const RESULTS_HIDDEN_NOTE = 'Results are hidden until the question is decided or its answer-by time passes. You can only see your own answer and how many people have answered.'
