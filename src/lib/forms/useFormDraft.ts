import { useCallback, useEffect, useRef, useState } from 'react'

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default draft time-to-live: restore only if saved less than this long ago. */
export const DEFAULT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000 // 24h

/** Debounce window for persisting draft writes to storage. */
const SAVE_DEBOUNCE_MS = 300

function storageKey(key: string): string {
  return `draft:${key}`
}

// ============================================================================
// PURE STORAGE HELPERS
// (extracted so they can be unit-tested without mounting a React hook)
// ============================================================================

export interface DraftEnvelope<T> {
  values: T
  savedAt: number
}

/**
 * Persist a draft envelope to sessionStorage under `draft:${key}`.
 * JSON-safe values only. Storage quota / serialization errors are swallowed
 * (no-op fallback) — draft persistence is a nice-to-have, never a hard
 * requirement for the form to keep working.
 */
export function saveDraft<T>(key: string, values: T, now: number = Date.now()): void {
  try {
    const envelope: DraftEnvelope<T> = { values, savedAt: now }
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(envelope))
  } catch {
    // Quota exceeded, storage disabled, circular value, etc. — silently no-op.
  }
}

/**
 * Load a previously saved draft for `key`, if any, and if it is still within
 * `ttlMs` of its save time. Returns null when there is nothing usable
 * (missing, malformed, or expired) and clears expired/malformed entries.
 */
export function loadDraft<T>(
  key: string,
  ttlMs: number = DEFAULT_DRAFT_TTL_MS,
  now: number = Date.now()
): T | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(key))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<DraftEnvelope<T>>
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.savedAt !== 'number' ||
      !('values' in parsed)
    ) {
      clearDraft(key)
      return null
    }

    const age = now - parsed.savedAt
    if (age < 0 || age > ttlMs) {
      clearDraft(key)
      return null
    }

    return parsed.values as T
  } catch {
    return null
  }
}

/** Remove a draft from sessionStorage. Silently no-ops on storage errors. */
export function clearDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(key))
  } catch {
    // Storage disabled/unavailable — nothing to clear.
  }
}

// ============================================================================
// HOOK
// ============================================================================

export interface UseFormDraftOptions {
  /** Milliseconds a saved draft remains valid for restoration. Default 24h. */
  ttlMs?: number
}

export interface UseFormDraftResult<T> {
  values: T
  setValues: React.Dispatch<React.SetStateAction<T>>
  updateField: <K extends keyof T>(name: K, value: T[K]) => void
  clearDraft: () => void
  isRestored: boolean
}

/**
 * Draft-persists a form's values to sessionStorage as the user types
 * (debounced 300ms), restoring them on mount if a draft was saved less than
 * `ttlMs` (default 24h) ago. Call `clearDraft()` on successful submit (or
 * explicit discard) so the next mount starts fresh.
 *
 * Values must be JSON-safe (no functions, Dates, Files, etc).
 */
export function useFormDraft<T>(
  key: string,
  initial: T,
  opts: UseFormDraftOptions = {}
): UseFormDraftResult<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_DRAFT_TTL_MS

  // Lazy-init so restoration only ever runs once, at mount, per key.
  const [{ values, isRestored }, setState] = useState<{ values: T; isRestored: boolean }>(() => {
    const restored = loadDraft<T>(key, ttlMs)
    return restored !== null ? { values: restored, isRestored: true } : { values: initial, isRestored: false }
  })

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced persistence whenever values change.
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveDraft(key, values)
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, values])

  const setValues: React.Dispatch<React.SetStateAction<T>> = useCallback((update) => {
    setState((prev) => ({
      values: typeof update === 'function' ? (update as (prev: T) => T)(prev.values) : update,
      isRestored: prev.isRestored,
    }))
  }, [])

  const updateField = useCallback(<K extends keyof T>(name: K, value: T[K]) => {
    setState((prev) => ({
      values: { ...prev.values, [name]: value },
      isRestored: prev.isRestored,
    }))
  }, [])

  const clearDraftFn = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    clearDraft(key)
  }, [key])

  return { values, setValues, updateField, clearDraft: clearDraftFn, isRestored }
}
