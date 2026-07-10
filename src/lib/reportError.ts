import { supabase } from './supabase'

/**
 * Fire-and-forget client-side error telemetry (2026-07-10 incident
 * follow-up): every production bug that night failed SILENTLY -- errors
 * died in users' browser consoles with zero visibility. reportError() is
 * the one interface every choke point (ErrorBoundary, the vite
 * preload-error listener, React Query's global caches, callRpc.ts) reports
 * through, feeding public.client_errors via the log_client_error RPC (see
 * supabase/migrations/20260711120000_client_errors.sql).
 *
 * No third-party account (e.g. Sentry) is available today, so this writes
 * to the app's own Supabase project -- but the narrow signature here
 * (`reportError(error, context)`, no return value, never throws) is
 * intentionally shaped so a real APM transport could be swapped in behind
 * it later without touching any call site.
 *
 * Contract callers can rely on:
 *   - NEVER throws. An error reporter that itself fails is worse than no
 *     error reporter -- every failure path falls back to console.debug.
 *   - Fire-and-forget: does not await the network request, so it never
 *     slows down or blocks the caller.
 *   - Deduped: the same message+context reported repeatedly inside a 30s
 *     window is only sent once, so a render-loop error can't generate
 *     thousands of rows.
 *   - Capped: at most MAX_REPORTS_PER_SESSION reports are ever sent for
 *     the lifetime of this tab, as a belt-and-braces flood guard on top of
 *     dedupe.
 *   - Disabled in dev (`import.meta.env.DEV`): logs to console.error
 *     instead of hitting the network, so local development never writes
 *     rows into the shared table.
 */

// Same message+context reported again inside this window is dropped after
// the first report.
const DEDUPE_WINDOW_MS = 30_000

// Absolute ceiling on reports per session/tab, regardless of how many
// distinct message+context pairs show up.
const MAX_REPORTS_PER_SESSION = 20

const recentlyReported = new Map<string, number>()
let reportCount = 0

/** Test-only: resets module-level dedupe/cap state between test cases. */
export function __resetReportErrorStateForTests(): void {
  recentlyReported.clear()
  reportCount = 0
}

function normalize(error: unknown): { message: string; stack: string | undefined } {
  if (error instanceof Error) {
    return { message: error.message || String(error), stack: error.stack }
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message)
    const stack = 'stack' in error ? (error as { stack?: unknown }).stack : undefined
    return { message, stack: stack === undefined ? undefined : String(stack) }
  }
  return { message: String(error), stack: undefined }
}

/** The SPA route only -- strips everything after '?' so tokens/codes in a query string are never captured. */
function currentPath(): string {
  try {
    return window.location.pathname
  } catch {
    return ''
  }
}

function currentUserAgent(): string | null {
  return typeof navigator === 'undefined' ? null : navigator.userAgent
}

/**
 * Decides whether this message+context should be reported right now given
 * dedupe window + session cap, and records the attempt if so. Pure and
 * side-effecting only on the module-level Maps/counters above -- kept as
 * its own function so the policy is unit-testable without touching
 * supabase or import.meta.env.
 */
function shouldReport(dedupeKey: string, now: number): boolean {
  const lastReported = recentlyReported.get(dedupeKey)
  if (lastReported !== undefined && now - lastReported < DEDUPE_WINDOW_MS) return false

  if (reportCount >= MAX_REPORTS_PER_SESSION) return false

  recentlyReported.set(dedupeKey, now)
  reportCount++
  return true
}

export function reportError(error: unknown, context: string): void {
  const { message, stack } = normalize(error)

  if (import.meta.env.DEV) {
    // Kill switch for local dev: stay in the console, never touch the
    // network or write into the shared telemetry table.
    console.error(`[reportError:${context}]`, error)
    return
  }

  const dedupeKey = `${context}::${message}`
  if (!shouldReport(dedupeKey, Date.now())) return

  // supabase.rpc() called directly as a method call (never detached into an
  // intermediate variable) -- see src/lib/callRpc.ts for why that matters.
  // This call is deliberately NOT routed through callRpc: callRpc reports
  // its own failures via reportError, and this path must never be able to
  // recurse back into itself. Wrapped in an async IIFE (rather than
  // .then()/.catch()) so both a synchronous throw and a rejected promise
  // land in the same try/catch -- and since async functions never throw
  // synchronously to their caller (any error becomes part of the returned,
  // here-ignored, promise), reportError itself can never throw.
  void (async () => {
    try {
      const { error: rpcError } = await supabase.rpc('log_client_error' as never, {
        p_message: message,
        p_stack: stack ?? null,
        p_context: context,
        p_url: currentPath(),
        p_user_agent: currentUserAgent(),
        p_app_version: null,
      } as never)
      if (rpcError) console.debug('reportError: log_client_error failed', rpcError)
    } catch (err) {
      console.debug('reportError: log_client_error threw', err)
    }
  })()
}
