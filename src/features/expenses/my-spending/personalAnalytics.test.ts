import { describe, it, expect } from 'vitest'
import { computePersonalOverview, computeCategoryBreakdown, computeDayBreakdown } from './personalAnalytics'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

function makeExpense(overrides: Partial<ExpenseWithDetails> & { id: string }): ExpenseWithDetails {
  return {
    trip_id: 'trip-1',
    description: 'Test',
    amount: 100,
    currency: 'GBP',
    category: 'food',
    paid_by: 'alice',
    payment_date: '2026-08-01',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    base_currency_amount: null,
    fx_rate: null,
    fx_rate_date: null,
    rate_source: null,
    ai_parsed: false,
    ai_parsed_data: null,
    status: null,
    vendor_name: null,
    location: null,
    receipt_url: null,
    receipt_date: null,
    option_id: null,
    place_id: null,
    booking_id: null,
    parsing_error: null,
    participant_ids: null,
    subtotal: null,
    tax_amount: null,
    tax_percent: null,
    tax_lines: null,
    service_charge_amount: null,
    service_charge_percent: null,
    discount_amount: null,
    discount_percent: null,
    rounding_adjustment: null,
    tip_amount: null,
    payer: {} as ExpenseWithDetails['payer'],
    splits: [],
    line_items: [],
    claims: [],
    allocation_link: null,
    expected_participants: [],
    ...overrides,
  } as ExpenseWithDetails
}

function makeSplit(userId: string, amount: number) {
  return {
    id: `split-${userId}-${Math.random()}`,
    expense_id: 'exp',
    user_id: userId,
    amount,
    base_currency_amount: null,
    percentage: null,
    shares: null,
    split_type: 'equal' as const,
    created_at: '2026-08-01T00:00:00Z',
    user: {} as never,
  }
}

describe('computePersonalOverview', () => {
  it('computes total paid, my share, and net balance for a two-person trip', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const stats = computePersonalOverview(expenses, [], ['alice', 'bob'], 'alice', 'GBP', '2026-08-01', '2026-08-03')
    expect(stats.totalPaidMajor).toBe(100)
    expect(stats.myShareMajor).toBe(50)
    expect(stats.netBalanceMajor).toBe(50)
    expect(stats.sharePercentOfTrip).toBe(50)
  })

  it('computes a daily average over the inclusive trip duration', () => {
    const expenses = [makeExpense({ id: 'e1', amount: 90, paid_by: 'alice', splits: [makeSplit('alice', 90)] })]
    // 3-day trip inclusive (01, 02, 03)
    const stats = computePersonalOverview(expenses, [], ['alice'], 'alice', 'GBP', '2026-08-01', '2026-08-03')
    expect(stats.dailyAverageMajor).toBe(30)
  })

  it('surfaces expensesMissingRate without crashing (v1 bug fix carried through)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, currency: 'JPY', fx_rate: null, paid_by: 'alice', splits: [makeSplit('alice', 100)] }),
    ]
    const stats = computePersonalOverview(expenses, [], ['alice'], 'alice', 'GBP', '2026-08-01', '2026-08-01')
    expect(stats.expensesMissingRate).toEqual(['e1'])
    expect(stats.totalPaidMajor).toBe(0)
  })
})

describe('computeCategoryBreakdown', () => {
  it('groups spending by category and computes percent of my total', () => {
    const expenses = [
      makeExpense({ id: 'e1', category: 'food', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', category: 'transport', amount: 40, paid_by: 'alice', splits: [makeSplit('alice', 20), makeSplit('bob', 20)] }),
    ]
    const breakdown = computeCategoryBreakdown(expenses, 'alice', 'GBP')
    const food = breakdown.find((b) => b.category === 'food')!
    const transport = breakdown.find((b) => b.category === 'transport')!
    expect(food.myTotalMajor).toBe(30)
    expect(transport.myTotalMajor).toBe(20)
    expect(food.percentOfMyTotal + transport.percentOfMyTotal).toBeCloseTo(100, 5)
  })

  it('excludes categories with zero spending', () => {
    const expenses = [makeExpense({ id: 'e1', category: 'food', amount: 50, paid_by: 'alice', splits: [makeSplit('alice', 50)] })]
    const breakdown = computeCategoryBreakdown(expenses, 'alice', 'GBP')
    expect(breakdown.every((b) => b.myTotalMajor > 0 || b.tripTotalMajor > 0)).toBe(true)
    expect(breakdown.find((b) => b.category === 'equipment')).toBeUndefined()
  })
})

describe('computeDayBreakdown', () => {
  it('produces one entry per day of the trip, even days with no spending', () => {
    const expenses = [makeExpense({ id: 'e1', amount: 50, payment_date: '2026-08-02', paid_by: 'alice', splits: [makeSplit('alice', 50)] })]
    const days = computeDayBreakdown(expenses, 'alice', 'GBP', '2026-08-01', '2026-08-03')
    expect(days).toHaveLength(3)
    expect(days.find((d) => d.date === '2026-08-01')!.myTotalMajor).toBe(0)
    expect(days.find((d) => d.date === '2026-08-02')!.myTotalMajor).toBe(50)
  })
})
