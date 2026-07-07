import { describe, it, expect } from 'vitest'
import {
  getPerPersonCostImpact,
  getSectionRunningTotal,
  formatCostImpact,
  getTierSensitivityLine,
  isTieredCostImpact,
} from './costImpact'

describe('getPerPersonCostImpact', () => {
  it('returns null when there is no price', () => {
    expect(getPerPersonCostImpact({ price: null, currency: 'GBP', priceType: 'per_person_fixed', confirmedCount: 5 })).toBeNull()
  })

  it('returns null when there is no currency', () => {
    expect(getPerPersonCostImpact({ price: 100, currency: null, priceType: 'per_person_fixed', confirmedCount: 5 })).toBeNull()
  })

  it('per_person_fixed returns the listed price unchanged', () => {
    expect(getPerPersonCostImpact({ price: 54, currency: 'GBP', priceType: 'per_person_fixed', confirmedCount: 5 })).toBe(54)
  })

  it('per_person_tiered returns the listed price unchanged (already a per-person tier price)', () => {
    expect(getPerPersonCostImpact({ price: 120, currency: 'GBP', priceType: 'per_person_tiered', confirmedCount: 5 })).toBe(120)
  })

  it('total_split divides the total across confirmed participants', () => {
    expect(getPerPersonCostImpact({ price: 500, currency: 'GBP', priceType: 'total_split', confirmedCount: 5 })).toBe(100)
  })

  it('total_split treats zero confirmed as 1 to avoid divide-by-zero', () => {
    expect(getPerPersonCostImpact({ price: 500, currency: 'GBP', priceType: 'total_split', confirmedCount: 0 })).toBe(500)
  })

  it('total_split with JPY (zero-decimal currency) rounds to whole yen', () => {
    const result = getPerPersonCostImpact({ price: 10000, currency: 'JPY', priceType: 'total_split', confirmedCount: 3 })
    // 10000 / 3 = 3333.33... -> rounds to nearest whole yen
    expect(result).toBe(3333)
  })
})

describe('getSectionRunningTotal', () => {
  it('sums cost impact across options grouped by currency', () => {
    const options = [
      { price: 100, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'available' },
      { price: 50, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'available' },
      { price: 30, currency: 'EUR', price_type: 'per_person_fixed' as const, status: 'available' },
    ]
    const totals = getSectionRunningTotal(options, 5, null, ['a', 'b', 'c'])
    expect(totals.GBP).toBe(150)
    expect(totals.EUR).toBe(30)
  })

  it('excludes cancelled options', () => {
    const options = [
      { price: 100, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'cancelled' },
      { price: 50, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'available' },
    ]
    const totals = getSectionRunningTotal(options, 5, null, ['a', 'b'])
    expect(totals.GBP).toBe(50)
  })

  it('restricts to leadingOptionIds when provided', () => {
    const options = [
      { price: 100, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'available' },
      { price: 50, currency: 'GBP', price_type: 'per_person_fixed' as const, status: 'available' },
    ]
    const totals = getSectionRunningTotal(options, 5, new Set(['a']), ['a', 'b'])
    expect(totals.GBP).toBe(100)
  })

  it('is tier-aware when an option carries price_tiers metadata', () => {
    const options = [
      { price: null, currency: 'GBP', price_type: 'total_split' as const, status: 'available', metadata: { price_tiers: [{ max_people: 6, total: 300 }] } },
    ]
    const totals = getSectionRunningTotal(options, 6, null, ['a'])
    expect(totals.GBP).toBe(50)
  })
})

describe('tier-aware cost impact (UX_REDESIGN.md Part 5, shape 3)', () => {
  const tieredMetadata = { price_tiers: [{ max_people: 6, total: 300 }, { max_people: 12, total: 450 }] }

  it('isTieredCostImpact is true when price_tiers are present', () => {
    expect(isTieredCostImpact(tieredMetadata)).toBe(true)
    expect(isTieredCostImpact(null)).toBe(false)
    expect(isTieredCostImpact({ grid_row: 'x' })).toBe(false)
  })

  it('getPerPersonCostImpact prefers price_tiers over price_type when both are present', () => {
    const result = getPerPersonCostImpact({
      price: 999, // should be ignored — tiers take precedence
      currency: 'GBP',
      priceType: 'total_split',
      confirmedCount: 9,
      metadata: tieredMetadata,
    })
    expect(result).toBe(50) // 450 / 9
  })

  it('falls back to price/price_type when metadata has no tiers', () => {
    const result = getPerPersonCostImpact({
      price: 100,
      currency: 'GBP',
      priceType: 'per_person_fixed',
      confirmedCount: 9,
      metadata: null,
    })
    expect(result).toBe(100)
  })

  it('formatCostImpact renders the tiered headline with headcount', () => {
    const formatted = formatCostImpact({ price: null, currency: 'GBP', priceType: 'total_split', confirmedCount: 9, metadata: tieredMetadata })
    expect(formatted).toBe('≈£50/person at 9 people')
  })

  it('formatCostImpact renders the non-tiered headline unchanged', () => {
    const formatted = formatCostImpact({ price: 54, currency: 'GBP', priceType: 'per_person_fixed', confirmedCount: 5 })
    expect(formatted).toBe('+£54/person')
  })

  it('getTierSensitivityLine renders both tier boundaries', () => {
    const line = getTierSensitivityLine({ price: null, currency: 'GBP', priceType: 'total_split', confirmedCount: 9, metadata: tieredMetadata })
    expect(line).toBe('£50/pp if 6 · £37.50/pp if 12')
  })

  it('getTierSensitivityLine is null for a non-tiered option', () => {
    const line = getTierSensitivityLine({ price: 54, currency: 'GBP', priceType: 'per_person_fixed', confirmedCount: 5 })
    expect(line).toBeNull()
  })

  it('flags aboveTop-derived headline still resolves a per-person figure beyond the top tier', () => {
    const formatted = formatCostImpact({ price: null, currency: 'GBP', priceType: 'total_split', confirmedCount: 30, metadata: tieredMetadata })
    expect(formatted).toBe('≈£15/person at 30 people') // 450 / 30
  })
})
