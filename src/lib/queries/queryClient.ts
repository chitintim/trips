import { QueryClient } from '@tanstack/react-query'

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
 */
export const queryClient = new QueryClient({
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
