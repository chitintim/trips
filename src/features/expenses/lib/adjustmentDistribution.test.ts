import { describe, it, expect } from 'vitest'
import {
  computeAddOnAmount,
  computeReconciliationBar,
  distributeAdjustmentsAcrossLines,
  distributeAdjustmentsAcrossClaimants,
  type AdjustmentsConfig,
} from './adjustmentDistribution'

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0)
}

const noAdjustments: AdjustmentsConfig = {
  tax: { mode: 'none', percent: 0 },
  service: { mode: 'none', percent: 0 },
  tipMinor: 0,
  discountMinor: 0,
}

describe('computeAddOnAmount', () => {
  it('returns 0 when mode is none', () => {
    expect(computeAddOnAmount({ mode: 'none', percent: 10 }, 10000)).toBe(0)
  })

  it('returns 0 when mode is included (already inside base)', () => {
    expect(computeAddOnAmount({ mode: 'included', percent: 10 }, 10000)).toBe(0)
  })

  it('computes the percent add-on when added_on_top', () => {
    expect(computeAddOnAmount({ mode: 'added_on_top', percent: 10 }, 10000)).toBe(1000)
  })

  it('handles fractional percents (12.5%) correctly', () => {
    expect(computeAddOnAmount({ mode: 'added_on_top', percent: 12.5 }, 10000)).toBe(1250)
  })
})

describe('computeReconciliationBar', () => {
  it('is exact when items alone match the printed total (no adjustments)', () => {
    const result = computeReconciliationBar([1000, 2000, 3000], noAdjustments, 6000)
    expect(result.isExact).toBe(true)
    expect(result.deltaMinor).toBe(0)
  })

  it('is exact when a service charge added on top reconciles to the printed total', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'added_on_top', percent: 10 },
      tipMinor: 0,
      discountMinor: 0,
    }
    // items = 10000, +10% service = 1000 -> total 11000
    const result = computeReconciliationBar([4000, 6000], config, 11000)
    expect(result.isExact).toBe(true)
  })

  it('is amber (not exact) with a nonzero delta when nothing reconciles', () => {
    const result = computeReconciliationBar([1000, 2000], noAdjustments, 5000)
    expect(result.isExact).toBe(false)
    expect(result.deltaMinor).toBe(-2000)
  })

  it('accounts for tip and discount together', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'none', percent: 0 },
      tipMinor: 500,
      discountMinor: 200,
    }
    // items 10000 + tip 500 - discount 200 = 10300
    const result = computeReconciliationBar([10000], config, 10300)
    expect(result.isExact).toBe(true)
  })

  it('treats "included" tax as contributing zero on top (already inside item prices)', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'included', percent: 20 },
      service: { mode: 'none', percent: 0 },
      tipMinor: 0,
      discountMinor: 0,
    }
    const result = computeReconciliationBar([12000], config, 12000)
    expect(result.isExact).toBe(true)
  })
})

describe('distributeAdjustmentsAcrossLines', () => {
  it('distributes a service charge proportionally to line subtotals with exact sum', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'added_on_top', percent: 10 },
      tipMinor: 0,
      discountMinor: 0,
    }
    const lines = [3333, 3333, 3334] // sums to 10000
    const shares = distributeAdjustmentsAcrossLines(lines, config)
    const serviceTotal = sum(shares.map((s) => s.serviceShareMinor))
    expect(serviceTotal).toBe(1000) // exactly 10% of 10000, no drift
    // Each line's total-with-adjustments should sum to the grand total.
    const grandTotal = sum(shares.map((s) => s.totalWithAdjustmentsMinor))
    expect(grandTotal).toBe(11000)
  })

  it('gives zero adjustment share to a fully-discounted (zero-subtotal) line', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'added_on_top', percent: 10 },
      tipMinor: 100,
      discountMinor: 0,
    }
    const lines = [0, 10000]
    const shares = distributeAdjustmentsAcrossLines(lines, config)
    expect(shares[0].serviceShareMinor).toBe(0)
    expect(shares[0].tipShareMinor).toBe(0)
    expect(shares[1].serviceShareMinor).toBe(1000)
    expect(shares[1].tipShareMinor).toBe(100)
  })

  it('handles a tax+service+tip+discount combination summing exactly (the JP dual-rate style case)', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'added_on_top', percent: 8 },
      service: { mode: 'added_on_top', percent: 10 },
      tipMinor: 300,
      discountMinor: 150,
    }
    const lines = [1234, 5678, 9012, 111]
    const shares = distributeAdjustmentsAcrossLines(lines, config)

    const itemsTotal = sum(lines)
    const taxTotal = computeAddOnAmount(config.tax, itemsTotal)
    const serviceTotal = computeAddOnAmount(config.service, itemsTotal)
    const expectedGrandTotal = itemsTotal + taxTotal + serviceTotal + config.tipMinor - config.discountMinor

    const grandTotal = sum(shares.map((s) => s.totalWithAdjustmentsMinor))
    expect(grandTotal).toBe(expectedGrandTotal)

    // Every individual adjustment distributes to exactly its total (no drift per adjustment type).
    expect(sum(shares.map((s) => s.taxShareMinor))).toBe(taxTotal)
    expect(sum(shares.map((s) => s.serviceShareMinor))).toBe(serviceTotal)
    expect(sum(shares.map((s) => s.tipShareMinor))).toBe(config.tipMinor)
    expect(sum(shares.map((s) => s.discountShareMinor))).toBe(config.discountMinor)
  })

  it('handles a single line item (no splitting needed)', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'added_on_top', percent: 5 },
      service: { mode: 'none', percent: 0 },
      tipMinor: 0,
      discountMinor: 0,
    }
    const shares = distributeAdjustmentsAcrossLines([2000], config)
    expect(shares).toHaveLength(1)
    expect(shares[0].totalWithAdjustmentsMinor).toBe(2100)
  })

  it('handles an all-zero-subtotal receipt without throwing (falls back to even split for a zero total)', () => {
    const shares = distributeAdjustmentsAcrossLines([0, 0, 0], noAdjustments)
    expect(shares.every((s) => s.totalWithAdjustmentsMinor === 0)).toBe(true)
  })
})

describe('distributeAdjustmentsAcrossClaimants', () => {
  it('distributes adjustments proportionally to each claimant subtotal, summing exactly', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'none', percent: 0 },
      service: { mode: 'added_on_top', percent: 12.5 },
      tipMinor: 0,
      discountMinor: 0,
    }
    const claimants = new Map([
      ['alice', 4000],
      ['bob', 6000],
    ])
    const result = distributeAdjustmentsAcrossClaimants(claimants, config)
    const total = sum(Array.from(result.values()))
    expect(total).toBe(10000 + 1250) // items + 12.5% service
    expect(result.get('bob')!).toBeGreaterThan(result.get('alice')!)
  })

  it('handles a single claimant (whole receipt claimed by one person)', () => {
    const config: AdjustmentsConfig = {
      tax: { mode: 'added_on_top', percent: 10 },
      service: { mode: 'none', percent: 0 },
      tipMinor: 200,
      discountMinor: 0,
    }
    const claimants = new Map([['solo', 5000]])
    const result = distributeAdjustmentsAcrossClaimants(claimants, config)
    expect(result.get('solo')).toBe(5000 + 500 + 200)
  })
})
