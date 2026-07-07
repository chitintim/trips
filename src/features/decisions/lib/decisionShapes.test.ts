import { describe, it, expect } from 'vitest'
import {
  getDecisionShape,
  isPersonalOrderSection,
  readOptionPricing,
  sectionHasCatalogPricing,
  countDaysInclusive,
  resolveVariantPricing,
  computeOrderItemTotal,
  buildOrderLine,
  sumOrderLinesByCurrency,
  readPriceTiers,
  hasPriceTiers,
  applicableTier,
  perPersonAtTier,
  tierSensitivity,
  getTierCostImpact,
} from './decisionShapes'

describe('getDecisionShape', () => {
  it('defaults to vote when metadata is null', () => {
    expect(getDecisionShape(null)).toBe('vote')
  })

  it('defaults to vote when metadata has no decision_shape key', () => {
    expect(getDecisionShape({ something_else: true })).toBe('vote')
  })

  it('reads personal when set', () => {
    expect(getDecisionShape({ decision_shape: 'personal' })).toBe('personal')
  })

  it('reads vote when explicitly set', () => {
    expect(getDecisionShape({ decision_shape: 'vote' })).toBe('vote')
  })

  it('isPersonalOrderSection mirrors getDecisionShape', () => {
    expect(isPersonalOrderSection({ decision_shape: 'personal' })).toBe(true)
    expect(isPersonalOrderSection(null)).toBe(false)
  })
})

describe('readOptionPricing / sectionHasCatalogPricing', () => {
  it('returns null when no pricing set', () => {
    expect(readOptionPricing(null)).toBeNull()
    expect(readOptionPricing({ grid_row: 'x' })).toBeNull()
  })

  it('reads pricing object', () => {
    expect(readOptionPricing({ pricing: { per_day: 20 } })).toEqual({ per_day: 20 })
  })

  it('sectionHasCatalogPricing true if any option has pricing', () => {
    const options = [{ metadata: null }, { metadata: { pricing: { flat: 50 } } }]
    expect(sectionHasCatalogPricing(options)).toBe(true)
  })

  it('sectionHasCatalogPricing false if none do', () => {
    expect(sectionHasCatalogPricing([{ metadata: null }])).toBe(false)
  })
})

describe('countDaysInclusive', () => {
  it('same day counts as 1', () => {
    expect(countDaysInclusive('2026-08-01', '2026-08-01')).toBe(1)
  })

  it('counts inclusive range', () => {
    expect(countDaysInclusive('2026-08-01', '2026-08-05')).toBe(5)
  })

  it('never returns less than 1 for a reversed range', () => {
    expect(countDaysInclusive('2026-08-05', '2026-08-01')).toBe(1)
  })
})

describe('resolveVariantPricing', () => {
  const pricing = {
    per_day: 15,
    variants: [
      { label: 'Adult', per_day: 20 },
      { label: 'Kids', per_day: 10 },
    ],
  }

  it('falls back to base rate when no variant given', () => {
    expect(resolveVariantPricing(pricing)).toEqual({ per_day: 15, flat: undefined })
  })

  it('resolves a matching variant', () => {
    expect(resolveVariantPricing(pricing, 'Kids')).toEqual({ per_day: 10, flat: undefined })
  })

  it('falls back to base rate when variant label does not match', () => {
    expect(resolveVariantPricing(pricing, 'Snowboard')).toEqual({ per_day: 15, flat: undefined })
  })
})

describe('computeOrderItemTotal', () => {
  it('flat pricing ignores dates', () => {
    const total = computeOrderItemTotal({ flat: 40 }, { start_date: '2026-08-01', end_date: '2026-08-10' }, 'GBP')
    expect(total).toBe(40)
  })

  it('per_day pricing multiplies by inclusive day count', () => {
    const total = computeOrderItemTotal({ per_day: 12 }, { start_date: '2026-08-01', end_date: '2026-08-05' }, 'GBP')
    expect(total).toBe(60) // 12 * 5 days
  })

  it('per_day with no dates falls back to a single day', () => {
    const total = computeOrderItemTotal({ per_day: 12 }, {}, 'GBP')
    expect(total).toBe(12)
  })

  it('multiplies by quantity', () => {
    const total = computeOrderItemTotal({ flat: 40 }, { quantity: 3 }, 'GBP')
    expect(total).toBe(120)
  })

  it('resolves variant pricing before computing', () => {
    const pricing = { per_day: 20, variants: [{ label: 'Kids', per_day: 10 }] }
    const total = computeOrderItemTotal(pricing, { variant: 'Kids', start_date: '2026-08-01', end_date: '2026-08-03' }, 'GBP')
    expect(total).toBe(30) // 10 * 3 days
  })

  it('returns 0 when pricing has neither flat nor per_day', () => {
    expect(computeOrderItemTotal({}, {}, 'GBP')).toBe(0)
  })

  it('handles JPY (zero-decimal currency) without float drift', () => {
    const total = computeOrderItemTotal({ per_day: 3333 }, { start_date: '2026-08-01', end_date: '2026-08-03', quantity: 1 }, 'JPY')
    expect(total).toBe(9999)
  })
})

describe('buildOrderLine / sumOrderLinesByCurrency', () => {
  it('builds a display-ready line', () => {
    const line = buildOrderLine(
      { id: 'opt-1', title: 'Skis', currency: 'GBP' },
      { per_day: 10 },
      { start_date: '2026-08-01', end_date: '2026-08-03', variant: 'Adult', quantity: 2 },
      'GBP'
    )
    expect(line).toEqual({
      optionId: 'opt-1',
      optionTitle: 'Skis',
      variant: 'Adult',
      quantity: 2,
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      total: 60, // 10 * 3 days * 2 qty
      currency: 'GBP',
    })
  })

  it('falls back to the section currency when the option has none', () => {
    const line = buildOrderLine({ id: 'opt-1', title: 'Skis', currency: null }, { flat: 5 }, {}, 'EUR')
    expect(line.currency).toBe('EUR')
  })

  it('sums totals grouped by currency', () => {
    const lines = [
      { optionId: 'a', optionTitle: 'A', variant: null, quantity: 1, startDate: null, endDate: null, total: 50, currency: 'GBP' },
      { optionId: 'b', optionTitle: 'B', variant: null, quantity: 1, startDate: null, endDate: null, total: 30, currency: 'GBP' },
      { optionId: 'c', optionTitle: 'C', variant: null, quantity: 1, startDate: null, endDate: null, total: 20, currency: 'EUR' },
    ]
    expect(sumOrderLinesByCurrency(lines)).toEqual({ GBP: 80, EUR: 20 })
  })
})

describe('readPriceTiers / hasPriceTiers', () => {
  it('returns empty array when absent', () => {
    expect(readPriceTiers(null)).toEqual([])
    expect(hasPriceTiers(null)).toBe(false)
  })

  it('reads tiers', () => {
    const tiers = [{ max_people: 6, total: 300 }]
    expect(readPriceTiers({ price_tiers: tiers })).toEqual(tiers)
    expect(hasPriceTiers({ price_tiers: tiers })).toBe(true)
  })
})

describe('applicableTier', () => {
  const tiers = [
    { max_people: 6, total: 300 },
    { max_people: 12, total: 450 },
  ]

  it('returns null for an empty tier list', () => {
    expect(applicableTier([], 5)).toBeNull()
  })

  it('picks the first tier when headcount is below the bottom boundary', () => {
    const result = applicableTier(tiers, 2)
    expect(result).toEqual({ tier: tiers[0], index: 0, aboveTop: false })
  })

  it('picks the tier exactly at its max_people boundary', () => {
    const result = applicableTier(tiers, 6)
    expect(result).toEqual({ tier: tiers[0], index: 0, aboveTop: false })
  })

  it('picks the next tier just above a boundary', () => {
    const result = applicableTier(tiers, 7)
    expect(result).toEqual({ tier: tiers[1], index: 1, aboveTop: false })
  })

  it('picks the top tier exactly at its own boundary', () => {
    const result = applicableTier(tiers, 12)
    expect(result).toEqual({ tier: tiers[1], index: 1, aboveTop: false })
  })

  it('falls back to the top tier with aboveTop when headcount exceeds every tier', () => {
    const result = applicableTier(tiers, 20)
    expect(result).toEqual({ tier: tiers[1], index: 1, aboveTop: true })
  })

  it('sorts unsorted tier input before resolving', () => {
    const unsorted = [
      { max_people: 12, total: 450 },
      { max_people: 6, total: 300 },
    ]
    expect(applicableTier(unsorted, 6)).toEqual({ tier: { max_people: 6, total: 300 }, index: 0, aboveTop: false })
  })
})

describe('perPersonAtTier', () => {
  it('divides the tier total across headcount', () => {
    expect(perPersonAtTier({ max_people: 12, total: 450 }, 9, 'GBP')).toBe(50)
  })

  it('treats zero headcount as 1', () => {
    expect(perPersonAtTier({ max_people: 12, total: 450 }, 0, 'GBP')).toBe(450)
  })

  it('rounds to the nearest minor unit', () => {
    expect(perPersonAtTier({ max_people: 3, total: 100 }, 3, 'GBP')).toBe(33.33)
  })
})

describe('tierSensitivity', () => {
  it('returns per-person at each tier boundary, sorted ascending by headcount', () => {
    const tiers = [
      { max_people: 12, total: 450 },
      { max_people: 6, total: 300 },
    ]
    const result = tierSensitivity(tiers, 'GBP')
    expect(result).toEqual([
      { headcount: 6, perPerson: 50 }, // 300/6
      { headcount: 12, perPerson: 37.5 }, // 450/12
    ])
  })
})

describe('getTierCostImpact', () => {
  const tiers = [
    { max_people: 6, total: 300 },
    { max_people: 12, total: 450 },
  ]

  it('returns null when there are no tiers', () => {
    expect(getTierCostImpact([], 9, 'GBP')).toBeNull()
  })

  it('resolves the applicable tier, per-person cost, and sensitivity', () => {
    const impact = getTierCostImpact(tiers, 9, 'GBP')
    expect(impact).not.toBeNull()
    expect(impact!.perPerson).toBe(50) // 450/9
    expect(impact!.aboveTop).toBe(false)
    expect(impact!.sensitivity).toEqual([
      { headcount: 6, perPerson: 50 },
      { headcount: 12, perPerson: 37.5 },
    ])
  })

  it('flags aboveTop when headcount exceeds every tier', () => {
    const impact = getTierCostImpact(tiers, 30, 'GBP')
    expect(impact!.aboveTop).toBe(true)
    expect(impact!.perPerson).toBe(15) // 450/30
  })
})
