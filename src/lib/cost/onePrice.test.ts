import { describe, it, expect } from 'vitest'
import { computeOptionPrice } from './optionPrice'
import { actualFromExpenses, buildYourCost, matchOptionExpenses, type CostSectionInput } from './yourCost'
import { buildYourCostView, showEstimateComparison } from '../../features/today/lib/yourCostView'
import { buildRsvpCostLine, formatRoughEstimate } from '../../features/people/lib/roughCost'
import type { ExpenseWithDetails } from '../queries/useExpenses'

const ME = 'tim'
const FIVE = ['a', 'b', 'c', 'd', 'e']
const NINE = ['tim', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

function expense(id: string, amount: number, paid_by: string, splitUsers: string[], over: Record<string, unknown> = {}): ExpenseWithDetails {
  const each = Math.round((amount / splitUsers.length) * 100) / 100
  return {
    id, trip_id: 't', description: id, amount, currency: 'GBP', fx_rate: null, paid_by, ai_parsed: false, status: null,
    option_id: null, booking_id: null, line_items: [], claims: [], payment_date: '2026-08-01',
    splits: splitUsers.map((u) => ({ user_id: u, amount: each })), ...over,
  } as unknown as ExpenseWithDetails
}

// Tokyo Airbnb: listed £248.70 total_split, real expense £1,989.60 split between 5 (a-e), Tim not on it.
const tokyoOption = { price: 248.7, currency: 'GBP', price_type: 'total_split', metadata: {} }
const tokyoExpense = expense('e1', 1989.6, 'a', FIVE, { option_id: 'tokyo' })
const TRIP = { start_date: '2026-08-17', end_date: '2026-08-30' }

describe('item 1: one price per item (actual replaces listed)', () => {
  it('someone ON the expense sees their own share, with the listed estimate quiet', () => {
    const actual = actualFromExpenses([tokyoExpense], NINE, 'GBP', 'a')!
    expect(actual.splitCount).toBe(5)
    const p = computeOptionPrice(tokyoOption, TRIP, { count: 9, isEstimate: false }, { actual })!
    expect(p.headline).toBe('£397.92 — your share')
    expect(p.basisLine).toBe('£1,989.60 total · split between 5 · paid')
    expect(p.basisLine).not.toContain('9 going')
  })

  it('someone NOT on the expense sees the total and how it was split, never divided by 9', () => {
    const actual = actualFromExpenses([tokyoExpense], NINE, 'GBP', ME)!
    expect(actual.viewerShare).toBeNull()
    const p = computeOptionPrice(tokyoOption, TRIP, { count: 9, isEstimate: false }, { actual })!
    expect(p.headline).toBe('£1,989.60 total · split between 5 · paid')
    expect(p.basisLine).toBe('')
    expect(p.headline).not.toContain('221.07')
  })

  it('matches by booking.expense_id too, and no expense keeps the listed price', () => {
    const e = expense('e2', 471.47, 'a', FIVE)
    expect(matchOptionExpenses('osaka', [{ id: 'b1', option_id: 'osaka', amount: 78.58, status: 'paid', expense_id: 'e2' }], [e])).toHaveLength(1)
    const p = computeOptionPrice({ ...tokyoOption, price: 78.58 }, TRIP, { count: 9, isEstimate: false }, { actual: null })!
    expect(p.headline).toBe('≈£8.73 each')
  })
})

const stay = (status = 'in_progress'): CostSectionInput => ({
  id: 's1', title: 'Tokyo Airbnb', section_type: 'accommodation', status, metadata: null, voting_method: 'single',
  options: [{ id: 'tokyo', title: 'Tokyo Airbnb', ...tokyoOption, status: 'booked', metadata: null, order_index: 0, selections: [] }],
})
const open = (): CostSectionInput => ({
  id: 's2', title: 'Dinner', section_type: 'accommodation', status: 'in_progress', metadata: null, voting_method: 'single',
  options: [{ id: 'din', title: 'Dinner', price: 90, currency: 'GBP', price_type: 'total_split', status: 'available', metadata: null, order_index: 0, selections: [] }],
})
const base = { headcount: { count: 9, isEstimate: false }, participantUserIds: NINE, now: '2026-11-16' }
const FINISHED = { start_date: '2026-08-17', end_date: '2026-08-30', status: 'trip_completed' as const, base_currency: 'GBP' }

describe('item 2: Your cost when the viewer is not on the expense', () => {
  it('finished trip: "Not shared with you", no £0 paid, open questions contribute nothing, plain empty state', () => {
    const model = buildYourCost({ ...base, trip: FINISHED, userId: ME, sections: [stay(), open()], expenses: [tokyoExpense], bookings: [{ id: 'b', option_id: 'tokyo', amount: 248.7, status: 'paid' }] })
    const view = buildYourCostView(model)
    expect(model.totals.low).toBe(0)
    expect(model.emptyReason).toBe('no_costs')
    expect(view.headline).toBeNull()
    expect(view.empty?.title).toBe('You have no costs recorded on this trip.')
    // Not-shared items are a separate quiet line, never rows.
    expect(view.rows.some((r) => r.label === 'Tokyo Airbnb')).toBe(false)
    expect(view.notSharedNote).toBe("1 cost wasn't shared with you")
    expect(view.rows.some((r) => r.label === 'Dinner')).toBe(false)
  })

  it('someone on the expense still gets their share line', () => {
    const model = buildYourCost({ ...base, trip: FINISHED, userId: 'a', sections: [stay()], expenses: [tokyoExpense] })
    expect(model.mode).toBe('share')
    expect(model.share).toBe(397.92)
  })

  it('finished trip: the share is explained by the expenses that make it up', () => {
    const model = buildYourCost({ ...base, trip: FINISHED, userId: 'a', sections: [stay()], expenses: [tokyoExpense] })
    const view = buildYourCostView(model)
    expect(view.toggleLabel).toEqual({ show: "Show what's in it", hide: 'Hide details' })
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].amount).toBe('your share £397.92')
    expect(view.moreExpenses).toBeNull()
    expect(model.expenseShares.reduce((a, e) => a + e.share, 0)).toBeCloseTo(model.share!, 2)
  })

  it('a viewer who is not going is told so', () => {
    const model = buildYourCost({ ...base, trip: FINISHED, userId: ME, viewerInScope: false, sections: [open()], expenses: [] })
    expect(buildYourCostView(model).empty?.title).toBe("You're not going on this trip")
  })
})

describe('item 3: pre-trip estimate comparison', () => {
  it('only when the estimate covered at least half the share', () => {
    expect(showEstimateComparison(26, 5719.28)).toBe(false)
    expect(showEstimateComparison(3000, 5719.28)).toBe(true)
    expect(showEstimateComparison(2859.64, 5719.28)).toBe(true)
  })
  it('and only when it is not wildly above it either (Meribel: £1,456.60 share vs ≈£7,960)', () => {
    expect(showEstimateComparison(7960, 1456.6)).toBe(false)
    expect(showEstimateComparison(1456.6 * 2, 1456.6)).toBe(true)
    expect(showEstimateComparison(1800, 1456.6)).toBe(true)
    // a range counts when it overlaps the believable band
    expect(showEstimateComparison(7960, 1456.6, 1200)).toBe(true)
    expect(showEstimateComparison(7960, 1456.6, 3200)).toBe(false)
  })
  it('the view leaves the line out silently when the estimate is far off', () => {
    const model = {
      mode: 'share', title: 'Your share', currency: 'GBP', headcount: 11, headcountIsEstimate: false,
      lines: [{ id: 'q', kind: 'question', label: 'Chalet', low: 7960, high: 7960, native: { low: 7960, high: 7960, currency: 'GBP' }, nativeByCurrency: [], notShared: false, deepLink: { type: 'trip_settings' }, certainty: 'decided', qualifier: 'decided', note: 'decided', basisLine: null, approx: false, dividedByHeadcount: false }],
      totals: { low: 7960, high: 7960, isRange: false, approx: true, certainty: 'decided', text: '≈£7,960' },
      alreadySpent: 1456.6, share: 1456.6, estimateForComparison: { low: 7960, high: 7960, isRange: false, approx: true, certainty: 'decided', text: '≈£7,960' },
      notIncluded: [], optionalNotChosen: 0, missingRates: [], expensesMissingRate: [], expenseShares: [], failedLines: [], headcountNoun: 'going', note: null, emptyReason: null, isEmpty: false,
    } as unknown as Parameters<typeof buildYourCostView>[0]
    expect(buildYourCostView(model).comparison).toBeNull()
    const sane = { ...model, estimateForComparison: { ...model.estimateForComparison!, low: 1500, high: 1500, text: '≈£1,500' } }
    expect(buildYourCostView(sane).comparison).toBe('Estimated before the trip: ≈£1,500')
  })
})

describe('item 5: rough estimate wording', () => {
  it('entered figure first, converted second, no pence', () => {
    expect(formatRoughEstimate(246795, 'JPY', 'GBP', 1139.19)).toBe('≈¥246,795 each (about £1,139)')
    expect(formatRoughEstimate(246795, 'JPY', 'GBP', null)).toBe('≈¥246,795 each')
    expect(formatRoughEstimate(800, 'GBP', 'GBP', 800)).toBe('≈£800 each')
  })
  it('the RSVP step reads identically', () => {
    const line = buildRsvpCostLine({ estimated_accommodation_cost: 246795, accommodation_cost_currency: 'JPY' }, null, { baseCurrency: 'GBP', convertedBase: 1139.19 })!
    expect(line.figure).toBe('≈¥246,795 each (about £1,139)')
  })
  it('Today headline uses the same helper', () => {
    const model = buildYourCost({ ...base, trip: { start_date: '2027-03-01', end_date: '2027-03-09', status: 'booking_details', base_currency: 'GBP', estimated_accommodation_cost: 246795, accommodation_cost_currency: 'JPY' }, userId: ME, sections: [], fxRates: { JPY: 1139.19 / 246795 } })
    expect(buildYourCostView(model).headline).toBe("Organizer's rough estimate: ≈¥246,795 each (about £1,139)")
  })
})
