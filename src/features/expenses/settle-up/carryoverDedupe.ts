/**
 * Pure carryover de-dupe arithmetic, split out from useCarryoverCandidates
 * (which imports supabase at module scope, making it untestable in
 * isolation without a live/mocked client) so it's directly unit-testable.
 */
import { toMinorUnits } from '../../../lib/money'
import type { Tables } from '../../../types/database.types'

export type CarryoverRow = Pick<Tables<'settlement_carryovers'>, 'from_user_id' | 'to_user_id' | 'amount' | 'currency'>

/**
 * Nets a pairwise balance (in minor units, positive = otherUserId owes
 * currentUserId -- same sign convention as computePairwiseBreakdown's
 * netMinor) against any carryovers already folded for that exact
 * (currentUserId, otherUserId) pair, in either direction. Returns the
 * remaining un-folded amount in minor units.
 */
export function computeRemainingCarryoverMinor(
  pairwiseNetMinor: number,
  existingCarryovers: CarryoverRow[],
  currentUserId: string,
  otherUserId: string
): number {
  const alreadyFoldedMinor = existingCarryovers
    .filter(
      (c) =>
        (c.from_user_id === currentUserId && c.to_user_id === otherUserId) ||
        (c.from_user_id === otherUserId && c.to_user_id === currentUserId)
    )
    .reduce((sum, c) => {
      const amountMinor = toMinorUnits(c.amount, c.currency)
      const signed = c.to_user_id === currentUserId ? amountMinor : -amountMinor
      return sum + signed
    }, 0)

  return pairwiseNetMinor - alreadyFoldedMinor
}
