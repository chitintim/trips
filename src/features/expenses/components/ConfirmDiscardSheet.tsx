/**
 * Dirty-close confirmation sheet (Form & Flow Standard, UPGRADE_MASTER_PLAN
 * §5 point 4). TEMPORARY LOCAL COMPONENT -- see Stepper.tsx for the same
 * rationale; swap for the shared `ConfirmDiscardSheet` when it lands.
 */
import { Modal, Button } from '../../../components/ui'

export interface ConfirmDiscardSheetProps {
  isOpen: boolean
  onKeepEditing: () => void
  onDiscard: () => void
  /** Defaults to a generic "unsaved changes" message; override for context (e.g. "Discard this expense?"). */
  title?: string
  description?: string
}

export function ConfirmDiscardSheet({
  isOpen,
  onKeepEditing,
  onDiscard,
  title = 'Discard changes?',
  description = "You have unsaved changes. They'll be lost if you leave now.",
}: ConfirmDiscardSheetProps) {
  return (
    <Modal isOpen={isOpen} onClose={onKeepEditing} title={title} size="sm" showCloseButton={false}>
      <p className="text-sm text-[var(--text-secondary)] mb-5">{description}</p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" fullWidth onClick={onKeepEditing}>
          Keep editing
        </Button>
        <Button variant="danger" fullWidth onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </Modal>
  )
}
