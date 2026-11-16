/**
 * MANUAL MIRROR of src/lib/todos/copy.ts (Deno edge functions cannot import from src/).
 * Keep the code identical; only import specifiers and comments may differ.
 * Enforced by scripts/check-contract-drift.mjs.
 */
/**
 * Every user-facing string and deep link the to-dos engine produces, in one
 * place (proposal 3.3 / 3.4). Components and emails import from here instead
 * of re-typing copy. Pure.
 */
import type { TodoKind } from './types.ts'

// ---------------------------------------------------------------------------
// Deep links (?open=...), proposal 3.4
// ---------------------------------------------------------------------------

/** Build the `?open=` query string. Values with an id use `name:<id>`. */
const open = (value: string) => `?open=${value}`

export const DEEP_LINKS = {
  /** Today, scrolled to Your to-dos. Header pill + every email footer. */
  todos: () => open('todos'),
  /** StatusModal ("Are you coming?"). */
  rsvp: () => open('rsvp'),
  /** AnswerFlow on one question (a Decided question opens its card). */
  question: (sectionId: string) => open(`question:${sectionId}`),
  /** AnswerFlow over all open answers. */
  answerAll: () => open('answer-all'),
  /** To-dos sheet with this action highlighted. */
  todo: (actionId: string) => open(`todo:${actionId}`),
  /** To-dos sheet with this packing item highlighted. */
  bring: (checklistId: string) => open(`bring:${checklistId}`),
  /** Money > Settle up. */
  settle: () => open('settle'),
  /** MarkPaid / confirm sheet for one settlement. */
  payment: (settlementId: string) => open(`payment:${settlementId}`),
  /** Travel details sheet. */
  travelDetails: () => open('travel-details'),
  /** PlanItemSheet for a plan event or option. */
  item: (eventOrOptionId: string) => open(`item:${eventOrOptionId}`),
  /** NEW in 1A: itemised expense claim sheet (or /claim/:code page) for one expense. */
  claim: (expenseId: string) => open(`claim:${expenseId}`),
  /** NEW in 1A: organizer setup steps (invite / first question). */
  setup: () => open('setup'),
} as const

/** `/{tripId}?open=...` for `navigate()` or an email. */
export function todoHref(tripId: string, todo: { link: string }): string {
  return `/${tripId}${todo.link}`
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, no Intl locale surprises in tests)
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `12 Dec` from a YYYY-MM-DD date or an ISO timestamp (local time for timestamps). */
export function formatDayMonth(value: string): string {
  const d = parseDate(value)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function parseDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d, 12)
  }
  return new Date(value)
}

/**
 * "closes Fri" when the deadline is within the next 6 days, otherwise
 * "closes Fri 21 Nov". After the deadline: "deadline passed".
 */
export function closesLabel(deadline: string, now: Date): string {
  const d = parseDate(deadline)
  if (d.getTime() < now.getTime()) return 'deadline passed'
  const days = (d.getTime() - now.getTime()) / 86_400_000
  const wd = WEEKDAYS[d.getDay()]
  return days < 6 ? `closes ${wd}` : `closes ${wd} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** `£120`, `£4,698.61`, `¥15,000`: no decimals when the amount is whole. */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  const code = currency || 'GBP'
  const whole = Math.abs(amount - Math.round(amount)) < 0.005
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : undefined,
      maximumFractionDigits: whole ? 0 : undefined,
    }).format(whole ? Math.round(amount) : amount)
  } catch {
    return `${code} ${whole ? Math.round(amount) : amount.toFixed(2)}`
  }
}

// ---------------------------------------------------------------------------
// Row copy, proposal 3.3
// ---------------------------------------------------------------------------

/** Primary button text per kind. `answer` becomes "Choose" for Own choice (see `answerActionLabel`). */
export const TODO_ACTION_LABEL: Record<TodoKind, string> = {
  rsvp: 'Answer',
  answer: 'Answer',
  task: 'Done',
  pay: 'Pay',
  confirm_payment: 'Confirm',
  claim: 'Claim',
  travel: 'Add',
  waitlist_offer: 'Respond',
  org_decide: 'Decide',
  org_tie: 'Decide',
  org_book: 'Mark booked',
  org_setup: 'Set up',
}

export function answerActionLabel(shape: 'group' | 'own'): string {
  return shape === 'own' ? 'Choose' : 'Answer'
}

export const rsvpTitle = (tripName: string) => `Are you coming to ${tripName}?`

/** "Group choice · 4 of 9 answered · closes Fri" / "Choose your own · 3 of 9 done". */
export function answerSubtitle(
  shape: 'group' | 'own',
  done: number,
  total: number,
  closes: string | null
): string {
  const parts =
    shape === 'own'
      ? ['Choose your own', `${done} of ${total} done`]
      : ['Group choice', `${done} of ${total} answered`]
  if (closes) parts.push(closes)
  return parts.join(' · ')
}

/** "Everyone · due 12 Dec" / "You · overdue by 3 days" / "You". */
export function taskSubtitle(who: 'Everyone' | 'You', due: string | null, overdueDays: number | null): string {
  if (due && overdueDays != null && overdueDays > 0) {
    return `${who} · overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`
  }
  return due ? `${who} · due ${formatDayMonth(due)}` : who
}

export const bringTitle = (item: string) => `🎒 Bring: ${item}`
export const payTitle = (toName: string, amount: string) => `Pay ${toName} ${amount}`
export const settleUpTitle = (amount: string) => `Settle up: you owe ${amount}`
export const settleUpWaitingTitle = (amount: string) => `Settle up: you owe ${amount}, once balances are finalized`
export const SETTLE_UP_WAITING_SUBTITLE = 'An organizer needs to finalize the balances first'
export const freezeBalancesTitle = 'Freeze balances so people can settle'
export const FREEZE_BALANCES_SUBTITLE = 'The trip is over and people owe money, but they cannot pay until you freeze balances'
export const confirmPaymentTitle = (fromName: string, amount: string) => `Confirm ${fromName} paid you ${amount}`
export const claimTitle = (description: string, amount: string) => `Claim your items on ${description} (${amount})`
export const TRAVEL_TITLE = 'Add your flights or travel times'
export const waitlistOfferTitle = (tripName: string) => `A spot opened up on ${tripName}`

export function orgDecideTitle(
  question: string,
  reason: { kind: 'deadline_passed'; answered: number; total: number } | { kind: 'all_answered'; total: number }
): string {
  return reason.kind === 'deadline_passed'
    ? `Decide: ${question} (deadline passed, ${reason.answered} of ${reason.total} answered)`
    : `Decide: ${question} (all ${reason.total} answered)`
}
export const orgBookTitle = (option: string) => `Book: ${option}`
export const orgTieTitle = (question: string) => `Tie: pick a winner for ${question}`
export const ORG_SETUP_INVITE_TITLE = 'Invite people to the trip'
export const ORG_SETUP_QUESTION_TITLE = 'Ask the group your first question'

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Header pill, dashboard badge: "3 to-dos" (hide at 0). */
export const todoCountLabel = (n: number) => `${n} to-do${n === 1 ? '' : 's'}`

export const TODO_EMPTY_STATE = {
  headline: "You're all set ✓",
  body: "Nothing needs you right now. We'll email you if that changes.",
} as const

/** "Answer all (3) · about 2 min →" shown when there are 2 or more answer to-dos. */
export function answerAllLabel(count: number): string {
  const minutes = Math.max(1, Math.round(count * 0.7))
  return `Answer all (${count}) · about ${minutes} min →`
}

export const WAITING_ON_EMPTY = 'Nobody owes anything right now.'

/** Email footer link text (every email links to `?open=todos`). */
export const EMAIL_TODOS_FOOTER = 'See all your to-dos'

/** Organizer card on Today: "As organizer: waiting on 6 people · 2 to decide · 1 to book". */
export function organiserSummary(waitingPeople: number, toDecide: number, toBook: number): string {
  const parts = [`waiting on ${waitingPeople} ${waitingPeople === 1 ? 'person' : 'people'}`]
  if (toDecide > 0) parts.push(`${toDecide} to decide`)
  if (toBook > 0) parts.push(`${toBook} to book`)
  return `As organizer: ${parts.join(' · ')}`
}

export const ORGANISER_GROUP_HEADING = 'For you as organizer'
