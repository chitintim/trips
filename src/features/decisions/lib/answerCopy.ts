/**
 * The ONE set of words for answering a question (proposal 2.1, 2.2, 5.3, 5.4,
 * 5.8). Every surface that shows an answer control or a question card takes
 * its labels from here so the app never again says "Vote" on one screen and
 * "Choose" on the next. Pure strings and tiny formatters; no React.
 */
import type { PassKind } from '../../../lib/answers/answers'
import type { AnswerMode } from './answerModel'

// ---------------------------------------------------------------------------
// Instructions, selected markers, disabled label
// ---------------------------------------------------------------------------

export const INSTRUCTION: Record<AnswerMode, string> = {
  single: 'Pick one',
  any: 'Pick any',
  ranked: 'Rank your top choices',
  own: 'Choose your own',
}

/** Marker on the row you picked. Ranked rows show an ordinal pill instead. */
export const SELECTED_MARKER: Record<Exclude<AnswerMode, 'ranked'>, string> = {
  single: '✓ Your answer',
  any: '✓',
  own: '✓',
}

/** Disabled label for a question that no longer takes answers. */
export const ANSWERS_CLOSED = 'Answers closed'

export const SHAPE_LABEL = { group: 'Group choice', own: 'Own choice' } as const

// ---------------------------------------------------------------------------
// Pass buttons ("No preference" / "None for me")
// ---------------------------------------------------------------------------

export const PASS_LABEL: Record<PassKind, string> = {
  no_preference: 'No preference',
  none_for_me: 'None for me',
}

/** Shown once you have passed, so the state is readable at a glance. */
export const PASSED_SUMMARY: Record<PassKind, string> = {
  no_preference: 'You said: No preference',
  none_for_me: 'You said: None for me',
}

// ---------------------------------------------------------------------------
// Toasts (5.8)
// ---------------------------------------------------------------------------

export const TOAST_SAVED = 'Answer saved'
export const TOAST_REMOVED = 'Answer removed'
export const TOAST_FAILED = 'Could not save your answer'

// ---------------------------------------------------------------------------
// Why the control is disabled
// ---------------------------------------------------------------------------

export const GATE_REASON = {
  decided: 'This question is decided, so answers are closed.',
  finished: 'This trip has finished, so there is nothing left to answer.',
  out: "You're not coming to this trip, so there is nothing for you to answer.",
  noOptions: 'There are no options to answer yet.',
  signedOut: 'Sign in to answer.',
  locked: 'This option is locked.',
} as const

/** An open question with no live options (only organizers ever see it listed). */
export const NO_OPTIONS_NOTE = 'No options yet.'
export const NO_OPTIONS_ORGANIZER_NOTE = 'No options yet. Open Manage and choose Add option so people can answer.'

export const CHANGE_ANY_TIME = 'Change it any time until it’s decided.'
export const RESULTS_HIDDEN = 'Results show when it’s decided.'
export const CLOSED_NO_DECISION = 'Closed — no decision recorded'

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
export function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** "1 person" / "4 people". */
export function peopleLabel(n: number): string {
  return n === 1 ? '1 person' : `${n} people`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) }
}

/** "17–21 Aug", "28 Aug – 3 Sep", "17 Aug" (same day), "17 Aug 2026 – 3 Jan 2027" across years. */
export function formatDateSpan(start: string, end: string): string {
  const s = parts(start)
  const e = parts(end)
  if (!s || !e) return `${start} – ${end}`
  if (s.y === e.y && s.m === e.m && s.d === e.d) return `${s.d} ${MONTHS[s.m]}`
  if (s.y !== e.y) return `${s.d} ${MONTHS[s.m]} ${s.y} – ${e.d} ${MONTHS[e.m]} ${e.y}`
  if (s.m === e.m) return `${s.d}–${e.d} ${MONTHS[s.m]}`
  return `${s.d} ${MONTHS[s.m]} – ${e.d} ${MONTHS[e.m]}`
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Friendly text for a failed answer write. The DB raises
 * "Voting is closed for this question" (HINT voting_closed) from the guard
 * triggers on option_votes and question_passes, and "Answers are closed for
 * this question" (HINT answers_closed) from the one on selections; we word that as answers being
 * closed. Accepts real Errors (what useAnswer throws) and plain objects.
 */
export function describeAnswerError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as { message: unknown }).message)
        : ''
  const hint = typeof err === 'object' && err && 'hint' in err ? String((err as { hint: unknown }).hint ?? '') : ''
  if (/voting is closed|answers are closed|voting_closed|answers_closed/i.test(raw) || hint === 'voting_closed' || hint === 'answers_closed') {
    return 'Answers are closed for this question, so your answer was not saved.'
  }
  if (/question_passes/i.test(raw) && /(does not exist|schema cache|could not find|relation)/i.test(raw)) {
    return "That option isn't available yet. Please try again in a little while."
  }
  if (/row-level security|permission denied/i.test(raw)) return "You can't answer this question."
  return raw || 'Your answer could not be saved.'
}
