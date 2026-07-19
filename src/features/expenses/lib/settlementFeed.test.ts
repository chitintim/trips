import { describe, it, expect } from 'vitest'
import {
  applySettlementFilters,
  groupMoneyFeedByDay,
  isFeedSettlement,
  isPendingSettlement,
  settlementFeedDate,
} from './settlementFeed'
import { EMPTY_FILTERS } from '../expenses-tab/ExpenseFilters'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

function makeExpense(overrides: Partial<ExpenseWithDetails> & { id: string; payment_date: string }): ExpenseWithDetails {
  return {
    trip_id: 'trip-1',
    description: 'Test expense',
    amount: 100,
    currency: 'GBP',
    category: 'food',
    paid_by: 'alice',
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

function makeSettlement(overrides: Partial<Settlement> & { id: string }): Settlement {
  return {
    trip_id: 'trip-1',
    from_user_id: 'bob',
    to_user_id: 'alice',
    amount: 50,
    created_by: 'alice',
    currency: 'GBP',
    notes: null,
    payment_method: null,
    settled_at: '2026-07-01T10:00:00Z',
    status: 'confirmed',
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  } as Settlement
}

describe('settlementFeedDate', () => {
  it('uses settled_at (date-only) as the grouping day', () => {
    expect(settlementFeedDate(makeSettlement({ id: 's1', settled_at: '2026-07-01T18:30:00Z' }))).toBe('2026-07-01')
  })

  it('falls back to created_at when settled_at is missing', () => {
    const s = makeSettlement({ id: 's1', created_at: '2026-07-02T09:00:00Z' })
    ;(s as { settled_at: string | null }).settled_at = null
    expect(settlementFeedDate(s)).toBe('2026-07-02')
  })
})

describe('isFeedSettlement / isPendingSettlement', () => {
  it('includes confirmed rows as non-pending payments', () => {
    const s = makeSettlement({ id: 's1', status: 'confirmed' })
    expect(isFeedSettlement(s)).toBe(true)
    expect(isPendingSettlement(s)).toBe(false)
  })

  it('includes marked_paid rows as PENDING payments (visible, but flagged as not-in-balances)', () => {
    const s = makeSettlement({ id: 's1', status: 'marked_paid' })
    expect(isFeedSettlement(s)).toBe(true)
    expect(isPendingSettlement(s)).toBe(true)
  })

  it('excludes suggested rows entirely (freeze-flow proposals are not payments)', () => {
    expect(isFeedSettlement(makeSettlement({ id: 's1', status: 'suggested' }))).toBe(false)
  })
})

describe('applySettlementFilters', () => {
  const settlements = [
    makeSettlement({ id: 's1', from_user_id: 'bob', to_user_id: 'alice' }),
    makeSettlement({ id: 's2', from_user_id: 'carol', to_user_id: 'dave', currency: 'EUR' }),
  ]

  it('passes everything through with empty filters', () => {
    expect(applySettlementFilters(settlements, EMPTY_FILTERS, 'GBP')).toHaveLength(2)
  })

  it('matches the person filter against EITHER side of the transfer', () => {
    expect(applySettlementFilters(settlements, { ...EMPTY_FILTERS, personId: 'alice' }, 'GBP').map((s) => s.id)).toEqual(['s1'])
    expect(applySettlementFilters(settlements, { ...EMPTY_FILTERS, personId: 'carol' }, 'GBP').map((s) => s.id)).toEqual(['s2'])
  })

  it('matches the currency filter (null currency defaults to trip base)', () => {
    const noCurrency = makeSettlement({ id: 's3' })
    ;(noCurrency as { currency: string | null }).currency = null
    const all = [...settlements, noCurrency]
    expect(applySettlementFilters(all, { ...EMPTY_FILTERS, currency: 'GBP' }, 'GBP').map((s) => s.id)).toEqual(['s1', 's3'])
    expect(applySettlementFilters(all, { ...EMPTY_FILTERS, currency: 'EUR' }, 'GBP').map((s) => s.id)).toEqual(['s2'])
  })

  it('excludes ALL settlements when a category or unclaimed filter is active (expense-only concepts)', () => {
    expect(applySettlementFilters(settlements, { ...EMPTY_FILTERS, category: 'food' }, 'GBP')).toEqual([])
    expect(applySettlementFilters(settlements, { ...EMPTY_FILTERS, unclaimedOnly: true }, 'GBP')).toEqual([])
  })
})

describe('groupMoneyFeedByDay', () => {
  it('interleaves settlements into the same day group as that day\'s expenses', () => {
    const expenses = [makeExpense({ id: 'e1', payment_date: '2026-07-01' })]
    const settlements = [makeSettlement({ id: 's1', settled_at: '2026-07-01T12:00:00Z' })]
    const grouped = groupMoneyFeedByDay(expenses, settlements)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].date).toBe('2026-07-01')
    expect(grouped[0].expenses.map((e) => e.id)).toEqual(['e1'])
    expect(grouped[0].settlements.map((s) => s.id)).toEqual(['s1'])
  })

  it('creates a payments-only day when settlements happened on a day with no expenses (e.g. pre-trip pre-payments)', () => {
    const expenses = [makeExpense({ id: 'e1', payment_date: '2026-07-10' })]
    const settlements = [makeSettlement({ id: 's1', settled_at: '2026-07-01T12:00:00Z' })]
    const grouped = groupMoneyFeedByDay(expenses, settlements)
    expect(grouped.map((g) => g.date)).toEqual(['2026-07-10', '2026-07-01'])
    expect(grouped[1].expenses).toEqual([])
    expect(grouped[1].settlements.map((s) => s.id)).toEqual(['s1'])
  })

  it('sorts days descending (newest first), matching groupExpensesByDay', () => {
    const expenses = [
      makeExpense({ id: 'e1', payment_date: '2026-07-05' }),
      makeExpense({ id: 'e2', payment_date: '2026-07-08' }),
    ]
    const settlements = [makeSettlement({ id: 's1', settled_at: '2026-07-06T12:00:00Z' })]
    expect(groupMoneyFeedByDay(expenses, settlements).map((g) => g.date)).toEqual(['2026-07-08', '2026-07-06', '2026-07-05'])
  })

  it('orders multiple same-day settlements by settled_at (oldest first, the order they happened)', () => {
    const settlements = [
      makeSettlement({ id: 's-later', settled_at: '2026-07-01T18:00:00Z' }),
      makeSettlement({ id: 's-earlier', settled_at: '2026-07-01T09:00:00Z' }),
    ]
    const grouped = groupMoneyFeedByDay([], settlements)
    expect(grouped[0].settlements.map((s) => s.id)).toEqual(['s-earlier', 's-later'])
  })

  it('returns an empty list when there is nothing to show', () => {
    expect(groupMoneyFeedByDay([], [])).toEqual([])
  })
})
