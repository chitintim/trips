import { describe, expect, it } from 'vitest'
import { readPriceBasis } from '../../../lib/cost/priceBasis'
import { buildPricing, defaultBasisForSection, emptyPricing, pricingFromDraft, pricingFromOption, validatePricing } from './optionPricingForm'

const trip = { start_date: '2026-08-10', end_date: '2026-08-18' } // 8 nights

function row(price_type: string, metadata: Record<string, unknown> | null, price: number | null = 250, currency: string | null = 'GBP') {
  return { price, currency, price_type, metadata: metadata as never }
}

describe('pricing form <-> metadata round trips', () => {
  it('each', () => {
    const o = row('per_person_fixed', { source: 'link_parse' }, 50)
    const f = pricingFromOption(o, trip)
    expect(f.basis).toBe('each')
    const b = buildPricing(f, o, trip)
    expect(b).toMatchObject({ price: 50, currency: 'GBP', price_type: 'per_person_fixed' })
    expect((b.metadata as Record<string, unknown>).source).toBe('link_parse')
    expect(readPriceBasis(b)).toBe('each')
  })

  it('total_split', () => {
    const o = row('total_split', null, 2000)
    const f = pricingFromOption(o, trip)
    expect(f.basis).toBe('total_split')
    const b = buildPricing(f, o, trip)
    expect(b.price_type).toBe('total_split')
    expect(b.price).toBe(2000)
    expect(readPriceBasis(b)).toBe('total_split')
  })

  it('per_night prefills nights from trip dates and does not pin them', () => {
    const o = row('total_split', { price_basis: 'per_night', other: 1 })
    const f = pricingFromOption(o, trip)
    expect(f.basis).toBe('per_night')
    expect(f.nights).toBe('8')
    const b = buildPricing(f, o, trip)
    const m = b.metadata as Record<string, unknown>
    expect(m.nights).toBeUndefined()
    expect(m.other).toBe(1)
    expect(readPriceBasis(b)).toBe('per_night')
  })

  it('per_night with an edited night count stores it and reads it back', () => {
    const o = row('total_split', { price_basis: 'per_night' })
    const f = { ...pricingFromOption(o, trip), nights: '5' }
    const b = buildPricing(f, o, trip)
    expect((b.metadata as Record<string, unknown>).nights).toBe(5)
    expect(pricingFromOption({ ...b, price: 250, currency: 'GBP' } as never, trip).nights).toBe('5')
  })

  it('by_group_size keeps tiers and the hidden fallback price', () => {
    const tiers = [{ max_people: 6, total: 300 }, { max_people: 12, total: 450 }]
    const o = row('total_split', { price_tiers: tiers }, 999)
    const f = pricingFromOption(o, trip)
    expect(f.basis).toBe('by_group_size')
    expect(f.tiers).toEqual([{ maxPeople: '6', total: '300' }, { maxPeople: '12', total: '450' }])
    const b = buildPricing(f, o, trip)
    expect((b.metadata as Record<string, unknown>).price_tiers).toEqual(tiers)
    expect(b.price).toBe(999)
    expect(readPriceBasis(b)).toBe('by_group_size')
  })

  it('switching away from tiers drops them but keeps other keys', () => {
    const o = row('total_split', { price_tiers: [{ max_people: 6, total: 300 }], source_url: 'x' })
    const b = buildPricing({ ...pricingFromOption(o, trip), basis: 'each' }, o, trip)
    const m = b.metadata as Record<string, unknown>
    expect(m.price_tiers).toBeUndefined()
    expect(m.source_url).toBe('x')
    expect(b.price_type).toBe('per_person_fixed')
  })

  it('legacy per_person_tiered shows as each and keeps its stored type + grid keys', () => {
    const o = row('per_person_tiered', { grid_row: 'A', grid_column: 'Skis' }, 40)
    const f = pricingFromOption(o, trip)
    expect(f.basis).toBe('each')
    const b = buildPricing(f, o, trip)
    expect(b.price_type).toBe('per_person_tiered')
    expect(b.metadata).toEqual({ grid_row: 'A', grid_column: 'Skis' }) // an unchanged save adds nothing
  })

  it('no price: saves with null price and currency', () => {
    const b = buildPricing(emptyPricing('each'), null, trip)
    expect(b.price).toBeNull()
    expect(b.currency).toBeNull()
  })
})

describe('validation', () => {
  const base = emptyPricing('each')
  it('allows no price', () => expect(validatePricing(base)).toBeNull())
  it('rejects negative price', () => expect(validatePricing({ ...base, price: '-3' })).toMatch(/negative/))
  it('rejects nights below 1', () => expect(validatePricing({ ...base, basis: 'per_night', nights: '0' })).toMatch(/Nights/))
  it('rejects half-filled tier rows', () =>
    expect(validatePricing({ ...base, basis: 'by_group_size', tiers: [{ maxPeople: '6', total: '' }] })).toMatch(/both/))
})

describe('defaults', () => {
  it('accommodation -> total_split, others each', () => {
    expect(defaultBasisForSection('accommodation')).toBe('total_split')
    expect(defaultBasisForSection('activities')).toBe('each')
  })
  it('draft price_type maps to a basis', () => {
    expect(pricingFromDraft({ price_type: 'total_split' }, 'each').basis).toBe('total_split')
    expect(pricingFromDraft({ price_type: 'per_person_tiered' }, 'total_split').basis).toBe('each')
    expect(pricingFromDraft({}, 'total_split').basis).toBe('total_split')
  })
})

describe('meaningfulPrice', () => {
  it('drops a zero price so nothing shows as £0', async () => {
    const { meaningfulPrice } = await import('./optionPricingForm')
    expect(meaningfulPrice(null)).toBeNull()
    expect(meaningfulPrice({ perPerson: 0, total: 0 })).toBeNull()
    expect(meaningfulPrice({ perPerson: 12, total: 24 })).toEqual({ perPerson: 12, total: 24 })
  })
})

describe('review B5-B7: saving an unchanged option is a no-op on stored data', () => {
  const t = { start_date: '2026-08-10', end_date: '2026-08-18', base_currency: 'EUR' } // 8 nights
  type Stored = { price: number | null; currency: string | null; price_type: string; metadata: Record<string, unknown> | null }
  const legacy: Array<[string, Stored]> = [
    ['each, no metadata', { price: 50, currency: 'GBP', price_type: 'per_person_fixed', metadata: null }],
    ['each, other keys', { price: 50, currency: 'GBP', price_type: 'per_person_fixed', metadata: { source: 'link_parse', source_url: 'https://x' } }],
    ['total_split, no basis key', { price: 2000, currency: 'GBP', price_type: 'total_split', metadata: {} }],
    ['per_person_tiered + grid', { price: 40, currency: 'GBP', price_type: 'per_person_tiered', metadata: { grid_row: 'A', grid_column: 'Skis' } }],
    ['per_night, no explicit nights', { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night' } }],
    ['per_night, explicit nights equal to the trip nights', { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night', nights: 8 } }],
    ['per_night, explicit nights different', { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night', nights: 5 } }],
    ['per_night, legacy spelling', { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'night' } }],
    ['per_night with option dates', { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night', date_range: { start: '2026-08-11', end: '2026-08-14' } } }],
    ['tiers on a per_person_fixed row', { price: 100, currency: 'GBP', price_type: 'per_person_fixed', metadata: { price_tiers: [{ max_people: 6, total: 450 }, { max_people: 12, total: 600 }] } }],
    ['tiers, per_person_tiered', { price: null, currency: 'GBP', price_type: 'per_person_tiered', metadata: { price_tiers: [{ max_people: 6, total: 450 }] } }],
    ['tiers with total_split + basis', { price: null, currency: 'EUR', price_type: 'total_split', metadata: { price_basis: 'by_group_size', price_tiers: [{ max_people: 6, total: 450 }] } }],
    ['lone grid row', { price: 10, currency: 'GBP', price_type: 'per_person_fixed', metadata: { grid_row: 'Level A' } }],
    ['lone grid column', { price: 10, currency: 'GBP', price_type: 'per_person_fixed', metadata: { grid_column: 'Skis' } }],
    ['price with no currency', { price: 75, currency: null, price_type: 'per_person_fixed', metadata: null }],
    ['no price keeps its currency', { price: null, currency: 'EUR', price_type: 'per_person_fixed', metadata: { source: 'manual' } }],
    ['no price, no currency', { price: null, currency: null, price_type: 'per_person_fixed', metadata: null }],
    ['catalog pricing and stale keys', { price: 12, currency: 'GBP', price_type: 'per_person_fixed', metadata: { pricing: { per_day: 10 }, nights: 3, price_tiers: [] } }],
  ]
  it.each(legacy)('%s', (_name, o) => {
    const built = buildPricing(pricingFromOption(o as never, t), o as never, t)
    expect({ price: built.price, currency: built.currency, price_type: built.price_type, metadata: built.metadata }).toEqual({
      price: o.price,
      currency: o.currency,
      price_type: o.price_type,
      metadata: o.metadata,
    })
  })

  it('a null-currency price is displayed in the trip currency, not GBP', () => {
    expect(pricingFromOption({ price: 75, currency: null, price_type: 'per_person_fixed', metadata: null }, t).currency).toBe('EUR')
  })

  it('an edit still takes effect: changing the price or choosing a currency', () => {
    const o = { price: 75, currency: null, price_type: 'per_person_fixed', metadata: null }
    const b = buildPricing({ ...pricingFromOption(o, t), price: '80', currency: 'USD' }, o, t)
    expect(b).toMatchObject({ price: 80, currency: 'USD' })
  })

  it('an explicit nights value is kept when the organiser edits another field', () => {
    const o = { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night', nights: 8 } }
    const b = buildPricing({ ...pricingFromOption(o, t), price: '260' }, o, t)
    expect(b.metadata).toEqual({ price_basis: 'per_night', nights: 8 })
    expect(b.price).toBe(260)
  })

  it('changing the basis still cleans up (each drops nights and tiers)', () => {
    const o = { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night', nights: 5 } }
    const b = buildPricing({ ...pricingFromOption(o, t), basis: 'each' }, o, t)
    expect(b.price_type).toBe('per_person_fixed')
    expect(b.metadata).toEqual({ price_basis: 'each' })
  })

  it('editing one grid key leaves the other alone', () => {
    const o = { price: 10, currency: 'GBP', price_type: 'per_person_fixed', metadata: { grid_row: 'A', grid_column: 'Skis' } }
    const b = buildPricing({ ...pricingFromOption(o, t), gridRow: 'B' }, o, t)
    expect(b.metadata).toEqual({ grid_row: 'B', grid_column: 'Skis' })
  })
})
