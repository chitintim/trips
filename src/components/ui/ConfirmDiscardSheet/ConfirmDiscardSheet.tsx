import { Modal } from '../Modal'
import { Button } from '../Button'

// ============================================================================
// TYPES
// ============================================================================

export interface ConfirmDiscardSheetProps {
  isOpen: boolean
  /** User chose to keep editing — dismiss the sheet, form stays open. */
  onKeep: () => void
  /** User chose to discard the in-progress draft and proceed closing. */
  onDiscard: () => void
  message?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

const DEFAULT_MESSAGE = 'You have unsaved changes. Keep editing, or discard your draft?'

/**
 * Tiny Modal-based confirm rendered by callers using
 * `useUnsavedChangesGuard`'s `guardProps` (see
 * src/lib/forms/useUnsavedChangesGuard.ts). Pure presentation — all state
 * lives in the hook.
 */
export function ConfirmDiscardSheet({
  isOpen,
  onKeep,
  onDiscard,
  message = DEFAULT_MESSAGE,
}: ConfirmDiscardSheetProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onKeep}
      title="Discard changes?"
      size="sm"
      showCloseButton={false}
      closeOnBackdropClick={false}
    >
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>

      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <Button variant="secondary" onClick={onKeep}>
          Keep editing
        </Button>
        <Button variant="danger" onClick={onDiscard}>
          Discard draft
        </Button>
      </div>
    </Modal>
  )
}

ConfirmDiscardSheet.displayName = 'ConfirmDiscardSheet'
