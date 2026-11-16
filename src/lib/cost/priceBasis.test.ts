import { describe, it, expect } from 'vitest'
import { applyPriceBasis, deriveNights, nightsBetween, readExplicitNights, readPriceBasis } from './priceBasis'

describe('readPriceBasis', () => {
  it('maps price_type', () => {
    expect(readPriceBasis({ price_type: 'per_person_fixed' })).toBe('each')
    expect(readPriceBasis({ price_type: 'total_split' })).toBe('total_split')
  })
  it('per_person_tiered is read as each', () => {
    expect(readPriceBasis({ price_type: 'per_person_tiered' })).toBe('each')
  })
  it('price_tiers make it by_group_size', () => {
    expect(readPriceBasis({ price_type: 'total_split', metadata: { price_tiers: [{ max_people: 6, total: 300 }] } })).toBe('by_group_size')
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_tiers: [{ max_people: 6, total: 300 }] } })).toBe('by_group_size')
  })
  it('metadata.price_basis wins, including legacy spellings', () => {
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_basis: 'per_night' } })).toBe('per_night')
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_basis: 'night' } })).toBe('per_night')
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_basis: 'stay' } })).toBe('total_split')
    expect(readPriceBasis({ price_type: 'total_split', metadata: { price_basis: 'each' } })).toBe('each')
  })
  it('by_group_size without tiers degrades to total_split; unknown values are ignored', () => {
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_basis: 'by_group_size' } })).toBe('total_split')
    expect(readPriceBasis({ price_type: 'total_split', metadata: { price_basis: 'weekly' } })).toBe('total_split')
  })
  it('tolerates null / array metadata', () => {
    expect(readPriceBasis({ metadata: null })).toBe('each')
    expect(readPriceBasis({ metadata: [] })).toBe('each')
  })
})

describe('nights', () => {
  it('nightsBetween', () => {
    expect(nightsBetween('2026-10-01', '2026-10-09')).toBe(8)
    expect(nightsBetween('2026-10-01', '2026-10-01')).toBeNull()
    expect(nightsBetween('2026-10-09', '2026-10-01')).toBeNull()
    expect(nightsBetween(null, '2026-10-01')).toBeNull()
    expect(nightsBetween('2026-03-28', '2026-03-30')).toBe(2) // across a clock change
  })
  it('readExplicitNights', () => {
    expect(readExplicitNights({ nights: 5 })).toBe(5)
    expect(readExplicitNights({ nights: 0 })).toBeNull()
    expect(readExplicitNights({ nights: '5' })).toBeNull()
  })
  it('order: option nights, option dates, trip, default', () => {
    const trip = { start_date: '2026-10-01', end_date: '2026-10-09' }
    expect(deriveNights({ nights: 3, date_range: { start: '2026-10-02', end: '2026-10-07' } }, trip)).toEqual({ nights: 3, source: 'option_nights' })
    expect(deriveNights({ date_range: { start: '2026-10-02', end: '2026-10-07' } }, trip)).toEqual({ nights: 5, source: 'option_dates' })
    expect(deriveNights({}, trip)).toEqual({ nights: 8, source: 'trip' })
    expect(deriveNights(null, null)).toEqual({ nights: 1, source: 'default' })
  })
})

describe('applyPriceBasis', () => {
  it('each -> per_person_fixed, drops tiers and nights', () => {
    const out = applyPriceBasis({ price_tiers: [{ max_people: 6, total: 1 }], nights: 4, grid_row: 'A' }, 'each')
    expect(out.price_type).toBe('per_person_fixed')
    expect(out.metadata).toEqual({ price_basis: 'each', grid_row: 'A' })
  })
  it('per_night -> total_split with nights; keeps other keys', () => {
    const out = applyPriceBasis({ source: 'manual' }, 'per_night', { nights: 8 })
    expect(out.price_type).toBe('total_split')
    expect(out.metadata).toEqual({ source: 'manual', price_basis: 'per_night', nights: 8 })
    expect(readPriceBasis({ price_type: out.price_type, metadata: out.metadata })).toBe('per_night')
  })
  it('per_night keeps existing nights when none given; null clears', () => {
    expect(applyPriceBasis({ nights: 4 }, 'per_night').metadata).toMatchObject({ nights: 4 })
    expect(applyPriceBasis({ nights: 4 }, 'per_night', { nights: null }).metadata).not.toHaveProperty('nights')
  })
  it('by_group_size keeps tiers', () => {
    const tiers = [{ max_people: 6, total: 450 }]
    const out = applyPriceBasis({ price_tiers: tiers }, 'by_group_size')
    expect(out.price_type).toBe('total_split')
    expect(out.metadata).toMatchObject({ price_basis: 'by_group_size', price_tiers: tiers })
  })
  it('round-trips every basis', () => {
    for (const basis of ['each', 'total_split', 'per_night', 'by_group_size'] as const) {
      const out = applyPriceBasis(basis === 'by_group_size' ? { price_tiers: [{ max_people: 6, total: 1 }] } : {}, basis)
      expect(readPriceBasis({ price_type: out.price_type, metadata: out.metadata })).toBe(basis)
    }
  })
})

describe('review B2: hasTiers uses the validated reader', () => {
  it('a tier list with no usable row is not by_group_size', () => {
    expect(readPriceBasis({ price_type: 'per_person_fixed', metadata: { price_tiers: [{ max_people: 12 }, { total: 5 }] } as never })).toBe('each')
    expect(readPriceBasis({ price_type: 'total_split', metadata: { price_basis: 'by_group_size', price_tiers: [{ max_people: 'a', total: 1 }] } as never })).toBe('total_split')
  })
  it('one good row among bad ones is enough', () => {
    expect(readPriceBasis({ price_type: 'total_split', metadata: { price_tiers: [{ max_people: 6 }, { max_people: 12, total: '600' }] } as never })).toBe('by_group_size')
  })
})
