import { describe, it, expect } from 'vitest'
import { computeOptionPrice, headcountLabel, weakestCertainty } from './optionPrice'

const TRIP = { start_date: '2027-03-01', end_date: '2027-03-09' } // 8 nights
const GUESS = (count: number) => ({ count, isEstimate: true })
const REAL = (count: number) => ({ count, isEstimate: false })

describe('Tokyo Airbnb: per-night basis x nights / headcount', () => {
  const airbnb = { price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night' } }

  it('prices £250/night for the trip nights, split across the headcount', () => {
    const p = computeOptionPrice(airbnb, TRIP, GUESS(9))!
    expect(p.basis).toBe('per_night')
    expect(p.nights).toBe(8)
    expect(p.nightsSource).toBe('trip')
    expect(p.total).toBe(2000)
    expect(p.perPerson).toBe(222.22)
    expect(p.certainty).toBe('est')
    expect(p.isEstimate).toBe(true)
    expect(p.approximate).toBe(true)
    expect(p.headline).toBe('≈£222 each')
    expect(p.basisLine).toBe('£250/night · 8 nights · £2,000 total · 9 invited · est.')
  })

  it('says "going" when the headcount is confirmed', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(9), { decided: true })!
    expect(p.certainty).toBe('decided')
    expect(p.isEstimate).toBe(false)
    expect(p.headline).toBe('£222.22 each')
    expect(p.basisLine).toBe('£250/night · 8 nights · £2,000 total · 9 going · decided')
  })

  it('uses the option dates over the trip dates', () => {
    const p = computeOptionPrice({ ...airbnb, metadata: { price_basis: 'per_night', date_range: { start: '2027-03-02', end: '2027-03-05' } } }, TRIP, REAL(3))!
    expect(p.nights).toBe(3)
    expect(p.nightsSource).toBe('option_dates')
    expect(p.total).toBe(750)
    expect(p.perPerson).toBe(250)
  })

  it('a context nights override beats everything', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(4), { nights: 2 })!
    expect(p.total).toBe(500)
    expect(p.basisLine).toContain('2 nights')
  })

  it('singular night', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(2), { nights: 1 })!
    expect(p.basisLine).toContain('1 night ·')
  })

  it('a booking replaces the estimate with the real amount', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(9), { decided: true, booking: { amount: 1989.6, currency: 'GBP', status: 'paid' } })!
    expect(p.certainty).toBe('booked')
    expect(p.total).toBe(1989.6)
    expect(p.perPerson).toBe(221.07)
    expect(p.basisLine).toBe('£1,989.60 total · 9 going · booked')
  })

  it('a matched real expense wins: paid, with your own share', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(9), {
      decided: true,
      booking: { amount: 1989.6, currency: 'GBP' },
      actual: { total: 1989.6, currency: 'GBP', perPerson: 221.07 },
    })!
    expect(p.certainty).toBe('paid')
    expect(p.isEstimate).toBe(false)
    expect(p.perPerson).toBe(221.07)
    expect(p.headline).toBe('£221.07 each')
    expect(p.basisLine).toBe('£1,989.60 total · 9 going · paid')
  })

  it('a cancelled booking is ignored', () => {
    const p = computeOptionPrice(airbnb, TRIP, REAL(9), { decided: true, booking: { amount: 5, status: 'cancelled' } })!
    expect(p.certainty).toBe('decided')
    expect(p.total).toBe(2000)
  })
})

describe('per-person lift pass (each)', () => {
  const pass = { price: 54, currency: 'EUR', price_type: 'per_person_fixed' }
  it('is the listed price; the total is price x headcount; no ≈', () => {
    const p = computeOptionPrice(pass, TRIP, GUESS(9))!
    expect(p.basis).toBe('each')
    expect(p.perPerson).toBe(54)
    expect(p.total).toBe(486)
    expect(p.certainty).toBe('est')
    expect(p.isEstimate).toBe(true)
    expect(p.approximate).toBe(false)
    expect(p.dividedByHeadcount).toBe(false)
    expect(p.headline).toBe('€54 each')
    expect(p.basisLine).toBe('per person · est.')
  })
  it('the retired per_person_tiered reads as each', () => {
    const p = computeOptionPrice({ ...pass, price_type: 'per_person_tiered', price: 120 }, TRIP, REAL(5))!
    expect(p.basis).toBe('each')
    expect(p.perPerson).toBe(120)
  })
  it('keeps odd decimals verbatim', () => {
    expect(computeOptionPrice({ ...pass, price: 12.345 }, TRIP, REAL(2))!.perPerson).toBe(12.345)
  })
  it('decided word', () => {
    expect(computeOptionPrice(pass, TRIP, REAL(9), { decided: true })!.basisLine).toBe('per person · decided')
  })
})

describe('by-group-size chalet', () => {
  const chalet = {
    price: null,
    currency: 'GBP',
    price_type: 'total_split',
    metadata: { price_tiers: [{ max_people: 6, total: 450 }, { max_people: 12, total: 600 }] },
  }
  it('uses the tier at the headcount and shows sensitivity', () => {
    const p = computeOptionPrice(chalet, TRIP, GUESS(9))!
    expect(p.basis).toBe('by_group_size')
    expect(p.total).toBe(600)
    expect(p.perPerson).toBe(66.67)
    expect(p.headline).toBe('≈£67 each')
    expect(p.basisLine).toBe('£600 total · 9 invited · est.')
    expect(p.sensitivity?.aboveTop).toBe(false)
    expect(p.sensitivity?.line).toBe('£75 each if 6 · £50 each if 12')
  })
  it('smaller group lands in the smaller tier', () => {
    const p = computeOptionPrice(chalet, TRIP, REAL(5))!
    expect(p.total).toBe(450)
    expect(p.perPerson).toBe(90)
  })
  it('flags a group above the top tier', () => {
    const p = computeOptionPrice(chalet, TRIP, REAL(15))!
    expect(p.sensitivity?.aboveTop).toBe(true)
    expect(p.total).toBe(600)
    expect(p.perPerson).toBe(40)
  })
  it('matches the legacy cost-impact maths', async () => {
    const { getPerPersonCostImpact } = await import('../../features/decisions/lib/costImpact')
    for (const n of [1, 3, 6, 7, 12, 20]) {
      const legacy = getPerPersonCostImpact({ price: null, currency: 'GBP', priceType: 'total_split', confirmedCount: n, metadata: chalet.metadata })
      expect(computeOptionPrice(chalet, TRIP, n)!.perPerson).toBe(legacy)
    }
  })
})

describe('total_split and zero headcount', () => {
  it('divides a total and never by zero', () => {
    const villa = { price: 600, currency: 'GBP', price_type: 'total_split' }
    expect(computeOptionPrice(villa, TRIP, REAL(6))!.perPerson).toBe(100)
    expect(computeOptionPrice(villa, TRIP, REAL(0))!.perPerson).toBe(600)
  })
  it('a headcount that is a bare number counts as confirmed', () => {
    const villa = { price: 600, currency: 'GBP', price_type: 'total_split' }
    expect(computeOptionPrice(villa, TRIP, 6)!.headcountIsEstimate).toBe(false)
  })
})

describe('JPY item on a GBP trip stays in its own currency', () => {
  it('prices in yen with no decimals', () => {
    const p = computeOptionPrice({ price: 10000, currency: 'JPY', price_type: 'total_split' }, TRIP, REAL(3), { decided: true })!
    expect(p.currency).toBe('JPY')
    expect(p.perPerson).toBe(3333)
    expect(p.headline).toBe('¥3,333 each')
    expect(p.basisLine).toBe('¥10,000 total · 3 going · decided')
  })
})

describe('no price', () => {
  it('returns null', () => {
    expect(computeOptionPrice({ price: null, currency: 'GBP', price_type: 'per_person_fixed' }, TRIP, 4)).toBeNull()
    expect(computeOptionPrice({ price: 10, currency: null, price_type: 'per_person_fixed' }, TRIP, 4)).toBeNull()
  })
})

describe('weakestCertainty', () => {
  it('picks the least certain rung', () => {
    expect(weakestCertainty(['paid', 'decided', 'booked'])).toBe('decided')
    expect(weakestCertainty(['paid', 'est'])).toBe('est')
    expect(weakestCertainty([])).toBe('est')
  })
})

describe('review B1: the legacy booked flag', () => {
  it('a booked option is booked certainty at the listed price, never est.', () => {
    const p = computeOptionPrice({ price: 1800, currency: 'GBP', price_type: 'total_split', metadata: null }, TRIP, REAL(9), { booked: true })!
    expect(p.certainty).toBe('booked')
    expect(p.perPerson).toBe(200)
    expect(p.headline).toBe('£200 each')
    expect(p.basisLine).toBe('£1,800 total · 9 going · booked')
    expect(p.basisLine).not.toMatch(/est/)
  })
  it('an each price reads "per person · booked"', () => {
    const p = computeOptionPrice({ price: 50, currency: 'GBP', price_type: 'per_person_fixed', metadata: null }, TRIP, REAL(9), { booked: true })!
    expect(p.basisLine).toBe('per person · booked')
  })
})

describe('review B3: per-night with no derivable nights', () => {
  it('£250/night, no dates anywhere: not presented as exact', () => {
    const p = computeOptionPrice({ price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night' } }, null, REAL(9), { decided: true })!
    expect(p.nightsSource).toBe('default')
    expect(p.nightsAssumed).toBe(true)
    expect(p.approximate).toBe(true)
    expect(p.isEstimate).toBe(true)
    expect(p.headline).toBe('≈£28 each')
    expect(p.basisLine).toBe('£250/night · nights not set · 9 going · decided · est.')
  })
  it('with trip nights it is exact', () => {
    const p = computeOptionPrice({ price: 250, currency: 'GBP', price_type: 'total_split', metadata: { price_basis: 'per_night' } }, TRIP, REAL(9), { decided: true })!
    expect(p.nightsAssumed).toBe(false)
    expect(p.headline).toBe('£222.22 each')
  })
})

describe('review: the headcount noun follows the in-scope rule', () => {
  const o = { price: 1800, currency: 'GBP', price_type: 'total_split', metadata: null }
  it('tracking off: guessed headcount still says going', () => {
    expect(computeOptionPrice(o, TRIP, GUESS(9), { confirmationEnabled: false })!.basisLine).toBe('£1,800 total · 9 going · est.')
  })
  it('tracking on, nobody confirmed: invited', () => {
    expect(computeOptionPrice(o, TRIP, GUESS(9), { confirmationEnabled: true })!.basisLine).toBe('£1,800 total · 9 invited · est.')
  })
  it('omitted flag keeps the old wording', () => {
    expect(computeOptionPrice(o, TRIP, GUESS(9))!.basisLine).toBe('£1,800 total · 9 invited · est.')
    expect(headcountLabel(9, true, false)).toBe('9 going')
  })
})

describe('review B2: malformed tiers never throw', () => {
  const meta = (tiers: unknown) => ({ price_basis: 'by_group_size', price_tiers: tiers })
  it.each([
    [[{ max_people: 12 }]],
    [[{ max_people: 12, total: 'abc' }]],
    [[null, 'x', 7]],
    [{ not: 'an array' }],
  ])('%j', (tiers) => {
    expect(() => computeOptionPrice({ price: 500, currency: 'GBP', price_type: 'total_split', metadata: meta(tiers) as never }, TRIP, REAL(9))).not.toThrow()
  })
  it('coerces numeric strings and skips only the bad row', () => {
    const p = computeOptionPrice({ price: null, currency: 'GBP', price_type: 'total_split', metadata: meta([{ max_people: 12, total: '600' }, { max_people: 6 }]) as never }, TRIP, REAL(6))!
    expect(p.basis).toBe('by_group_size')
    expect(p.total).toBe(600)
    expect(p.perPerson).toBe(100)
  })
  it('sensitivity line uses whole-unit rounding on both ends', () => {
    const p = computeOptionPrice({ price: null, currency: 'GBP', price_type: 'total_split', metadata: meta([{ max_people: 6, total: 450 }, { max_people: 12, total: 450 }]) as never }, TRIP, REAL(6))!
    expect(p.sensitivity?.line).toBe('£75 each if 6 · £38 each if 12')
  })
})
