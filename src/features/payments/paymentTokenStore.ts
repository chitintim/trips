/**
 * Keeps the emailed token out of the address bar and history.
 *
 * The token arrives as /confirm-payment?t=<token>. On load the page reads it once, keeps it in memory,
 * remembers it in sessionStorage (this tab only, so a refresh still works) and rewrites the address to
 * /confirm-payment. Pure functions over an injected storage so they are unit-testable.
 */

export const TOKEN_STORAGE_KEY = 'confirm-payment-token'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** sessionStorage can be missing or throw (private windows, blocked site data). */
export function safeSessionStorage(): Store | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function tokenFromSearch(search: string): string | null {
  const t = new URLSearchParams(search).get('t')
  return t && t.length > 0 ? t : null
}

/** The token for this page view: the URL's, else the one remembered by this tab. */
export function captureToken(search: string, store: Store | null): { token: string | null; fromUrl: boolean } {
  const fromUrl = tokenFromSearch(search)
  if (fromUrl) {
    try {
      store?.setItem(TOKEN_STORAGE_KEY, fromUrl)
    } catch {
      /* a refresh will not work in this browser; the in-memory token still does */
    }
    return { token: fromUrl, fromUrl: true }
  }
  try {
    const kept = store?.getItem(TOKEN_STORAGE_KEY) ?? null
    return { token: kept && kept.length > 0 ? kept : null, fromUrl: false }
  } catch {
    return { token: null, fromUrl: false }
  }
}

/** The tokenless address (honours the app's base path, e.g. "/" or "/trips/"). */
export function cleanConfirmPath(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/confirm-payment`
}

const REFERRER_META = 'meta[data-confirm-payment-referrer]'

/** Adds `<meta name="referrer" content="no-referrer">`; returns the function that removes it. */
export function applyNoReferrer(doc: Document): () => void {
  const meta = doc.createElement('meta')
  meta.name = 'referrer'
  meta.content = 'no-referrer'
  meta.setAttribute('data-confirm-payment-referrer', '')
  doc.head.appendChild(meta)
  return () => doc.head.querySelectorAll(REFERRER_META).forEach((m) => m.remove())
}
