import { describe, it, expect } from 'vitest'
import { getPerPersonCostImpact } from './costImpact'

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

describe('review B3: costImpact passes the trip so nights can be derived', () => {
  const base = { price: 250, currency: 'GBP', priceType: 'total_split' as const, confirmedCount: 9, metadata: { price_basis: 'per_night' }, isEstimate: false }
  it('with the trip, £250/night x 8 nights / 9', () => {
    expect(getPerPersonCostImpact({ ...base, trip: { start_date: '2027-03-01', end_date: '2027-03-09' } })).toBe(222.22)
  })
  it('without a trip it assumes one night (the caller can no longer pretend that is exact)', () => {
    expect(getPerPersonCostImpact(base)).toBe(27.78)
  })
})
