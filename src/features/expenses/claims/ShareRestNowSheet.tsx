import { Button, Modal, useToast } from '../../../components/ui'
import { useApplyDeadline, useApplyPreview } from '../../../lib/queries/useReceiptTable'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'
import { LEFTOVER_RULE } from '../../receipts/receiptFormat'
import { LeftoverPreviewBox } from './LeftoversSheet'
import { useReceiptPeople } from './useReceiptPeople'
import { describeTableError } from './receiptTable'

/**
 * "Share the rest now": confirm before the deadline applies today. Shows the leftovers preview first;
 * nothing is placed until the person confirms, and then the receipt closes for replies.
 */
export function ShareRestNowSheet({
  isOpen,
  onClose,
  expense,
  participants,
  tripId,
}: {
  isOpen: boolean
  onClose: () => void
  expense: Expense
  participants: ParticipantWithUser[]
  tripId: string
}) {
  const { showToast } = useToast()
  const apply = useApplyDeadline(tripId)
  const people = useReceiptPeople(expense, participants)
  // The database's own preview of the apply (same path, rolled back): exactly who is charged what when this is confirmed.
  const preview = useApplyPreview(isOpen ? { expenseId: expense.id, currency: expense.currency } : null)

  const confirm = async () => {
    try {
      await apply.mutateAsync({ expenseId: expense.id })
      showToast({ type: 'success', message: 'The rest is shared out' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: "Couldn't share the rest", description: describeTableError(err) })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share the rest now?">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          This closes replies on {expense.vendor_name || expense.description} today. Here is what it will charge:
        </p>
        <LeftoverPreviewBox preview={preview} people={people} participants={participants} currency={expense.currency} showRule={false} />
        <p className="text-xs text-[var(--text-muted)]">{LEFTOVER_RULE.replace(/^After that, a/, 'A')}</p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" onClick={confirm} isLoading={apply.isPending} disabled={preview.isLoading}>
            Share the rest now
          </Button>
        </div>
      </div>
    </Modal>
  )
}
