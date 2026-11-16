/**
 * MANUAL MIRROR of src/features/people/lib/inScopePeople.ts (Deno edge functions cannot import from src/).
 * Keep the code identical; only import specifiers and comments may differ.
 * Enforced by scripts/check-contract-drift.mjs.
 */
/**
 * The ONE definition of "who is in" for cost and headcount purposes:
 * default expense/booking splits, cost-per-person estimates and
 * "N of M voted" denominators all use this so they agree.
 *
 * Rule:
 *  - Only ACTIVE participants (active !== false) are ever in scope.
 *  - Confirmation tracking OFF (trips.confirmation_enabled !== true):
 *    every active participant is in scope (statuses are not maintained).
 *  - Confirmation tracking ON:
 *      - declined and cancelled people are dropped;
 *      - if at least one remaining person is 'confirmed', ONLY the
 *        confirmed people are in scope;
 *      - otherwise (nobody confirmed yet, e.g. right after a reset) all
 *        remaining non-declined/cancelled active people are in scope, so
 *        the list is never empty just because RSVPs haven't come in.
 *
 * Defaults only: users can always edit a split; stored splits are never
 * rewritten from this.
 */
export interface InScopeCandidate {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
}

export function inScopePeople<T extends InScopeCandidate>(participants: T[], confirmationEnabled: boolean): T[] {
  const active = participants.filter((p) => p.active !== false)
  if (!confirmationEnabled) return active
  const notOut = active.filter((p) => p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled')
  const confirmed = notOut.filter((p) => p.confirmation_status === 'confirmed')
  return confirmed.length > 0 ? confirmed : notOut
}

export function inScopeUserIds(participants: InScopeCandidate[], confirmationEnabled: boolean): string[] {
  return inScopePeople(participants, confirmationEnabled).map((p) => p.user_id)
}

/**
 * Headcount for cost-per-person maths, plus whether it is an estimate
 * (true unless tracking is on AND at least one person is confirmed, i.e.
 * the number is a real "confirmed" count).
 */
export interface InScopeHeadcount {
  count: number
  isEstimate: boolean
}

export function inScopeHeadcount(participants: InScopeCandidate[], confirmationEnabled: boolean): InScopeHeadcount {
  const people = inScopePeople(participants, confirmationEnabled)
  const hasConfirmed = confirmationEnabled && people.some((p) => p.confirmation_status === 'confirmed')
  return { count: people.length, isEstimate: !hasConfirmed }
}
