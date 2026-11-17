import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { receiptPeopleIds } from '../../../lib/todos/computeTodos'
import type { Expense } from '../../../types'
import { displayNames } from './claimNames'

export interface ReceiptPerson {
  id: string
  /** Short label for chips and totals: first name, plus the least extra needed when two people share one (see claimNames). */
  label: string
  /** Whole name, for aria-labels and titles. */
  fullName: string
  participant: ParticipantWithUser
}

/**
 * Everyone on the receipt: the ONE shared rule (`receiptPeopleIds`, the same one the to-dos use and the database's `_receipt_tagged` follows).
 * Only people present in `participants` can be shown, and the participants' order is kept.
 *
 * `opts.confirmationEnabled` (the trip's RSVP tracking switch) and `opts.responses` ("I wasn't there" removes someone) default to off/none:
 * callers that know them must pass them, or the list can differ from the one the server emails.
 */
/** A claim row as far as tagging is concerned (the quantity columns are absent on callers that only know the source). */
type TaggingClaim = { user_id: string; source?: string | null; line_item_id?: string; quantity_claimed?: number; leftover_quantity?: number | null }

export interface TaggingOptions {
  confirmationEnabled?: boolean
  /** Replies for THIS receipt. */
  responses?: ReadonlyArray<{ user_id: string; response: string }>
  /** The receipt's lines: shares of table items (`shared_by_all`) are derived by the database and never make someone "on the receipt". */
  lineItems?: ReadonlyArray<{ id: string; shared_by_all?: boolean | null }>
}

export function taggedUserIds(
  expense: Pick<Expense, 'participant_ids' | 'paid_by'>,
  participants: Pick<ParticipantWithUser, 'user_id' | 'active' | 'confirmation_status'>[],
  claims: TaggingClaim[] = [],
  opts: TaggingOptions = {},
): Set<string> {
  return receiptPeopleIds(
    { paid_by: expense.paid_by, participant_ids: expense.participant_ids, claims, line_items: opts.lineItems, responses: opts.responses },
    participants,
    opts.confirmationEnabled === true,
  )
}

export function peopleOnReceipt(
  expense: Pick<Expense, 'participant_ids' | 'paid_by'>,
  participants: ParticipantWithUser[],
  claims: TaggingClaim[] = [],
  opts: TaggingOptions = {},
): ReceiptPerson[] {
  const ids = taggedUserIds(expense, participants, claims, opts)
  const tagged = participants.filter((p) => ids.has(p.user_id))
  const names = displayNames(tagged.map((p) => ({ id: p.user_id, fullName: p.user.full_name, email: p.user.email })))
  return tagged.map((p) => ({ id: p.user_id, label: names.get(p.user_id)!.label, fullName: names.get(p.user_id)!.full, participant: p }))
}

/** Label for a user id: their label on the receipt when they are on it, else their first name ("Someone" if unknown). */
export function labelOfUser(userId: string | null | undefined, people: ReceiptPerson[], participants: ParticipantWithUser[]): string {
  return people.find((p) => p.id === userId)?.label ?? nameOfUser(userId, participants)
}

export function firstNameOf(p: ParticipantWithUser): string {
  return p.user.full_name?.trim().split(/\s+/)[0] || p.user.email?.split('@')[0] || 'Someone'
}

/** Name for a user id from the participants list ("Someone" if unknown). */
export function nameOfUser(userId: string | null | undefined, participants: ParticipantWithUser[]): string {
  const p = participants.find((x) => x.user_id === userId)
  return p ? firstNameOf(p) : 'Someone'
}
