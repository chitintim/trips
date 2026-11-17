import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'

export interface ReceiptPerson {
  id: string
  /** Short label for chips; first name, with an initial added when two people share a first name. */
  label: string
  participant: ParticipantWithUser
}

/** Everyone tagged on the receipt: `participant_ids` when set, otherwise the whole (active) trip -- the same rule the server uses. */
export function peopleOnReceipt(expense: Pick<Expense, 'participant_ids'>, participants: ParticipantWithUser[]): ReceiptPerson[] {
  const tagged = expense.participant_ids && expense.participant_ids.length > 0 ? participants.filter((p) => expense.participant_ids!.includes(p.user_id)) : participants
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
