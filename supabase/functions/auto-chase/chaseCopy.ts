// Email wording for the auto-chase digest, in the approved vocabulary
// (question / answer / to-do / "Are you coming?" / payment). Pure, so the
// strings are unit-testable. Row titles reuse the app's own builders from
// _shared/todos/copy.ts (a mirror of src/lib/todos/copy.ts) so an email line
// reads exactly like the to-do it points at.

import {
  claimTitle,
  formatMoney,
  rsvpTitle,
  TRAVEL_TITLE,
  waitlistOfferTitle,
} from '../_shared/todos/copy.ts'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Fri 12 Dec": a deadline for people. UTC calendar day, the same zone the
 * action-deadline ladder already uses for its due dates (index.ts formatDueDate).
 */
export function humanDay(iso: string): string {
  const d = new Date(iso)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** "Fri 12 Dec, 14:00 UTC": for short fuses (a waitlist offer) where the hour matters. */
export function humanDayTime(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${humanDay(iso)}, ${hh}:${mm} UTC`
}

/** Own choice -> 'Choose your own for "X"'; Group choice -> plain "answer". */
export function answerDescription(title: string, ownChoice: boolean, voteDeadlineIso: string): string {
  const lead = ownChoice ? `Choose your own for "${title}"` : `Answer the question "${title}"`
  return `${lead} before ${humanDay(voteDeadlineIso)}`
}

export function rsvpDescription(tripName: string, deadlineIso: string): string {
  return `${rsvpTitle(tripName)} Please reply before ${humanDay(deadlineIso)}.`
}

export function conditionalDateDescription(tripName: string, conditionalDate: string): string {
  return `You said you'd know by ${conditionalDate}. ${rsvpTitle(tripName)}`
}

export function waitlistOfferDescription(tripName: string, expiresAtIso: string): string {
  return `${waitlistOfferTitle(tripName)}! Respond before ${humanDayTime(expiresAtIso)} or it passes to the next person.`
}

export function claimDescription(expenseDescription: string, amount: number, currency: string): string {
  return claimTitle(expenseDescription, formatMoney(amount, currency))
}

/** 'Pay Tim £120 to settle up for "Japow"'. Without a known payee name: 'Pay £120 to settle up ...'. */
export function payDescription(tripName: string, amount: number, currency: string | null, payeeName?: string | null): string {
  const who = payeeName ? `${payeeName} ` : ''
  return `Pay ${who}${formatMoney(amount, currency)} to settle up for "${tripName}"`
}

/** 'Confirm Sam paid you £42.50 for "Japow"'. Without a known payer name: 'Confirm you received ...'. */
export function confirmPaymentDescription(tripName: string, amount: number, currency: string | null, payerName?: string | null): string {
  const money = formatMoney(amount, currency)
  return payerName ? `Confirm ${payerName} paid you ${money} for "${tripName}"` : `Confirm you received ${money} for "${tripName}"`
}

export function travelDescription(tripName: string): string {
  return `${TRAVEL_TITLE}: "${tripName}" is 2 weeks away.`
}
