import { useMemo } from 'react'
import { useClaimResponses } from '../../../lib/queries/useClaimResponses'
import { useTrip, type ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'
import { peopleOnReceipt, type ReceiptPerson } from './claimPeople'

/**
 * Who is on this receipt, by the one shared rule (the to-dos and the database's `_receipt_tagged` use it too): it needs the trip's RSVP
 * switch and the receipt's "I wasn't there" replies, which this hook reads from the query cache, so no caller can forget them.
 */
export function useReceiptPeople(
  expense: Pick<Expense, 'id' | 'trip_id' | 'paid_by' | 'participant_ids'>,
  participants: ParticipantWithUser[],
  claims: Parameters<typeof peopleOnReceipt>[2] = [],
  lineItems?: NonNullable<Parameters<typeof peopleOnReceipt>[3]>['lineItems']
): ReceiptPerson[] {
  const { data: trip } = useTrip(expense.trip_id)
  const responses = useClaimResponses(expense.trip_id)
  const confirmationEnabled = trip?.confirmation_enabled === true
  const mine = useMemo(() => responses.rows.filter((r) => r.expense_id === expense.id), [responses.rows, expense.id])
  return useMemo(
    () => peopleOnReceipt(expense, participants, claims, { confirmationEnabled, responses: mine, lineItems }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expense.id, expense.paid_by, expense.participant_ids, participants, claims, lineItems, confirmationEnabled, mine]
  )
}
