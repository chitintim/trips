/**
 * Form draft persistence (Form & Flow Standard, UPGRADE_MASTER_PLAN §5).
 *
 * TEMPORARY LOCAL SHIM: the plan calls for a shared `useFormDraft` living in
 * `src/lib/forms/` (owned by the data-layer workstream, not this feature).
 * That module was not yet present in the tree when this feature was built,
 * so this is a self-contained implementation of the exact same documented
 * API/behavior (debounced sessionStorage autosave, restore on mount if
 * <24h old, clear on submit/discard) kept local to
 * `src/features/expenses/`. When `src/lib/forms/useFormDraft` lands, swap
 * every import of this file for that one -- the call signature below is
 * intentionally shaped to match so the swap is a one-line change per call
 * site (`from '../../lib/useFormDraft'` -> `from '../../../lib/forms'`).
 *
 * Never derive form state from query data mid-edit (plan §5 point 5) --
 * this hook only ever reads sessionStorage once on mount and writes to it
 * on change; it never re-reads on a query cache invalidation.
 */
import { useEffect, useRef, useState } from 'react'

const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000
const DEBOUNCE_MS = 400

interface StoredDraft<T> {
  savedAt: number
  value: T
}

function readDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDraft<T>
    if (Date.now() - parsed.savedAt > MAX_DRAFT_AGE_MS) {
      sessionStorage.removeItem(key)
      return null
    }
    return parsed.value
  } catch {
    return null
  }
}

function writeDraft<T>(key: string, value: T): void {
  try {
    const stored: StoredDraft<T> = { savedAt: Date.now(), value }
    sessionStorage.setItem(key, JSON.stringify(stored))
  } catch {
    // sessionStorage unavailable (private mode / quota) -- draft persistence
    // is a nice-to-have, never block the form on it.
  }
}

export interface UseFormDraftOptions<T> {
  /** Unique storage key, e.g. `expense-draft:${tripId}:new` or `...:${expenseId}` for edits. */
  key: string
  /** Initial/default value used when there's no saved draft (or drafts are disabled, e.g. edit mode seeding from a record). */
  initialValue: T
  /** When false, skips restoring/persisting entirely (e.g. disable autosave while an edit-mode seed is still loading). */
  enabled?: boolean
}

export interface UseFormDraftResult<T> {
  value: T
  setValue: (next: T | ((prev: T) => T)) => void
  /** True if the current value was restored from a saved draft on mount. */
  restoredFromDraft: boolean
  /** Clears the persisted draft (call on successful submit or explicit discard). */
  clearDraft: () => void
}

/**
 * Debounced sessionStorage-backed form draft. Restores a saved value on
 * mount (if <24h old), autosaves on every change (debounced), and exposes
 * `clearDraft()` for submit/discard flows.
 */
export function useFormDraft<T>({ key, initialValue, enabled = true }: UseFormDraftOptions<T>): UseFormDraftResult<T> {
  const [restoredFromDraft] = useState(() => enabled && readDraft<T>(key) !== null)
  const [value, setValueState] = useState<T>(() => {
    if (!enabled) return initialValue
    const restored = readDraft<T>(key)
    return restored ?? initialValue
  })

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [])

  const setValue = (next: T | ((prev: T) => T)) => {
    setValueState((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
      if (enabled) {
        if (debounceTimer.current) clearTimeout(debounceTimer.current)
        debounceTimer.current = setTimeout(() => writeDraft(key, resolved), DEBOUNCE_MS)
      }
      return resolved
    })
  }

  const clearDraft = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    try {
      sessionStorage.removeItem(key)
    } catch {
      // ignore
    }
  }

  return { value, setValue, restoredFromDraft, clearDraft }
}
