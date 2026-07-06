import { describe, it, expect } from 'vitest'
import { getPerPersonCostImpact, getSectionRunningTotal } from './costImpact'

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
})
