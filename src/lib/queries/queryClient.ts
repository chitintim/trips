import { QueryCache, QueryClient, MutationCache } from '@tanstack/react-query'
import { reportError } from '../reportError'

// Known-benign noise from React Query's global error hooks: failures that
// are expected in normal operation and don't indicate a bug, so reporting
// them would just flood client_errors (e.g. on every logout). Deliberately
// conservative per the 2026-07-10 incident review -- report everything
// EXCEPT these, rather than trying to guess every noisy pattern up front.
// Extend this list as real noise turns up in the client_errors table.
const BENIGN_QUERY_ERROR_PATTERNS = [
  // GoTrue's error when a query/mutation runs during a logout race and
  // there's no session left to read -- matches the same substring useAuth.ts
  // already treats as benign (src/hooks/useAuth.ts).
  /auth session missing/i,
]

function isBenignQueryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return BENIGN_QUERY_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function onQueryOrMutationError(error: unknown): void {
  if (isBenignQueryError(error)) return
  reportError(error, 'query-cache')
}

/**
 * Single TanStack Query client for the whole app.
 *
 * Defaults chosen per UPGRADE_MASTER_PLAN §4:
 * - staleTime ~30s: data is considered fresh for 30s after fetch, avoiding
 *   redundant refetches on tab-switch/remount while still keeping the app
 *   feeling live (realtime invalidation handles true freshness on top of this).
 * - retry 1: a single retry for transient network blips, no aggressive
 *   exponential backoff storms against Supabase.
 * - refetchOnWindowFocus true: coming back to a stale tab (e.g. reopening
 *   the PWA) triggers a background refresh.
 *
 * queryCache/mutationCache onError (2026-07-10 incident follow-up): a
 * single global hook that reports nearly every data-fetch/mutation failure
 * app-wide via reportError, instead of each failure dying silently in
 * whichever component's console it happened to hit. See
 * BENIGN_QUERY_ERROR_PATTERNS above for the (intentionally short) denylist
 * of expected failures this skips.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onQueryOrMutationError }),
  mutationCache: new MutationCache({ onError: onQueryOrMutationError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 0,
    },
  },
})
