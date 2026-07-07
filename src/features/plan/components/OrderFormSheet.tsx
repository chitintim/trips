import { Modal, Button, ConfirmDiscardSheet } from '../../../components/ui'
import { useOrderForm } from '../lib/useOrderForm'
import { OrderFormFields } from './OrderFormFields'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface OrderFormSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  section: SectionWithOptions
  participants?: ParticipantWithUser[]
}

/**
 * Personal order form (UX_REDESIGN.md Part 5, shape 2): tick catalog items
 * (+variant), a per-item date range defaulting to the participant's own
 * travel-details presence window (else the trip's own dates), a quantity
 * stepper, and a live running total — no votes, no deadline pressure beyond
 * the section's own deadline. Saves as `selections` rows with metadata
 * `{start_date, end_date, variant, quantity}` (unchecked items delete their
 * row). State/logic lives in useOrderForm + the shared OrderFormFields
 * presentation, so the AnswerFlow stepper's inline personal-order step can
 * reuse the exact same form without nesting a second Modal.
 */
export function OrderFormSheet({ isOpen, onClose, trip, section, participants = [] }: OrderFormSheetProps) {
  const form = useOrderForm(trip, section)
  const handleClose = () => form.confirmClose(onClose)

  const handleSave = async () => {
    const ok = await form.save()
    if (ok) onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={section.title}>
      <div className="space-y-4">
        <OrderFormFields section={section} participants={participants} form={form} />

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={form.isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={form.isSaving}>
            Save order
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={form.guardProps.showConfirm}
        onKeep={form.guardProps.onKeep}
        onDiscard={form.guardProps.onDiscard}
      />
    </Modal>
  )
}
