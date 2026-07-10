import { describe, it, expect } from 'vitest'
import { computeRemainingCarryoverMinor, isEligibleCarryoverSourceTrip } from './carryoverDedupe'

describe('computeRemainingCarryoverMinor (carryover de-dupe arithmetic)', () => {
  it('returns the full pairwise net when nothing has been folded yet', () => {
    const remaining = computeRemainingCarryoverMinor(5000, [], 'alice', 'bob')
    expect(remaining).toBe(5000)
  })

  it('zeroes out (within epsilon) once the full amount has already been folded for this exact pair', () => {
    // Bob owed Alice £50 on the source trip; a carryover for that exact
    // amount, in that exact direction, has already been folded somewhere.
    const existing = [{ from_user_id: 'bob', to_user_id: 'alice', amount: 50, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    expect(remaining).toBe(0)
  })

  it('does not offer the same money twice: a fully-folded pair must not resurface as a fresh candidate', () => {
    const existing = [{ from_user_id: 'bob', to_user_id: 'alice', amount: 50, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    // Caller excludes a candidate once |remaining| < BALANCE_EPSILON_MINOR (1).
    expect(Math.abs(remaining)).toBeLessThan(1)
  })

  it('nets a partial fold correctly, leaving the un-folded remainder offered as a new candidate', () => {
    // Pairwise net is £50 owed to Alice; only £20 of it has been folded so far.
    const existing = [{ from_user_id: 'bob', to_user_id: 'alice', amount: 20, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    expect(remaining).toBe(3000) // £30 still un-folded
  })

  it('ignores carryover rows for a different pair entirely', () => {
    const existing = [{ from_user_id: 'charlie', to_user_id: 'alice', amount: 999, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    expect(remaining).toBe(5000)
  })

  it('reads a carryover in either from/to direction and signs it correctly against the current user', () => {
    // Same £50 folded, but recorded with alice as the debtor this time
    // (alice owed bob) -- should SUBTRACT from a positive (bob-owes-alice) net.
    const existing = [{ from_user_id: 'alice', to_user_id: 'bob', amount: 50, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    expect(remaining).toBe(10000) // the two £50s do NOT cancel -- opposite-direction folds add up
  })

  it('handles a zero-decimal currency (JPY) using the correct minor-unit exponent', () => {
    const existing = [{ from_user_id: 'bob', to_user_id: 'alice', amount: 5000, currency: 'JPY' }]
    // 5000 JPY net, already fully folded as 5000 JPY (minor unit exponent 0, so amount === minor units).
    const remaining = computeRemainingCarryoverMinor(5000, existing, 'alice', 'bob')
    expect(remaining).toBe(0)
  })

  it('surfaces a COUNTER-candidate when the source pair nets to zero but a prior fold exists (debt repaid at source AFTER folding)', () => {
    // Bob owed Alice £30 on the source trip and it was folded into a target
    // trip. Bob then ALSO repaid the £30 directly on the source trip, so the
    // source pairwise net is now 0 -- but the folded £30 still (incorrectly)
    // inflates the target trip. The arithmetic must offer the compensating
    // reverse candidate: 0 - (+3000) = -3000, i.e. "Alice owes Bob £30",
    // which when folded inserts the counter-row that nets the stale fold out.
    const existing = [{ from_user_id: 'bob', to_user_id: 'alice', amount: 30, currency: 'GBP' }]
    const remaining = computeRemainingCarryoverMinor(0, existing, 'alice', 'bob')
    expect(remaining).toBe(-3000)
  })
})

describe('isEligibleCarryoverSourceTrip (cross-currency fold suppression)', () => {
  it('rejects a completed source trip whose base currency differs from the target trip (JPY source, GBP target)', () => {
    expect(isEligibleCarryoverSourceTrip({ status: 'trip_completed', base_currency: 'JPY' }, 'GBP')).toBe(false)
  })

  it('accepts a completed source trip in the same base currency', () => {
    expect(isEligibleCarryoverSourceTrip({ status: 'trip_completed', base_currency: 'GBP' }, 'GBP')).toBe(true)
  })

  it('rejects a same-currency trip that is not completed', () => {
    expect(isEligibleCarryoverSourceTrip({ status: 'trip_ongoing', base_currency: 'GBP' }, 'GBP')).toBe(false)
    expect(isEligibleCarryoverSourceTrip({ status: null, base_currency: 'GBP' }, 'GBP')).toBe(false)
  })
})
