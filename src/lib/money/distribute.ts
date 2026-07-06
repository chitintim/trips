/**
 * Largest-remainder distribution: split an integer total (minor units) across
 * a set of weights so that:
 *   1. Every share is an integer.
 *   2. The shares sum EXACTLY to the total (no float drift, no missing cent).
 *   3. Shares are as proportional to the weights as integer rounding allows.
 *
 * This is the standard "largest remainder method" (aka Hare-Niemeyer),
 * used for apportionment problems. It is the core primitive behind:
 *   - equal splits (equal weights)
 *   - shares/weights splits (couples count 2x, etc.)
 *   - proportional tax/tip/service allocation across item subtotals
 *   - split-by-nights-present
 *
 * Negative totals (refunds) are supported by distributing the absolute
 * value and re-applying the sign, which preserves exact-sum and
 * largest-remainder ordering.
 */

export interface DistributeResult {
  /** Integer minor-unit share per input weight, same order/length as `weights`. */
  shares: number[]
}

/**
 * Distribute `totalMinor` (an integer, in minor units) across `weights`
 * (non-negative numbers, need not sum to anything in particular) such that
 * the returned shares are integers summing exactly to `totalMinor`.
 *
 * @param totalMinor - integer minor-unit amount to distribute
 * @param weights - non-negative weights (e.g. [1,1,1] for equal 3-way split,
 *                  or [2,1,1] for a couple counting double)
 */
export function largestRemainderDistribute(totalMinor: number, weights: number[]): number[] {
  if (!Number.isInteger(totalMinor)) {
    throw new Error(`largestRemainderDistribute: totalMinor must be an integer, got ${totalMinor}`)
  }
  if (weights.length === 0) {
    if (totalMinor !== 0) {
      throw new Error('largestRemainderDistribute: cannot distribute a non-zero total across zero weights')
    }
    return []
  }
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new Error('largestRemainderDistribute: weights must be non-negative finite numbers')
  }

  const weightSum = weights.reduce((a, b) => a + b, 0)

  if (weightSum === 0) {
    // No one has any weight — fall back to an even split across all entries
    // so the invariant (exact sum) still holds; nobody is "more entitled".
    return largestRemainderDistribute(totalMinor, weights.map(() => 1))
  }

  // Handle sign separately: distribute the magnitude, then restore sign.
  // This keeps rounding/remainder ordering identical for refunds.
  const sign = totalMinor < 0 ? -1 : 1
  const magnitude = Math.abs(totalMinor)

  // Exact (real-valued) share per weight, then floor to get a baseline integer.
  const exactShares = weights.map((w) => (w / weightSum) * magnitude)
  const floorShares = exactShares.map((s) => Math.floor(s))
  const remainders = exactShares.map((s, i) => s - floorShares[i])

  let allocated = floorShares.reduce((a, b) => a + b, 0)
  let remaining = magnitude - allocated

  // Sort indices by largest remainder first (ties broken by original index
  // for determinism), and hand out the leftover minor units one at a time.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => remainders[b] - remainders[a] || a - b)

  const shares = [...floorShares]
  for (let k = 0; k < order.length && remaining > 0; k++) {
    shares[order[k]] += 1
    remaining -= 1
  }

  // Defensive: should never trigger given the math above, but guarantees
  // the invariant even if floating point does something unexpected.
  allocated = shares.reduce((a, b) => a + b, 0)
  if (allocated !== magnitude) {
    const diff = magnitude - allocated
    // Apply any residual diff to the largest-weight entry.
    const biggestIndex = order[0] ?? 0
    shares[biggestIndex] += diff
  }

  return shares.map((s) => s * sign)
}

/**
 * Convenience wrapper for the common "adjustment" case: proportionally
 * distribute a tax/tip/service-charge amount (integer minor units) across
 * a set of item subtotals (integer minor units), guaranteeing exact sum.
 */
export function distributeProportionalToSubtotals(
  adjustmentMinor: number,
  subtotalsMinor: number[]
): number[] {
  return largestRemainderDistribute(adjustmentMinor, subtotalsMinor)
}
