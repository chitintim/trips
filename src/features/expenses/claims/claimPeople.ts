import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'

export interface ReceiptPerson {
  id: string
  /** Short label for chips; first name, with an initial added when two people share a first name. */
  label: string
  participant: ParticipantWithUser
}

/**
 * Everyone tagged on the receipt -- the same rule as the server's _receipt_tagged: `participant_ids` when set, otherwise the whole
 * (in-scope) trip people list given; PLUS anyone who holds a non-leftover claim on the receipt (a "No reply yet" or departed person must
 * never be locked out of their own claim), and, when there is no explicit list, the payer. Only people present in `participants`
 * can be shown, and the participants' order is kept.
 */
export function taggedUserIds(
  expense: Pick<Expense, 'participant_ids' | 'paid_by'>,
  participants: Pick<ParticipantWithUser, 'user_id'>[],
  claims: Array<{ user_id: string; source?: string | null }> = [],
): Set<string> {
  const explicit = expense.participant_ids && expense.participant_ids.length > 0
  const ids = new Set<string>()
  for (const p of participants) if (!explicit || expense.participant_ids!.includes(p.user_id)) ids.add(p.user_id)
  for (const c of claims) if (c.source !== 'leftover') ids.add(c.user_id)
  if (!explicit && expense.paid_by) ids.add(expense.paid_by)
  return ids
}

export function peopleOnReceipt(
  expense: Pick<Expense, 'participant_ids' | 'paid_by'>,
  participants: ParticipantWithUser[],
  claims: Array<{ user_id: string; source?: string | null }> = [],
): ReceiptPerson[] {
  const ids = taggedUserIds(expense, participants, claims)
  const tagged = participants.filter((p) => ids.has(p.user_id))
  const firstNames = tagged.map((p) => firstNameOf(p))
  return tagged.map((p, i) => {
    const first = firstNames[i]
    const clash = firstNames.filter((n) => n === first).length > 1
    const full = (p.user.full_name ?? '').trim()
    const initial = full.includes(' ') ? ` ${full.split(/\s+/).slice(-1)[0][0]}.` : ''
    return { id: p.user_id, label: clash ? `${first}${initial}` : first, participant: p }
  })
}

export function firstNameOf(p: ParticipantWithUser): string {
  return p.user.full_name?.trim().split(/\s+/)[0] || p.user.email?.split('@')[0] || 'Someone'
}

/** Name for a user id from the participants list ("Someone" if unknown). */
export function nameOfUser(userId: string | null | undefined, participants: ParticipantWithUser[]): string {
  const p = participants.find((x) => x.user_id === userId)
  return p ? firstNameOf(p) : 'Someone'
}
