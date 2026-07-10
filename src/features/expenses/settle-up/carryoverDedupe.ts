/**
 * Pure carryover de-dupe arithmetic, split out from useCarryoverCandidates
 * (which imports supabase at module scope, making it untestable in
 * isolation without a live/mocked client) so it's directly unit-testable.
 */
import { toMinorUnits } from '../../../lib/money'
import type { Tables } from '../../../types/database.types'

export type CarryoverRow = Pick<Tables<'settlement_carryovers'>, 'from_user_id' | 'to_user_id' | 'amount' | 'currency'>

/**
 * A source trip is only eligible for carryover candidates when it is
 * completed AND its base currency matches the TARGET trip's base currency.
 * There is no FX-conversion path for carryovers (settlement_carryovers has
 * no fx_rate concept), so offering a cross-currency fold would store an
 * amount the target trip's balance math cannot use -- worse, reading its
 * minor units 1:1 would count JPY 10,000 as GBP 100.00 (~2x its real
 * value). Cross-currency source trips are therefore not offered at all,
 * rather than converted.
 */
export function isEligibleCarryoverSourceTrip(
  trip: { status: string | null; base_currency: string },
  targetBaseCurrency: string
): boolean {
  return trip.status === 'trip_completed' && trip.base_currency === targetBaseCurrency
}

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
