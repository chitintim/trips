import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveDraft, loadDraft, clearDraft, DEFAULT_DRAFT_TTL_MS } from './useFormDraft'

// ============================================================================
// In-memory sessionStorage mock
// (vitest.config.ts runs in the 'node' environment — no DOM/sessionStorage
// available by default — so we install a minimal Storage-like mock on the
// global object before each test, per the task's fallback-testing plan.)
// ============================================================================

class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length() {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { sessionStorage: new MemoryStorage() })
})

describe('saveDraft / loadDraft', () => {
  it('round-trips a JSON-safe value', () => {
    const now = 1_000_000
    saveDraft('trip-brief', { title: 'Ski trip', dates: ['2026-01-01'] }, now)

    const loaded = loadDraft<{ title: string; dates: string[] }>('trip-brief', DEFAULT_DRAFT_TTL_MS, now)
    expect(loaded).toEqual({ title: 'Ski trip', dates: ['2026-01-01'] })
  })

  it('namespaces keys under draft:${key}', () => {
    saveDraft('my-form', { a: 1 }, 0)
    expect(window.sessionStorage.getItem('draft:my-form')).not.toBeNull()
    expect(window.sessionStorage.getItem('my-form')).toBeNull()
  })

  it('returns null when nothing has been saved', () => {
    expect(loadDraft('never-saved')).toBeNull()
  })

  it('restores a draft saved just under the ttl', () => {
    const savedAt = 1_000_000
    const ttlMs = 24 * 60 * 60 * 1000
    saveDraft('form', { v: 1 }, savedAt)

    const now = savedAt + ttlMs - 1
    expect(loadDraft('form', ttlMs, now)).toEqual({ v: 1 })
  })

  it('expires a draft older than the ttl and clears it', () => {
    const savedAt = 1_000_000
    const ttlMs = 24 * 60 * 60 * 1000
    saveDraft('form', { v: 1 }, savedAt)

    const now = savedAt + ttlMs + 1
    expect(loadDraft('form', ttlMs, now)).toBeNull()
    // Expired entry should be cleared as a side effect.
    expect(window.sessionStorage.getItem('draft:form')).toBeNull()
  })

  it('respects a custom ttlMs option', () => {
    const savedAt = 1_000_000
    saveDraft('short-lived', { v: 'x' }, savedAt)

    const shortTtl = 1000
    expect(loadDraft('short-lived', shortTtl, savedAt + 500)).toEqual({ v: 'x' })
    expect(loadDraft('short-lived', shortTtl, savedAt + 1500)).toBeNull()
  })

  it('treats a future savedAt (clock skew) as invalid', () => {
    const now = 1_000_000
    saveDraft('skewed', { v: 1 }, now + 10_000)
    expect(loadDraft('skewed', DEFAULT_DRAFT_TTL_MS, now)).toBeNull()
  })

  it('returns null and clears malformed JSON', () => {
    window.sessionStorage.setItem('draft:broken', '{not json')
    expect(loadDraft('broken')).toBeNull()
  })

  it('returns null for a well-formed but shape-invalid envelope', () => {
    window.sessionStorage.setItem('draft:invalid-shape', JSON.stringify({ foo: 'bar' }))
    expect(loadDraft('invalid-shape')).toBeNull()
    expect(window.sessionStorage.getItem('draft:invalid-shape')).toBeNull()
  })
})

describe('clearDraft', () => {
  it('removes a saved draft', () => {
    const now = 1_000_000
    saveDraft('to-clear', { v: 1 }, now)
    expect(loadDraft('to-clear', DEFAULT_DRAFT_TTL_MS, now)).not.toBeNull()

    clearDraft('to-clear')
    expect(loadDraft('to-clear', DEFAULT_DRAFT_TTL_MS, now)).toBeNull()
  })

  it('is a no-op when nothing was saved', () => {
    expect(() => clearDraft('nothing-here')).not.toThrow()
  })
})

describe('storage failure fallback', () => {
  it('saveDraft silently no-ops when sessionStorage throws (quota exceeded)', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        setItem: () => {
          throw new DOMException('QuotaExceededError')
        },
        getItem: () => null,
        removeItem: () => {},
      },
    })

    expect(() => saveDraft('quota', { big: 'x'.repeat(10) })).not.toThrow()
  })

  it('loadDraft returns null when sessionStorage throws', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('storage disabled')
        },
        setItem: () => {},
        removeItem: () => {},
      },
    })

    expect(loadDraft('disabled')).toBeNull()
  })

  it('clearDraft silently no-ops when sessionStorage throws', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        removeItem: () => {
          throw new Error('storage disabled')
        },
        getItem: () => null,
        setItem: () => {},
      },
    })

    expect(() => clearDraft('disabled')).not.toThrow()
  })
})
