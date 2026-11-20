import { useState } from 'react'
import { Modal, Button, useToast } from '../../../components/ui'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useResetConfirmations } from '../../../lib/queries/useConfirmations'
import { confirmationDeadlineDate } from '../lib/rsvpStanding'
import { todayLocal } from '../../../lib/localDate'
import { countDeclined, countResettableConfirmations, describeResetCount } from '../lib/resetConfirmations'

interface ResetConfirmationsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
}

/**
 * Confirm dialog for the organizer/admin "Reset confirmations" action. States
 * exactly how many confirmations will be cleared. The role check is enforced
 * by the RPC; callers additionally only render the trigger for organizers.
 */
export function ResetConfirmationsSheet({ isOpen, onClose, tripId }: ResetConfirmationsSheetProps) {
  const { data: participants } = useParticipants(tripId)
  const { data: trip } = useTrip(tripId)
  const reset = useResetConfirmations(tripId)
  const { showToast } = useToast()
  const [includeDeclined, setIncludeDeclined] = useState(false)

  const list = participants ?? []
  const count = countResettableConfirmations(list, includeDeclined)
  const declined = countDeclined(list)
  const deadlineDate = confirmationDeadlineDate(trip?.confirmation_deadline)
  const deadlinePassed = !!deadlineDate && deadlineDate < todayLocal()

  const handleReset = async () => {
    try {
      const result = await reset.mutateAsync({ includeDeclined })
      showToast({ type: 'success', message: `${describeResetCount(result.cleared)} cleared`, description: 'Everyone affected is back to No reply yet.' })
      setIncludeDeclined(false)
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not reset confirmations', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Reset confirmations?" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          This will clear <strong>{describeResetCount(count)}</strong> (people who are Going, Not sure or on the Waitlist)
          and put them back to No reply yet, so you can collect firm commitments again — for example if a booking fell through. Their notes are removed. This can't be
          undone. The reset itself sends no email; normal reminders resume, so people may get a reminder if the
          confirmation deadline is close.
        </p>

        {deadlinePassed && (
          <p className="text-sm text-[var(--text-secondary)]">The reply-by date has passed. Set a new one so people are asked again.</p>
        )}

        {declined > 0 && (
          <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeDeclined}
              onChange={(e) => setIncludeDeclined(e.target.checked)}
            />
            <span>
              Also reset the {declined} {declined === 1 ? 'person' : 'people'} who said they're not going
            </span>
          </label>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleReset} isLoading={reset.isPending} disabled={count === 0}>
            Reset {describeResetCount(count)}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
