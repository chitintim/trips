import { describe, it, expect, vi } from 'vitest'
import { buildYourCost, computeEventPrice, readCostScope, readEventCost, withEventCost, yourCostHeadline, type CostOptionInput, type CostSectionInput, type YourCostInput } from './yourCost'
import type { ExpenseWithDetails } from '../queries/useExpenses'

const ME = 'me'
const OTHERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const PEOPLE = [ME, ...OTHERS] // 9
const TRIP = {
  start_date: '2027-03-01',
  end_date: '2027-03-09',
  status: 'booking_details' as const,
  base_currency: 'GBP',
  estimated_accommodation_cost: null as number | null,
  accommodation_cost_currency: 'GBP',
}
const NOW = '2027-01-10'
const HC = { count: 9, isEstimate: false }

function opt(o: Partial<CostOptionInput> & { id: string; title: string }): CostOptionInput {
  return { price: null, currency: 'GBP', price_type: 'per_person_fixed', status: 'available', metadata: null, order_index: 0, selections: [], ...o }
}
function sec(s: Partial<Omit<CostSectionInput, 'options'>> & { id: string; title: string; options: ReadonlyArray<CostOptionInput> }): CostSectionInput {
  return { section_type: 'activities', status: 'in_progress', metadata: null, voting_method: 'single', ...s }
}
function run(over: Partial<YourCostInput> & Pick<YourCostInput, 'sections'>) {
  return buildYourCost({ trip: TRIP, userId: ME, headcount: HC, participantUserIds: PEOPLE, now: NOW, ...over })
}
function expense(over: Partial<Omit<ExpenseWithDetails, 'splits'>> & { id: string; amount: number; paid_by: string; splits: Array<{ user_id: string; amount: number }> }): ExpenseWithDetails {
  return {
    trip_id: 't',
    description: 'x',
    currency: 'GBP',
    fx_rate: null,
    ai_parsed: false,
    status: null,
    option_id: null,
    booking_id: null,
    line_items: [],
    claims: [],
    payment_date: '2027-01-01',
    ...over,
  } as unknown as ExpenseWithDetails
}

describe('readCostScope', () => {
  it('uses metadata first, then the legacy section_type default', () => {
    expect(readCostScope({ section_type: 'activities', metadata: { cost_scope: 'everyone' } })).toBe('everyone')
    expect(readCostScope({ section_type: 'accommodation', metadata: { cost_scope: 'opt_in' } })).toBe('opt_in')
    for (const t of ['accommodation', 'flights', 'transport', 'insurance']) expect(readCostScope({ section_type: t })).toBe('everyone')
    for (const t of ['activities', 'equipment', 'lessons']) expect(readCostScope({ section_type: t })).toBe('opt_in')
  })
})

describe('event cost metadata', () => {
  it('reads and writes the shape, keeping other keys', () => {
    expect(readEventCost({ cost: { amount: 40, currency: 'eur', basis: 'each' } })).toEqual({ amount: 40, currency: 'EUR', basis: 'each' })
    expect(readEventCost({ cost: { amount: '40', currency: 'EUR', basis: 'total_split' } })).toEqual({ amount: 40, currency: 'EUR', basis: 'total_split' })
    expect(readEventCost({ cost: { amount: 0, currency: 'EUR' } })).toBeNull()
    expect(readEventCost(null)).toBeNull()
    const written = withEventCost({ travel_details: true }, { amount: 40, currency: 'EUR', basis: 'each' })
    expect(written).toEqual({ travel_details: true, cost: { amount: 40, currency: 'EUR', basis: 'each' } })
    expect(withEventCost(written, null)).toEqual({ travel_details: true })
  })
})

describe('the mixed trip (shared range, opt-in, own picks, event, JPY)', () => {
  const sections = [
    sec({
      id: 'stay',
      title: 'Accommodation',
      section_type: 'accommodation',
      options: [
        opt({ id: 'stay-a', title: 'Chalet A', price: 1800, price_type: 'total_split' }),
        opt({ id: 'stay-b', title: 'Chalet B', price: 2700, price_type: 'total_split' }),
      ],
    }),
    sec({
      id: 'transfer',
      title: 'Getting there',
      section_type: 'transport',
      options: [opt({ id: 'bus', title: 'Shuttle', price: 60 }), opt({ id: 'taxi', title: 'Taxi', price: 140 })],
    }),
    sec({
      id: 'hike',
      title: 'Stromboli hike',
      options: [opt({ id: 'hike-yes', title: 'Hike', price: 30 })],
    }),
    sec({ id: 'cooking', title: 'Cooking class', options: [opt({ id: 'cook', title: 'Class', price: 50 })] }),
    sec({
      id: 'ski',
      title: 'Ski rental',
      metadata: { decision_shape: 'personal' },
      options: [
        opt({
          id: 'skis',
          title: 'Skis',
          metadata: { pricing: { per_day: 10 } },
          selections: [{ user_id: ME, metadata: { start_date: '2027-03-02', end_date: '2027-03-06' } }, { user_id: 'a', metadata: {} }],
        }),
      ],
    }),
    sec({
      id: 'teamlab',
      title: 'teamLab',
      status: 'completed',
      metadata: { decided_option_id: 'lab', cost_scope: 'everyone' },
      options: [opt({ id: 'lab', title: 'teamLab', price: 5000, currency: 'JPY' })],
    }),
  ]
  const votes = [{ option_id: 'hike-yes', user_id: ME }]
  const events = [{ id: 'gala', title: 'Gala dinner', metadata: { cost: { amount: 40, currency: 'EUR', basis: 'each' } }, participant_ids: [ME, 'a'] }]
  const fxRates = { EUR: 0.85, JPY: 0.0052 }
  const model = run({ sections, votes, events, fxRates })
  const byId = Object.fromEntries(model.lines.map((l) => [l.id, l]))

  it('shared open question is a min-max range', () => {
    expect(byId['q:stay']).toMatchObject({ low: 200, high: 300, isRange: true, certainty: 'est', note: 'open: 2 options', optionCount: 2, kind: 'question' })
    expect(byId['q:transfer']).toMatchObject({ low: 60, high: 140, isRange: true })
  })
  it('an opt-in activity counts only if you chose it', () => {
    expect(byId['q:hike']).toMatchObject({ low: 30, high: 30, isRange: false, note: 'your pick' })
    expect(byId['q:cooking']).toBeUndefined()
    expect(model.optionalNotChosen).toBe(1)
  })
  it('own choice: your picks incl. dates (5 days x 10), not other people\'s', () => {
    expect(byId['picks:ski:GBP']).toMatchObject({ low: 50, high: 50, kind: 'own_picks', note: 'your picks' })
  })
  it('event cost is converted and marked approximate', () => {
    expect(byId['event:gala']).toMatchObject({ low: 34, high: 34, converted: true, approx: true, note: "you're in", deepLink: { type: 'event', eventId: 'gala' } })
    expect(byId['event:gala'].native).toEqual({ low: 40, high: 40, currency: 'EUR' })
  })
  it('a JPY winner on a GBP trip converts with the supplied rate', () => {
    expect(byId['q:teamlab']).toMatchObject({ low: 26, high: 26, converted: true, certainty: 'decided', qualifier: 'decided' })
    expect(byId['q:teamlab'].native).toEqual({ low: 5000, high: 5000, currency: 'JPY' })
  })
  it('totals sum the lines', () => {
    expect(model.totals).toMatchObject({ low: 400, high: 580, isRange: true, approx: true, certainty: 'est' })
    expect(model.totals.text).toBe('≈£400 – £580')
    expect(yourCostHeadline(model)).toBe('≈£400 – £580')
    expect(model.mode).toBe('estimate')
    expect(model.title).toBe('Your cost for this trip')
    expect(model.notIncluded).toContain('flights you book yourself')
  })
  it('deep links carry the source id', () => {
    expect(byId['q:stay'].deepLink).toEqual({ type: 'question', sectionId: 'stay', optionId: null })
    expect(byId['q:hike'].deepLink).toEqual({ type: 'question', sectionId: 'hike', optionId: 'hike-yes' })
  })
  it('a currency with no rate is left out of the totals and reported', () => {
    const noRates = run({ sections, votes, events, fxRates: { EUR: 0.85 } })
    expect(noRates.missingRates).toEqual(['JPY'])
    expect(noRates.lines.find((l) => l.id === 'q:teamlab')).toMatchObject({ low: null, high: null })
    expect(noRates.totals.low).toBe(374)
  })
  it('an event you are not in does not count', () => {
    const m = run({ sections: [], events: [{ ...events[0], participant_ids: ['a', 'b'] }], fxRates })
    expect(m.isEmpty).toBe(true)
  })
})

describe('decided, booked, paid', () => {
  const stay = (over: Partial<Omit<CostSectionInput, 'options'>> = {}) =>
    sec({
      id: 'stay',
      title: 'Accommodation',
      section_type: 'accommodation',
      status: 'completed',
      metadata: { decided_option_id: 'a' },
      options: [opt({ id: 'a', title: 'Airbnb', price: 250, price_type: 'total_split', metadata: { price_basis: 'per_night' } }), opt({ id: 'b', title: 'Hotel', price: 3000, price_type: 'total_split' })],
      ...over,
    })

  it('decided counts the winner only: per-night x trip nights / headcount', () => {
    const m = run({ sections: [stay()] })
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ low: 222.22, high: 222.22, certainty: 'decided', qualifier: 'decided', basisLine: '£250/night · 8 nights · £2,000 total · 9 going · decided' })
  })
  it('a live booking replaces it with booking amount / headcount', () => {
    const m = run({ sections: [stay()], bookings: [{ option_id: 'a', amount: 1989.6, currency: 'GBP', status: 'paid' }] })
    expect(m.lines[0]).toMatchObject({ low: 221.07, certainty: 'booked', qualifier: 'booked' })
  })
  it('a matched real expense turns it to paid at YOUR split and sets "already spent"', () => {
    const e = expense({
      id: 'e1',
      amount: 1989.6,
      paid_by: 'a',
      option_id: 'a',
      splits: PEOPLE.map((u) => ({ user_id: u, amount: 221.07 })).map((s, i) => (i === 0 ? { ...s, amount: 221.07 } : s)),
    })
    // The booking says the real total (£1,989.60), so the expense covers it: paid.
    const m = run({ sections: [stay()], bookings: [{ option_id: 'a', amount: 1989.6, status: 'paid' }], expenses: [e] })
    expect(m.lines[0]).toMatchObject({ low: 221.07, high: 221.07, certainty: 'paid', qualifier: 'paid' })
    expect(m.alreadySpent).toBe(221.07)
    expect(m.mode).toBe('estimate')
  })
  it('an expense linked through a booking counts too', () => {
    const e = expense({ id: 'e1', amount: 900, paid_by: 'a', splits: PEOPLE.map((u) => ({ user_id: u, amount: 100 })) })
    const m = run({ sections: [stay()], bookings: [{ option_id: 'a', amount: 900, expense_id: 'e1', status: 'paid' }], expenses: [e] })
    expect(m.lines[0]).toMatchObject({ low: 100, certainty: 'paid' })
  })
  it('a closed question with no winner counts nothing', () => {
    const m = run({ sections: [stay({ metadata: null })] })
    expect(m.lines).toHaveLength(0)
  })
  it('an expense in another currency uses its stored rate (via computeBalances)', () => {
    const e = expense({ id: 'e2', amount: 90000, currency: 'JPY', fx_rate: 0.0052, paid_by: 'a', splits: PEOPLE.map((u) => ({ user_id: u, amount: 10000 })) })
    const m = run({ sections: [], expenses: [e] })
    expect(m.alreadySpent).toBe(52)
  })
})

describe('organiser rough estimate', () => {
  const rough = { ...TRIP, estimated_accommodation_cost: 800 }
  it('is used when accommodation has no price, and named', () => {
    const m = run({ trip: rough, sections: [], organizerName: 'Tim' })
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ kind: 'estimate', low: 800, high: 800, certainty: 'est', qualifier: 'rough_estimate', label: 'Rough estimate from Tim', deepLink: { type: 'trip_settings' } })
  })
  it('stops counting once an accommodation question has a priced option', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 1800, price_type: 'total_split' })] })
    const m = run({ trip: rough, sections: [stay] })
    expect(m.lines.map((l) => l.kind)).toEqual(['question'])
    expect(m.totals.low).toBe(200)
  })
  it('an unpriced accommodation question does not replace it', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A' })] })
    expect(run({ trip: rough, sections: [stay] }).totals.low).toBe(800)
  })
})

describe('finished trip becomes "Your share"', () => {
  it('headline is the real share, the estimate stays underneath', () => {
    const e = expense({ id: 'e1', amount: 900, paid_by: 'a', splits: PEOPLE.map((u) => ({ user_id: u, amount: 100 })) })
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 1800, price_type: 'total_split' })] })
    const m = run({ sections: [stay], expenses: [e], now: '2027-04-01' })
    expect(m.mode).toBe('share')
    expect(m.title).toBe('Your share')
    expect(m.share).toBe(100)
    expect(m.estimateForComparison?.low).toBe(200)
    expect(yourCostHeadline(m)).toBe('£100.00')
    expect(m.isEmpty).toBe(false)
  })
  it('without expenses a finished trip stays an estimate', () => {
    expect(run({ sections: [], now: '2027-04-01' }).mode).toBe('estimate')
  })
})

describe('estimate flags', () => {
  it('a guessed headcount marks divided lines approximate even when decided', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', status: 'completed', metadata: { decided_option_id: 'a' }, options: [opt({ id: 'a', title: 'A', price: 1800, price_type: 'total_split' })] })
    const m = run({ sections: [stay], headcount: { count: 9, isEstimate: true } })
    expect(m.lines[0].approx).toBe(true)
    expect(m.lines[0].dividedByHeadcount).toBe(true)
    expect(m.totals.text).toBe('≈£200')
  })
  it('all-certain, same-currency, per-person lines print exact', () => {
    const s = sec({ id: 'x', title: 'X', status: 'completed', metadata: { decided_option_id: 'a', cost_scope: 'everyone' }, options: [opt({ id: 'a', title: 'A', price: 40 })] })
    const m = run({ sections: [s] })
    expect(m.totals.approx).toBe(false)
    expect(m.totals.text).toBe('£40')
  })
  it('signed-out viewers get shared-cost lines only', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 100 })] })
    const hike = sec({ id: 'hike', title: 'Hike', options: [opt({ id: 'h', title: 'H', price: 30 })] })
    const m = run({ userId: null, sections: [stay, hike] })
    expect(m.lines.map((l) => l.id)).toEqual(['q:stay'])
  })
})

// ---------------------------------------------------------------------------
// Phase 3 review regressions (each is a reviewer reproduction)
// ---------------------------------------------------------------------------

describe('B1: the legacy status "booked" flag is booked certainty', () => {
  it('an open question whose option has status booked is a booked line, never est.', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'Villa', price: 1800, price_type: 'total_split', status: 'booked' }), opt({ id: 'b', title: 'Hotel', price: 2700, price_type: 'total_split' })] })
    const m = run({ sections: [s] })
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ low: 200, high: 200, certainty: 'booked', qualifier: 'booked', isRange: false })
    expect(m.lines[0].basisLine).toMatch(/booked$/)
    expect(m.lines[0].basisLine).not.toMatch(/est\./)
  })
})

describe('C1: several booked options in one question all count (Japan accommodation)', () => {
  it('Osaka £628.56 + Tokyo £1,989.60 for 9 people', () => {
    const s = sec({
      id: 'stay',
      title: 'Accommodation',
      section_type: 'accommodation',
      options: [
        opt({ id: 'osaka', title: 'Osaka', price: 628.56, price_type: 'total_split', status: 'booked' }),
        opt({ id: 'tokyo', title: 'Tokyo', price: 1989.6, price_type: 'total_split', status: 'booked' }),
      ],
    })
    const m = run({ sections: [s] })
    expect(m.lines.map((l) => l.low)).toEqual([69.84, 221.07])
    expect(m.totals.low).toBe(290.91)
    expect(m.lines.every((l) => l.certainty === 'booked')).toBe(true)
  })
  it('live bookings behave the same as the status flag', () => {
    const s = sec({ id: 'stay', title: 'Accommodation', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 1, price_type: 'total_split' }), opt({ id: 'b', title: 'B', price: 1, price_type: 'total_split' })] })
    const m = run({ sections: [s], bookings: [{ option_id: 'a', amount: 900, status: 'paid' }, { option_id: 'b', amount: 1800, status: 'reserved' }] })
    expect(m.totals.low).toBe(300)
  })
})

describe('C2: a decided opt-in question counts only for people who chose it', () => {
  const boat = (voters: string[]) => ({
    section: sec({ id: 'boat', title: 'Boat trip', status: 'completed', metadata: { decided_option_id: 'b', cost_scope: 'opt_in' }, options: [opt({ id: 'b', title: 'Boat', price: 80 })] }),
    votes: voters.map((u) => ({ option_id: 'b', user_id: u })),
  })
  it('did not answer: not charged, counted as optional', () => {
    const { section, votes } = boat(['a'])
    const m = run({ sections: [section], votes })
    expect(m.lines).toHaveLength(0)
    expect(m.optionalNotChosen).toBe(1)
    expect(m.totals.low).toBe(0)
  })
  it('answered: charged', () => {
    const { section, votes } = boat([ME])
    expect(run({ sections: [section], votes }).totals.low).toBe(80)
  })
})

describe('C3: expenses only reconcile the winner / a booked option', () => {
  const villa = () =>
    sec({
      id: 'stay',
      title: 'Accommodation',
      section_type: 'accommodation',
      status: 'completed',
      metadata: { decided_option_id: 'villa' },
      options: [opt({ id: 'villa', title: 'Villa', price: 9000, price_type: 'total_split' }), opt({ id: 'other', title: 'Other', price: 5000, price_type: 'total_split' })],
    })
  const exp = (id: string, amount: number, over: Record<string, unknown> = {}) =>
    expense({ id, amount, paid_by: 'a', splits: PEOPLE.map((u) => ({ user_id: u, amount: amount / 9 })), ...over })

  it('a deposit linked to the losing option never rewrites the line', () => {
    const m = run({ sections: [villa()], expenses: [exp('d', 900, { option_id: 'other' })] })
    expect(m.lines[0]).toMatchObject({ low: 1000, certainty: 'decided', qualifier: 'decided' })
  })
  it('a deposit on the winner shows "£X paid of ≈£Y" and keeps the estimate', () => {
    const m = run({ sections: [villa()], expenses: [exp('d', 900, { option_id: 'villa' })] })
    expect(m.lines[0]).toMatchObject({ low: 1000, certainty: 'decided' })
    expect(m.lines[0].note).toBe('£100.00 paid of ≈£1,000')
    expect(m.alreadySpent).toBe(100)
  })
  it('once the expenses cover the total the line is paid at your split', () => {
    const m = run({ sections: [villa()], expenses: [exp('full', 9000, { option_id: 'villa' })] })
    expect(m.lines[0]).toMatchObject({ low: 1000, certainty: 'paid', qualifier: 'paid' })
  })
  it('matches an expense by booking id', () => {
    const m = run({ sections: [villa()], bookings: [{ id: 'bk1', option_id: 'villa', amount: 9000, status: 'paid' }], expenses: [exp('full', 9000, { booking_id: 'bk1' })] })
    expect(m.lines[0]).toMatchObject({ certainty: 'paid', low: 1000 })
  })
  it('an expense on one of two booked stays does not hide the other', () => {
    const s = sec({ id: 'stay', title: 'Accommodation', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 900, price_type: 'total_split', status: 'booked' }), opt({ id: 'b', title: 'B', price: 1800, price_type: 'total_split', status: 'booked' })] })
    const m = run({ sections: [s], expenses: [exp('full-a', 900, { option_id: 'a' })] })
    expect(m.lines).toHaveLength(2)
    expect(m.lines.map((l) => l.low)).toEqual([100, 200])
    expect(m.lines[0].certainty).toBe('paid')
    expect(m.lines[1].certainty).toBe('booked')
  })
})

describe('B2: bad data degrades a line, never the card', () => {
  it('malformed price tiers do not throw and the row is skipped', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 900, price_type: 'total_split', metadata: { price_tiers: [{ max_people: 12 }, { max_people: 'x', total: 5 }, null, { max_people: 12, total: '1800' }] } })] })
    const m = run({ sections: [s] })
    expect(m.failedLines).toEqual([])
    expect(m.lines[0].low).toBe(200)
  })
  it('an unexpected error in one section is "not included" with a warning; the others still count', () => {
    const bad = sec({ id: 'bad', title: 'Broken', options: [] }) as CostSectionInput
    Object.defineProperty(bad, 'options', { get() { throw new Error('boom') } })
    const good = sec({ id: 'ok', title: 'Fine', section_type: 'transport', options: [opt({ id: 'x', title: 'X', price: 60 })] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = run({ sections: [bad, good] })
    warn.mockRestore()
    expect(m.failedLines).toEqual(['Broken'])
    expect(m.lines.map((l) => l.id)).toEqual(['q:ok'])
    expect(m.totals.low).toBe(60)
  })
})

describe('C4: booked / booked-by-expense accommodation replaces the rough estimate', () => {
  const rough = { ...TRIP, estimated_accommodation_cost: 800 }
  it('a status-booked unpriced option', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', status: 'booked' })] })
    expect(run({ trip: rough, sections: [s] }).lines.some((l) => l.kind === 'estimate')).toBe(false)
  })
  it('a live booking with no listed price: counted once, not on top of the guess', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A' })] })
    const m = run({ trip: rough, sections: [s], bookings: [{ option_id: 'a', amount: 7200, status: 'paid' }] })
    expect(m.lines.map((l) => l.kind)).toEqual(['question'])
    expect(m.totals.low).toBe(800) // £7,200 / 9, not £800 + £800
  })
  it('a linked expense', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A' })] })
    const e = expense({ id: 'e', amount: 900, paid_by: 'a', option_id: 'a', splits: PEOPLE.map((u) => ({ user_id: u, amount: 100 })) })
    expect(run({ trip: rough, sections: [s], expenses: [e] }).lines.some((l) => l.kind === 'estimate')).toBe(false)
  })
})

describe('C5: an open opt-in total divides by the people who opted in', () => {
  it('£600 boat hire, 4 of 9 opted in -> £150', () => {
    const s = sec({ id: 'boat', title: 'Boat hire', options: [opt({ id: 'b', title: 'Boat', price: 600, price_type: 'total_split' })] })
    const votes = [ME, 'a', 'b', 'c'].map((u) => ({ option_id: 'b', user_id: u }))
    const m = run({ sections: [s], votes })
    expect(m.lines[0]).toMatchObject({ low: 150, high: 150 })
    expect(m.lines[0].basisLine).toBe('£600 total · 4 in · est.')
  })
})

describe('C6: "Your share" needs you to be in an expense', () => {
  it('finished trip, nobody logged anything: estimate with an honest note', () => {
    const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 9000, price_type: 'total_split' })] })
    const m = run({ sections: [s], expenses: [], now: '2027-04-01' })
    expect(m.mode).toBe('estimate')
    expect(m.share).toBeNull()
    expect(m.note).toMatch(/No expenses were logged/)
  })
  it('finished trip, expenses exist but not for you', () => {
    const e = expense({ id: 'e', amount: 100, paid_by: 'a', splits: [{ user_id: 'a', amount: 50 }, { user_id: 'b', amount: 50 }], participant_ids: ['a', 'b'] })
    const m = run({ sections: [], expenses: [e], now: '2027-04-01' })
    expect(m.mode).toBe('estimate')
    expect(m.note).toMatch(/not on any logged expense/)
  })
})

describe('C7: a range never mixes currencies', () => {
  const s = sec({ id: 'x', title: 'Transfer', section_type: 'transport', options: [opt({ id: 'a', title: 'A', price: 300, currency: 'EUR' }), opt({ id: 'b', title: 'B', price: 40000, currency: 'JPY' })] })
  it('with rates: converted to the trip currency', () => {
    const m = run({ sections: [s], fxRates: { EUR: 0.85, JPY: 0.0052 } })
    expect(m.lines[0]).toMatchObject({ low: 208, high: 255, converted: true, approx: true })
    expect(m.lines[0].nativeByCurrency).toEqual([{ currency: 'EUR', low: 300, high: 300 }, { currency: 'JPY', low: 40000, high: 40000 }])
    expect(m.lines[0].native).toEqual({ low: 300, high: 300, currency: 'EUR' })
  })
  it('without rates: each currency stays separate, nothing is summed', () => {
    const m = run({ sections: [s] })
    expect(m.lines[0].low).toBeNull()
    expect(m.lines[0].nativeByCurrency).toHaveLength(2)
    expect(m.totals.low).toBe(0)
  })
  it('one currency missing a rate: the rest still count and the line is partly priced', () => {
    const m = run({ sections: [s], fxRates: { EUR: 0.85 } })
    expect(m.lines[0]).toMatchObject({ low: 255, high: 255, partial: true })
    expect(m.missingRates).toEqual(['JPY'])
  })
})

describe('C8: own-choice per-day picks with no dates cover the trip days', () => {
  it('ski rental £12/day, empty selection metadata, 9-day trip -> £108, said in the basis line', () => {
    const s = sec({ id: 'ski', title: 'Ski rental', metadata: { decision_shape: 'personal' }, options: [opt({ id: 'skis', title: 'Skis', metadata: { pricing: { per_day: 12 } }, selections: [{ user_id: ME, metadata: {} }] })] })
    const m = run({ sections: [s] })
    expect(m.lines[0]).toMatchObject({ low: 108, high: 108, approx: true })
    expect(m.lines[0].basisLine).toBe('× 9 days (no dates picked yet)')
  })
  it('a pick with its own dates is untouched, flat pricing is untouched', () => {
    const s = sec({
      id: 'ski',
      title: 'Ski rental',
      metadata: { decision_shape: 'personal' },
      options: [opt({ id: 'skis', title: 'Skis', metadata: { pricing: { per_day: 12 } }, selections: [{ user_id: ME, metadata: { start_date: '2027-03-02', end_date: '2027-03-03' } }] }), opt({ id: 'pass', title: 'Pass', metadata: { pricing: { flat: 30 } }, selections: [{ user_id: ME, metadata: {} }] })],
    })
    const m = run({ sections: [s] })
    expect(m.lines[0]).toMatchObject({ low: 54, basisLine: null })
  })
})

describe('C9: an event cost has one per-person figure on Today and Plan', () => {
  const metadata = { cost: { amount: 300, currency: 'GBP', basis: 'total_split' } }
  it('£300 for 3 of 9 attendees is £100 in both places', () => {
    const attendees = [ME, 'a', 'b']
    const plan = computeEventPrice({ metadata, participant_ids: attendees }, TRIP, HC)!
    const today = run({ sections: [], events: [{ id: 'ev', title: 'Dinner', metadata, participant_ids: attendees }] })
    expect(plan.perPerson).toBe(100)
    expect(today.lines[0].low).toBe(100)
    expect(plan.basisLine).toBe('£300 total · 3 in · decided')
  })
  it('no attendees: the in-scope headcount', () => {
    const plan = computeEventPrice({ metadata, participant_ids: null }, TRIP, HC)!
    expect(plan.perPerson).toBe(33.33)
    expect(run({ sections: [], events: [{ id: 'ev', title: 'Dinner', metadata }] }).lines[0].low).toBe(33.33)
  })
})

describe('headcount noun follows the in-scope rule', () => {
  const s = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 1800, price_type: 'total_split' })] })
  it('tracking off: everyone active is "going"', () => {
    const m = run({ sections: [s], headcount: { count: 9, isEstimate: true }, confirmationEnabled: false })
    expect(m.headcountNoun).toBe('going')
    expect(m.lines[0].basisLine).toBe('£1,800 total · 9 going · est.')
  })
  it('tracking on and nobody confirmed: "invited"', () => {
    const m = run({ sections: [s], headcount: { count: 9, isEstimate: true }, confirmationEnabled: true })
    expect(m.headcountNoun).toBe('invited')
    expect(m.lines[0].basisLine).toBe('£1,800 total · 9 invited · est.')
  })
})
