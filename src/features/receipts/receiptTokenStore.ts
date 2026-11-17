/**
 * Keeps the emailed token out of the address bar and history, exactly as the payment confirm page does:
 * /receipt#t=<token>&a=<hint> (preferred: a hash never reaches a server, a log or a referrer) or the older
 * /receipt?t=<token>&a=<hint> is read once, kept in memory and in sessionStorage (this tab only, so a refresh
 * still works), and the address is rewritten to /receipt. Pure functions over an injected storage.
 */
import type { Hint } from './receiptClaimState'

export const TOKEN_STORAGE_KEY = 'receipt-claim-token'
export const HINT_STORAGE_KEY = 'receipt-claim-hint'

const hintOf = (v: string | null | undefined): Hint | null => (v === 'done' || v === 'not_there' ? v : null)

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function tokenFromSearch(search: string): string | null {
  const t = new URLSearchParams(search).get('t')
  return t && t.length > 0 ? t : null
}

export function hintFromSearch(search: string): Hint | null {
  return hintOf(new URLSearchParams(search).get('a'))
}

/** The link's parameters: the hash (`#t=..&a=..`) when it carries a token, else the query string (`?t=..`). */
function linkParams(search: string, hash: string): string {
  const fromHash = hash.replace(/^#/, '')
  return tokenFromSearch(fromHash) ? fromHash : search
}

/** The token (and the hint) for this page view: the URL's, else the ones remembered by this tab. `fromUrl` = strip the address bar. */
export function captureToken(search: string, store: Store | null, hash = ''): { token: string | null; hint: Hint | null; fromUrl: boolean } {
  const params = linkParams(search, hash)
  const fromUrl = tokenFromSearch(params)
  if (fromUrl) {
    const hint = hintFromSearch(params)
    try {
      store?.setItem(TOKEN_STORAGE_KEY, fromUrl)
      store?.setItem(HINT_STORAGE_KEY, hint ?? '')
    } catch {
      /* a refresh will not work in this browser; the in-memory token still does */
    }
    return { token: fromUrl, hint, fromUrl: true }
  }
  try {
    const kept = store?.getItem(TOKEN_STORAGE_KEY) ?? null
    if (!kept) return { token: null, hint: null, fromUrl: new URLSearchParams(params).has('a') }
    return { token: kept, hint: hintOf(store?.getItem(HINT_STORAGE_KEY)), fromUrl: false }
  } catch {
    return { token: null, hint: null, fromUrl: false }
  }
}

/** The tokenless address (honours the app's base path). */
export function cleanReceiptPath(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/receipt`
}

/** Once the person has acted the remembered hint must not pre-select again after a refresh. */
export function forgetHint(store: Pick<Storage, 'setItem'> | null): void {
  try {
    store?.setItem(HINT_STORAGE_KEY, '')
  } catch {
    /* ignore */
  }
}
