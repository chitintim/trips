import { useCallback, useEffect, useRef, useState } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface UnsavedChangesGuardProps {
  /** Whether the shared ConfirmDiscardSheet should currently be shown. */
  showConfirm: boolean
  /** Call when the user chooses to keep editing (dismiss the sheet). */
  onKeep: () => void
  /** Call when the user chooses to discard the draft and proceed closing. */
  onDiscard: () => void
}

export interface UseUnsavedChangesGuardResult {
  /**
   * Attempt to close the form. If not dirty, calls `onConfirm` immediately.
   * If dirty, opens the confirm sheet instead — render it via `guardProps`
   * wired to the shared `ConfirmDiscardSheet` component.
   */
  confirmClose: (onConfirm: () => void) => void
  guardProps: UnsavedChangesGuardProps
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Small hook backing the "Form & Flow Standard" dirty-close guard (see
 * UPGRADE_MASTER_PLAN.md §5). Callers render the shared `ConfirmDiscardSheet`
 * using `guardProps` — this hook only owns the state machine, not any UI.
 *
 * Also registers a `beforeunload` listener while `isDirty` is true, so
 * closing/refreshing the tab with unsaved changes prompts the browser's
 * native "leave site?" confirmation as a second line of defense.
 */
export function useUnsavedChangesGuard(isDirty: boolean): UseUnsavedChangesGuardResult {
  const [showConfirm, setShowConfirm] = useState(false)
  const pendingConfirmRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!isDirty) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Legacy browsers require returnValue to be set.
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  const confirmClose = useCallback(
    (onConfirm: () => void) => {
      if (!isDirty) {
        onConfirm()
        return
      }

      pendingConfirmRef.current = onConfirm
      setShowConfirm(true)
    },
    [isDirty]
  )

  const onKeep = useCallback(() => {
    pendingConfirmRef.current = null
    setShowConfirm(false)
  }, [])

  const onDiscard = useCallback(() => {
    const pending = pendingConfirmRef.current
    pendingConfirmRef.current = null
    setShowConfirm(false)
    pending?.()
  }, [])

  return {
    confirmClose,
    guardProps: { showConfirm, onKeep, onDiscard },
  }
}
