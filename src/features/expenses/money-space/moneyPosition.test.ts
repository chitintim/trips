import { describe, it, expect } from 'vitest'
import { computeMoneyPosition } from './moneyPosition'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

function makeExpense(overrides: Partial<ExpenseWithDetails> & { id: string }): ExpenseWithDetails {
  return {
    trip_id: 'trip-1',
    description: 'Test expense',
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

function makeSplit(userId: string, amount: number, overrides: Partial<ExpenseWithDetails['splits'][number]> = {}) {
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
    ...overrides,
  }
}

function makeSettlement(overrides: Partial<Settlement> & { from_user_id: string; to_user_id: string; amount: number }): Settlement {
  return {
    id: `settlement-${Math.random()}`,
    trip_id: 'trip-1',
    created_by: 'alice',
    currency: 'GBP',
    notes: null,
    payment_method: null,
    settled_at: '2026-08-10T00:00:00Z',
    status: 'confirmed',
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  } as Settlement
}

describe('computeMoneyPosition', () => {
  it('returns "owed" when the current user is a net creditor', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP')
    expect(pos.kind).toBe('owed')
    expect(pos.amount).toBe(50)
    expect(pos.currency).toBe('GBP')
  })

  it('returns "owe" when the current user is a net debtor', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'bob', 'GBP')
    expect(pos.kind).toBe('owe')
    expect(pos.amount).toBe(50)
  })

  it('returns "settled" ("All square") when balanced', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP')
    expect(pos.kind).toBe('settled')
    expect(pos.amount).toBe(0)
  })

  it('returns "settled" when there is no current user (never crashes on a missing id)', () => {
    const pos = computeMoneyPosition([], [], ['alice', 'bob'], undefined, 'GBP')
    expect(pos.kind).toBe('settled')
    expect(pos.perPerson).toEqual([])
  })

  it('builds a per-person breakdown that sums to the same net the headline shows', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 300,
        paid_by: 'alice',
        splits: [makeSplit('alice', 100), makeSplit('bob', 100), makeSplit('carol', 100)],
      }),
    ]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob', 'carol'], 'alice', 'GBP')
    expect(pos.kind).toBe('owed')
    expect(pos.amount).toBe(200) // owed by both bob and carol

    const bySum = pos.perPerson.reduce((sum, row) => sum + row.netMinor, 0)
    expect(bySum).toBe(20000) // matches pos.amount in minor units
    expect(pos.perPerson.find((r) => r.userId === 'bob')?.netMinor).toBe(10000)
    expect(pos.perPerson.find((r) => r.userId === 'carol')?.netMinor).toBe(10000)
  })

  it('excludes settled (near-zero) counterparties from the breakdown', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'confirmed' })]
    const pos = computeMoneyPosition(expenses, settlements, ['alice', 'bob'], 'alice', 'GBP')
    expect(pos.kind).toBe('settled')
    expect(pos.perPerson).toEqual([])
  })

  it('flags expenses missing an FX rate the same way computeBalances does', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 5000, currency: 'JPY', fx_rate: null, paid_by: 'bob', splits: [makeSplit('bob', 5000)] }),
    ]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP')
    expect(pos.expensesMissingRate).toEqual(['e1'])
  })
})
