import { describe, it, expect, vi } from 'vitest'
import { buildYourCost, type CostOptionInput, type CostSectionInput } from '../../../lib/cost/yourCost'
import { buildYourCostView } from './yourCostView'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

const ME = 'me'
const PEOPLE = [ME, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const TRIP = {
  start_date: '2027-03-01',
  end_date: '2027-03-09',
  status: 'booking_details' as const,
  base_currency: 'GBP',
  estimated_accommodation_cost: null as number | null,
  accommodation_cost_currency: 'GBP',
}
const HC = { count: 9, isEstimate: false }
const opt = (o: Partial<CostOptionInput> & { id: string; title: string }): CostOptionInput => ({
  price: null, currency: 'GBP', price_type: 'per_person_fixed', status: 'available', metadata: null, order_index: 0, selections: [], ...o,
})
const sec = (s: Partial<Omit<CostSectionInput, 'options'>> & { id: string; title: string; options: ReadonlyArray<CostOptionInput> }): CostSectionInput => ({
  section_type: 'activities', status: 'in_progress', metadata: null, voting_method: 'single', ...s,
})
const run = (over: Partial<Parameters<typeof buildYourCost>[0]> & Pick<Parameters<typeof buildYourCost>[0], 'sections'>) =>
  buildYourCost({ trip: TRIP, userId: ME, headcount: HC, participantUserIds: PEOPLE, now: '2027-01-10', ...over })

describe('buildYourCostView', () => {
  it('upcoming trip with open shared questions: a range, rows link to the question, split basis', () => {
    const view = buildYourCostView(
      run({
        sections: [
          sec({ id: 'acc', title: 'Where we stay', section_type: 'accommodation', options: [
            opt({ id: 'o1', title: 'Villa', price: 1800, price_type: 'total_split' }),
            opt({ id: 'o2', title: 'Chalet', price: 2700, price_type: 'total_split' }),
          ] }),
        ],
      })
    )
    expect(view.headline).toBe('Your cost so far: ≈£200 – £300')
    expect(view.subline).toMatch(/narrows/)
    expect(view.rows[0]).toMatchObject({ label: 'Where we stay', chip: 'est.', detail: 'open: 2 options', link: '?open=question:acc' })
    expect(view.basis).toBe('Split between 9 going')
    expect(view.notIncluded).toMatch(/flights you book yourself/)
    expect(view.empty).toBeNull()
  })

  it('empty state: no "£1" nonsense', () => {
    const view = buildYourCostView(run({ sections: [] }))
    expect(view.headline).toBeNull()
    expect(view.empty?.title).toBe('Nothing is priced yet')
  })

  it('organiser rough estimate alone is labelled as that', () => {
    const view = buildYourCostView(run({ sections: [], trip: { ...TRIP, estimated_accommodation_cost: 800 } }))
    expect(view.headline).toBe("Organizer's rough estimate: ~£800 each")
    expect(view.rows).toEqual([])
    expect(view.basis).toBeNull()
  })

  it('converted lines are approximate and show their own currency; a missing rate warns', () => {
    const sections = [sec({ id: 'x', title: 'Rail pass', section_type: 'transport', options: [opt({ id: 'o', title: 'Pass', price: 20000, currency: 'JPY' })] })]
    const withRate = buildYourCostView(run({ sections, fxRates: { JPY: 0.005 } }))
    expect(withRate.rows[0].amount).toBe('≈£100')
    expect(withRate.rows[0].detail).toContain('from ¥20,000')
    const noRate = buildYourCostView(run({ sections }))
    expect(noRate.warnings[0]).toMatch(/No exchange rate for JPY/)
    expect(noRate.empty).not.toBeNull()
  })

  it('finished trip: exact share with the estimate faded underneath', () => {
    const expenses = [
      { id: 'e1', trip_id: 't', description: 'Cabin', amount: 900, currency: 'GBP', fx_rate: null, paid_by: 'a', status: null, option_id: null, booking_id: null, line_items: [], claims: [], payment_date: '2027-03-02',
        splits: PEOPLE.map((u) => ({ user_id: u, amount: 100 })) } as unknown as ExpenseWithDetails,
    ]
    const view = buildYourCostView(
      run({
        trip: { ...TRIP, status: 'trip_completed' },
        now: '2027-04-01',
        expenses,
        sections: [sec({ id: 'acc', title: 'Cabin', section_type: 'accommodation', options: [opt({ id: 'o1', title: 'Cabin', price: 1000, price_type: 'total_split' })] })],
      })
    )
    expect(view.mode).toBe('share')
    expect(view.headline).toBe('Your share: £100.00')
    expect(view.comparison).toMatch(/^Estimated before the trip: /)
    expect(view.defaultOpen).toBe(false)
  })

  it('mid-trip: real expenses show as what has been charged so far', () => {
    const expenses = [
      { id: 'e1', trip_id: 't', description: 'Food', amount: 90, currency: 'GBP', fx_rate: null, paid_by: 'a', status: null, option_id: null, booking_id: null, line_items: [], claims: [], payment_date: '2027-03-02',
        splits: PEOPLE.map((u) => ({ user_id: u, amount: 10 })) } as unknown as ExpenseWithDetails,
    ]
    const view = buildYourCostView(
      run({ trip: { ...TRIP, status: 'trip_ongoing' }, now: '2027-03-03', expenses,
        sections: [sec({ id: 'acc', title: 'Cabin', section_type: 'accommodation', options: [opt({ id: 'o1', title: 'Cabin', price: 900, price_type: 'total_split' })] })] })
    )
    expect(view.mode).toBe('estimate')
    expect(view.spent).toBe('Charged to you so far (from expenses): £10.00')
  })
})

describe('review regressions in the view', () => {
  const transfer = sec({ id: 'x', title: 'Transfer', section_type: 'transport', options: [opt({ id: 'a', title: 'A', price: 300, currency: 'EUR' }), opt({ id: 'b', title: 'B', price: 40000, currency: 'JPY' })] })

  it('C7: no rates -> each currency separately, never "€300 – €40,000"', () => {
    const view = buildYourCostView(run({ sections: [transfer] }))
    expect(view.rows[0].amount).toBe('≈€300 · ≈¥40,000')
    expect(view.rows[0].amount).not.toMatch(/€300 – /)
    expect(view.rows[0].detail).toContain('no exchange rate yet')
  })
  it('C7: with rates -> one converted range in the trip currency', () => {
    const view = buildYourCostView(run({ sections: [transfer], fxRates: { EUR: 0.85, JPY: 0.0052 } }))
    expect(view.rows[0].amount).toBe('≈£208 – £255')
  })
  it('C6: a finished trip with no expenses keeps the estimate and says why', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 9000, price_type: 'total_split' })] })
    const view = buildYourCostView(run({ sections: [stay], expenses: [], now: '2027-04-01' }))
    expect(view.mode).toBe('estimate')
    expect(view.headline).toBe('Your cost so far: ≈£1,000')
    expect(view.subline).toMatch(/No expenses were logged/)
  })
  it('C8: the assumed day count is in the picks row', () => {
    const ski = sec({ id: 'ski', title: 'Ski rental', metadata: { decision_shape: 'personal' }, options: [opt({ id: 'skis', title: 'Skis', metadata: { pricing: { per_day: 12 } }, selections: [{ user_id: ME, metadata: {} }] })] })
    const view = buildYourCostView(run({ sections: [ski] }))
    expect(view.rows[0].amount).toBe('≈£108')
    expect(view.rows[0].detail).toBe('your picks · × 9 days (no dates picked yet)')
  })
  it('headcount noun: tracking off says going', () => {
    const stay = sec({ id: 'stay', title: 'Stay', section_type: 'accommodation', options: [opt({ id: 'a', title: 'A', price: 1800, price_type: 'total_split' })] })
    const off = buildYourCostView(run({ sections: [stay], headcount: { count: 9, isEstimate: true }, confirmationEnabled: false }))
    expect(off.basis).toBe('Split between 9 going')
    const on = buildYourCostView(run({ sections: [stay], headcount: { count: 9, isEstimate: true }, confirmationEnabled: true }))
    expect(on.basis).toBe('Split between 9 invited (estimate)')
  })
  it('B2: a section that could not be priced is a warning, not a crash', () => {
    const bad = sec({ id: 'bad', title: 'Broken', options: [] }) as CostSectionInput
    Object.defineProperty(bad, 'options', { get() { throw new Error('boom') } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const view = buildYourCostView(run({ sections: [bad] }))
    warn.mockRestore()
    expect(view.warnings).toContain(`"Broken" couldn't be priced, so it isn't included.`)
  })
})
