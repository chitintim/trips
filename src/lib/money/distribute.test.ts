import { describe, it, expect } from 'vitest'
import { largestRemainderDistribute, distributeProportionalToSubtotals } from './distribute'

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0)
}

describe('largestRemainderDistribute', () => {
  it('splits evenly when it divides cleanly', () => {
    const shares = largestRemainderDistribute(300, [1, 1, 1])
    expect(shares).toEqual([100, 100, 100])
  })

  it('splits 100 across 3 people exactly (the classic rounding case)', () => {
    const shares = largestRemainderDistribute(100, [1, 1, 1])
    expect(sum(shares)).toBe(100)
    // largest-remainder gives one person the extra unit: [34, 33, 33] in some order
    expect(shares.sort((a, b) => b - a)).toEqual([34, 33, 33])
  })

  it('always sums exactly to the total regardless of weight shape', () => {
    const cases: Array<[number, number[]]> = [
      [1, [1, 1, 1]],
      [2, [1, 1, 1]],
      [7, [3, 1]],
      [10000, [1, 1, 1, 1, 1, 1, 1]],
      [999999, [17, 3, 5, 1, 1]],
    ]
    for (const [total, weights] of cases) {
      const shares = largestRemainderDistribute(total, weights)
      expect(sum(shares)).toBe(total)
      expect(shares.length).toBe(weights.length)
    }
  })

  it('weights shares/couples 2x correctly (shares split type)', () => {
    // A couple (weight 2) vs two singles (weight 1 each) splitting 400 minor units.
    const shares = largestRemainderDistribute(400, [2, 1, 1])
    expect(shares).toEqual([200, 100, 100])
  })

  it('handles JPY-style whole-unit distribution (zero decimals) exactly', () => {
    // 10000 yen across 3 people: no minor-unit subdivision, still must sum exactly.
    const shares = largestRemainderDistribute(10000, [1, 1, 1])
    expect(sum(shares)).toBe(10000)
  })

  it('supports negative totals (refunds) preserving exact sum', () => {
    const shares = largestRemainderDistribute(-100, [1, 1, 1])
    expect(sum(shares)).toBe(-100)
    // magnitudes should mirror the positive case
    expect(shares.map(Math.abs).sort((a, b) => b - a)).toEqual([34, 33, 33])
    expect(shares.every((s) => s <= 0)).toBe(true)
  })

  it('handles a single weight (no splitting needed)', () => {
    expect(largestRemainderDistribute(500, [1])).toEqual([500])
  })

  it('handles zero total', () => {
    expect(largestRemainderDistribute(0, [1, 1, 1])).toEqual([0, 0, 0])
  })

  it('handles all-zero weights by falling back to an even split', () => {
    const shares = largestRemainderDistribute(100, [0, 0, 0])
    expect(sum(shares)).toBe(100)
  })

  it('handles a weight of zero mixed with non-zero weights (that person gets nothing)', () => {
    const shares = largestRemainderDistribute(100, [1, 0, 1])
    expect(sum(shares)).toBe(100)
    expect(shares[1]).toBe(0)
  })

  it('throws on non-integer total', () => {
    expect(() => largestRemainderDistribute(10.5, [1, 1])).toThrow()
  })

  it('throws when weights is empty and total is non-zero', () => {
    expect(() => largestRemainderDistribute(100, [])).toThrow()
  })

  it('returns empty array when weights is empty and total is zero', () => {
    expect(largestRemainderDistribute(0, [])).toEqual([])
  })

  it('throws on negative weights', () => {
    expect(() => largestRemainderDistribute(100, [1, -1])).toThrow()
  })

  it('is deterministic for equal remainders (tie-break by original index)', () => {
    // 4 equal weights splitting 10 -> exact shares of 2.5 each, remainder .5 all tied.
    // Ties should break toward lower index consistently across repeated calls.
    const run1 = largestRemainderDistribute(10, [1, 1, 1, 1])
    const run2 = largestRemainderDistribute(10, [1, 1, 1, 1])
    expect(run1).toEqual(run2)
    expect(sum(run1)).toBe(10)
  })

  it('handles many weights with a large total without losing precision', () => {
    const weights = Array.from({ length: 37 }, () => 1)
    const shares = largestRemainderDistribute(123456789, weights)
    expect(sum(shares)).toBe(123456789)
  })

  it('split-by-nights-present style weighting (uneven nights per person)', () => {
    // 3 people staying 5, 3, and 1 nights respectively, accommodation cost 900 (minor units)
    const shares = largestRemainderDistribute(900, [5, 3, 1])
    expect(shares).toEqual([500, 300, 100])
    expect(sum(shares)).toBe(900)
  })
})

describe('distributeProportionalToSubtotals', () => {
  it('distributes tax proportionally to item subtotals and sums exactly', () => {
    // Items: 1000, 2000, 700 (minor units) subtotal = 3700; tax = 296 (8%)
    const subtotals = [1000, 2000, 700]
    const tax = 296
    const shares = distributeProportionalToSubtotals(tax, subtotals)
    expect(sum(shares)).toBe(tax)
    expect(shares.length).toBe(3)
  })

  it('handles a tip distributed across subtotals with an odd remainder', () => {
    const subtotals = [333, 333, 334]
    const tip = 100
    const shares = distributeProportionalToSubtotals(tip, subtotals)
    expect(sum(shares)).toBe(100)
  })
})
