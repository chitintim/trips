/**
 * Deep-link preservation through auth (UX_REDESIGN Part 2 "Landing rules"):
 * ProtectedRoute stashes the blocked location in `state.from`; BOTH login
 * paths (password and OTP) must round-trip the user back to the EXACT
 * original URL — path + query + hash — claim/join links being the critical
 * case. Pure, unit-tested.
 */

export interface FromLocationLike {
  pathname?: string
  search?: string
  hash?: string
}

export function resolvePostLoginDestination(state: unknown, fallback = '/'): string {
  const from = (state as { from?: FromLocationLike } | null | undefined)?.from
  if (!from?.pathname) return fallback
  return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`
}
