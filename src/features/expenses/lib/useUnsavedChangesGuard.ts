/**
 * Dirty-close guard (Form & Flow Standard, UPGRADE_MASTER_PLAN §5 point 4).
 *
 * TEMPORARY LOCAL SHIM (see useFormDraft.ts for the same rationale): the
 * plan calls for a shared `useUnsavedChangesGuard` + `ConfirmDiscardSheet`;
 * neither existed in the tree yet when this feature was built, so this is
 * a self-contained equivalent kept local to this feature. Swap for the
 * shared version when it lands.
 */
import { useState } from 'react'

export interface UseUnsavedChangesGuardResult {
  /** Confirm-discard sheet open state. */
  isConfirmOpen: boolean
  /** Call this instead of closing directly; opens the confirm sheet if dirty, otherwise closes immediately. */
  requestClose: () => void
  /** Wire to the confirm sheet's "Discard" action. */
  confirmDiscard: () => void
  /** Wire to the confirm sheet's "Keep editing" action. */
  cancelDiscard: () => void
}

/**
 * @param isDirty - whether the form currently has unsaved changes
 * @param onClose - the actual close callback (invoked immediately if not dirty, or after confirm-discard)
 */
export function useUnsavedChangesGuard(isDirty: boolean, onClose: () => void): UseUnsavedChangesGuardResult {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false)

  const requestClose = () => {
    if (isDirty) {
      setIsConfirmOpen(true)
    } else {
      onClose()
    }
  }

  const confirmDiscard = () => {
    setIsConfirmOpen(false)
    onClose()
  }

  const cancelDiscard = () => {
    setIsConfirmOpen(false)
  }

  return { isConfirmOpen, requestClose, confirmDiscard, cancelDiscard }
}
