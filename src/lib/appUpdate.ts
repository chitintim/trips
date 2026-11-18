/**
 * Getting a tab from the build it is running onto the newly deployed one.
 *
 * What is actually in play (verified from the repo): public/sw.js is a hand-rolled share-target worker. It has no precache, no runtime
 * cache and no GET handling, so it cannot itself serve an old bundle. What can serve one is the HTTP cache: the host sends
 * `cache-control: max-age=600` on index.html, and a deep link (`/trips/<id>` -> 404.html -> `/?/trips/<id>`) is opened as a normal
 * navigation that is allowed to reuse a cached index.html for up to ten minutes, which still points at the old hashed bundle. So
 * "Reload" does three things: (1) re-downloads the page document bypassing the HTTP cache, (2) activates a waiting service worker if
 * there is one (public/sw.js also skips waiting on its own; this covers any worker that is still waiting), (3) reloads exactly once.
 * If the same build is still being offered after an earlier attempt, the next attempt also unregisters workers and clears caches.
 * Nothing here runs without the person pressing Reload, except `checkForServiceWorkerUpdate`, which only asks the browser to look
 * for a new sw.js and never reloads anything.
 */

/** The cache public/sw.js keeps a pending share payload in. A clean-up must not delete it. */
export const SHARE_CACHE_NAME = 'trips-share-target-v1'
export const RELOAD_ATTEMPT_KEY = 'app-update-reload-attempt'
export const CONTROLLER_CHANGE_TIMEOUT_MS = 3000
export const FETCH_TIMEOUT_MS = 4000
/** A second Reload within this window means the first one did not help. */
export const RELOAD_RETRY_WINDOW_MS = 5 * 60 * 1000

type SwContainer = Pick<ServiceWorkerContainer, 'getRegistration' | 'getRegistrations' | 'addEventListener' | 'removeEventListener'>

function getContainer(): SwContainer | null {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null
}

/** Asks the browser to look for a newer sw.js now. Best effort: never throws, never reloads. */
export async function checkForServiceWorkerUpdate(sw: SwContainer | null = getContainer()): Promise<void> {
  if (!sw) return
  try {
    const reg = await sw.getRegistration()
    await reg?.update()
  } catch {
    // offline, or the worker script could not be fetched: the next check tries again
  }
}

export interface ApplyUpdateDeps {
  serviceWorker?: SwContainer | null
  cachesApi?: Pick<CacheStorage, 'keys' | 'delete'> | null
  fetchFn?: (input: string, init?: RequestInit) => Promise<unknown>
  reload?: () => void
  now?: () => number
  /** Reads/writes the "already tried" marker. Defaults to sessionStorage (and tolerates it being unavailable). */
  storage?: { get: (k: string) => string | null; set: (k: string, v: string) => void }
  /** The current page URL and the app's base URL (documents whose HTTP-cache entries are refreshed). */
  pageUrl?: string
  baseUrl?: string
  timeoutMs?: number
}

function defaultStorage() {
  return {
    get: (k: string) => {
      try { return sessionStorage.getItem(k) } catch { return null }
    },
    set: (k: string, v: string) => {
      try { sessionStorage.setItem(k, v) } catch { /* ignore */ }
    },
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve('timeout') })
  })
}

/** Unregisters every service worker and deletes caches (except the pending share payload). Best effort. */
export async function clearStaleWorkersAndCaches(sw: SwContainer | null, cachesApi: Pick<CacheStorage, 'keys' | 'delete'> | null): Promise<void> {
  try {
    const regs = (await sw?.getRegistrations()) ?? []
    await Promise.all(regs.map((r) => r.unregister()))
  } catch { /* ignore */ }
  try {
    const keys = (await cachesApi?.keys()) ?? []
    await Promise.all(keys.filter((k) => k !== SHARE_CACHE_NAME).map((k) => cachesApi!.delete(k)))
  } catch { /* ignore */ }
}

/**
 * The Reload button. Resolves after asking for the reload (which happens exactly once).
 */
export async function applyUpdateAndReload(deps: ApplyUpdateDeps = {}): Promise<void> {
  const sw = deps.serviceWorker === undefined ? getContainer() : deps.serviceWorker
  const cachesApi = deps.cachesApi === undefined ? (typeof caches !== 'undefined' ? caches : null) : deps.cachesApi
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init))
  const doReload = deps.reload ?? (() => window.location.reload())
  const now = (deps.now ?? Date.now)()
  const storage = deps.storage ?? defaultStorage()
  const timeoutMs = deps.timeoutMs ?? CONTROLLER_CHANGE_TIMEOUT_MS
  const pageUrl = deps.pageUrl ?? (typeof location !== 'undefined' ? location.href : '')
  const baseUrl = deps.baseUrl ?? import.meta.env.BASE_URL

  let reloaded = false
  const reloadOnce = () => {
    if (reloaded) return
    reloaded = true
    doReload()
  }

  const last = Number(storage.get(RELOAD_ATTEMPT_KEY) ?? '0')
  const retry = Number.isFinite(last) && last > 0 && now - last < RELOAD_RETRY_WINDOW_MS
  storage.set(RELOAD_ATTEMPT_KEY, String(now))

  if (retry) {
    // The last Reload did not bring the new build: stop trusting any worker or cache.
    await clearStaleWorkersAndCaches(sw, cachesApi)
  } else if (sw) {
    try {
      const reg = await sw.getRegistration()
      const waiting = reg?.waiting
      if (waiting) {
        const changed = new Promise<void>((resolve) => {
          const done = () => { sw.removeEventListener('controllerchange', done); resolve() }
          sw.addEventListener('controllerchange', done)
        })
        waiting.postMessage({ type: 'SKIP_WAITING' })
        if ((await withTimeout(changed, timeoutMs)) === 'timeout') await clearStaleWorkersAndCaches(sw, cachesApi)
      }
    } catch { /* fall through to the reload */ }
  }

  // Refresh the HTTP-cache entries for the page document so the reload below cannot reuse a stale index.html.
  const urls = Array.from(new Set([pageUrl, baseUrl].filter(Boolean)))
  await withTimeout(
    Promise.all(urls.map((u) => fetchFn(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => undefined))),
    FETCH_TIMEOUT_MS,
  )
  reloadOnce()
}
