/**
 * Which build is running, and whether a newer one has been deployed.
 *
 * - `APP_BUILD` is injected by vite.config.ts (commit SHA in CI, 'dev' for the dev server).
 * - `CLIENT_INFO` is sent on every Supabase request in the EXISTING `X-Client-Info` header (src/lib/supabase.ts). No new header: edge
 *   functions only allow the headers listed in supabase/functions/_shared/cors.ts, and a new one would fail every browser call.
 * - Every build also writes `version.json` ({build, builtAt}) next to index.html. An open tab fetches it (never cached: `cache: 'no-store'`
 *   plus a throwaway query string, because the host serves static files with a short max-age) and compares it with its own `APP_BUILD`.
 *   public/sw.js caches nothing and ignores GET requests, so the service worker cannot serve a stale copy either.
 *
 * The check never reloads anything: the banner (src/components/NewVersionBanner.tsx) offers "Reload", and a reload with an unsaved
 * form still hits the browser's own leave-site prompt (useUnsavedChangesGuard).
 */
declare const __APP_BUILD__: string | undefined

export const APP_BUILD: string = typeof __APP_BUILD__ === 'string' && __APP_BUILD__ ? __APP_BUILD__ : 'dev'
export const CLIENT_INFO = `trips-web/${APP_BUILD}`

/** The build id inside a version.json body, or null when it is not one (a 404 page, a proxy's HTML, ...). */
export function parseVersionJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { build?: unknown } | null
    return parsed && typeof parsed.build === 'string' && parsed.build.trim() ? parsed.build.trim() : null
  } catch {
    return null
  }
}

/** A different, known build is deployed. A dev server (`dev`) never counts, and an unreadable answer (null) never does either. */
export function isNewerBuild(running: string, deployed: string | null): boolean {
  return !!deployed && running !== 'dev' && deployed !== running
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>

/** Reads the deployed build id. Never throws: offline, a 404 or a garbled body all read as null ("don't know"). */
export async function fetchDeployedBuild(opts: { baseUrl: string; fetchFn?: FetchLike; now?: () => number }): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const stamp = (opts.now ?? Date.now)()
  try {
    const res = await fetchFn(`${opts.baseUrl}version.json?t=${stamp}`, { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return null
    return parseVersionJson(await res.text())
  } catch {
    return null
  }
}

export interface VersionWatcherDeps {
  running: string
  /** Resolves the deployed build id, or null when it cannot be read. */
  check: () => Promise<string | null>
  /** Called after EVERY check that finds a newer build, so a dismissed banner comes back on the next detection. */
  onNewer: (deployed: string) => void
  now?: () => number
  /** Re-check on a timer. Default 30 minutes. */
  intervalMs?: number
  /** Re-checks triggered by returning to the tab are spaced at least this far apart. Default 5 minutes. */
  minGapMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface VersionWatcher {
  /** Checks now (unless the last check was less than `minGapMs` ago and `force` is not set). */
  checkNow: (force?: boolean) => Promise<void>
  /** The tab became visible / the window got focus. */
  onFocus: () => void
  start: () => void
  stop: () => void
}

export const VERSION_CHECK_INTERVAL_MS = 30 * 60 * 1000
export const VERSION_FOCUS_GAP_MS = 5 * 60 * 1000

export function createVersionWatcher(deps: VersionWatcherDeps): VersionWatcher {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? VERSION_CHECK_INTERVAL_MS
  const minGapMs = deps.minGapMs ?? VERSION_FOCUS_GAP_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  let lastCheckAt = -Infinity
  let inFlight = false
  let timer: unknown = null

  const checkNow = async (force = false) => {
    if (deps.running === 'dev' || inFlight) return
    if (!force && now() - lastCheckAt < minGapMs) return
    inFlight = true
    lastCheckAt = now()
    try {
      const deployed = await deps.check()
      if (isNewerBuild(deps.running, deployed)) deps.onNewer(deployed as string)
    } finally {
      inFlight = false
    }
  }

  return {
    checkNow,
    onFocus: () => void checkNow(false),
    start: () => {
      if (timer != null || deps.running === 'dev') return
      timer = setTimer(() => void checkNow(true), intervalMs)
    },
    stop: () => {
      if (timer != null) clearTimer(timer)
      timer = null
    },
  }
}
