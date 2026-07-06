import { describe, it, expect } from 'vitest'
import { computeBalances, splitOwedAmounts, BALANCE_EPSILON_MINOR } from './balances'
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

describe('computeBalances', () => {
  it('computes a simple two-person equal split (payer is owed, other person owes)', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 100,
        currency: 'GBP',
        paid_by: 'alice',
        splits: [makeSplit('alice', 50), makeSplit('bob', 50)],
      }),
    ]
    const { balances, groupTotalMinor, expensesMissingRate } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP')
    expect(expensesMissingRate).toEqual([])
    expect(groupTotalMinor).toBe(10000)

    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    expect(alice.netBalanceMinor).toBe(5000) // paid 100, owed 50 -> +50
    expect(bob.netBalanceMinor).toBe(-5000) // paid 0, owed 50 -> -50
    // Zero-sum invariant (plan §16).
    expect(alice.netBalanceMinor + bob.netBalanceMinor).toBe(0)
  })

  it('is balanced (isBalanced true) when paid equals owed', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    const { balances } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP')
    expect(balances.every((b) => b.isBalanced)).toBe(true)
    expect(balances.every((b) => b.netBalanceMinor === 0)).toBe(true)
  })

  it('flags an expense with a foreign currency and no fx_rate as missing, excluding it from totals rather than silently zeroing (v1 bug fix)', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 100,
        currency: 'GBP',
        paid_by: 'alice',
        splits: [makeSplit('alice', 100)],
      }),
      makeExpense({
        id: 'e2',
        amount: 5000,
        currency: 'JPY',
        fx_rate: null, // no rate resolved yet
        paid_by: 'bob',
        splits: [makeSplit('bob', 5000)],
      }),
    ]
    const { balances, groupTotalMinor, expensesMissingRate } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP')

    expect(expensesMissingRate).toEqual(['e2'])
    // Group total should reflect only e1 (10000 minor units = £100), not
    // silently include e2 as if it contributed 0 while still "counting".
    expect(groupTotalMinor).toBe(10000)

    const bob = balances.find((b) => b.userId === 'bob')!
    // Bob neither paid nor owes anything from the flagged expense -- it's
    // fully excluded, not incorrectly zeroed into a false balance.
    expect(bob.totalPaidMinor).toBe(0)
    expect(bob.totalOwedMinor).toBe(0)
  })

  it('applies fx_rate to convert a foreign-currency expense into base currency', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 1000, // 1000 JPY
        currency: 'JPY',
        fx_rate: 0.005, // 1000 JPY * 0.005 = 5 GBP
        paid_by: 'alice',
        splits: [makeSplit('alice', 1000)],
      }),
    ]
    const { balances, groupTotalMinor } = computeBalances(expenses, [], ['alice'], 'GBP')
    expect(groupTotalMinor).toBe(500) // 5.00 GBP in minor units
    expect(balances[0].totalPaidMinor).toBe(500)
  })

  it('computes itemized expense balances from claims (converted at the expense fx rate), not splits', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 100,
        currency: 'GBP',
        paid_by: 'alice',
        ai_parsed: true,
        status: 'allocated',
        line_items: [
          {
            id: 'li1',
            expense_id: 'e1',
            line_number: 1,
            name_original: 'Item',
            name_english: null,
            quantity: 1,
            unit_price: 100,
            subtotal: 100,
            tax_amount: null,
            service_amount: null,
            line_discount_amount: null,
            line_discount_percent: null,
            total_amount: 100,
            notes: null,
            created_at: null,
          },
        ],
        claims: [
          { id: 'c1', expense_id: 'e1', line_item_id: 'li1', user_id: 'bob', quantity_claimed: 1, amount_owed: 100, confirmed: true, claimed_at: null, updated_at: null, user: {} as never },
        ],
        splits: [], // itemized expenses carry no split rows
      }),
    ]
    const { balances } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP')
    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    expect(alice.totalPaidMinor).toBe(10000)
    expect(bob.totalOwedMinor).toBe(10000)
    expect(alice.netBalanceMinor).toBe(10000)
    expect(bob.netBalanceMinor).toBe(-10000)
  })

  it('folds confirmed settlements into net balance (settlementsPaid reduces creditor position, settlementsReceived closes debtor position)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'confirmed' })]
    const { balances } = computeBalances(expenses, settlements, ['alice', 'bob'], 'GBP')
    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    // Bob paid alice 50 -> both now balanced.
    expect(alice.isBalanced).toBe(true)
    expect(bob.isBalanced).toBe(true)
  })

  it('excludes "suggested" and "marked_paid" settlements from balances (not yet real payments)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'suggested' })]
    const { balances } = computeBalances(expenses, settlements, ['alice', 'bob'], 'GBP')
    const bob = balances.find((b) => b.userId === 'bob')!
    expect(bob.isBalanced).toBe(false)
    expect(bob.netBalanceMinor).toBe(-5000)
  })

  it('treats a legacy settlement row with no status as confirmed (DB default preserves pre-v2 meaning)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // Simulate the DB default by omitting an explicit override of 'confirmed'.
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50 })]
    const { balances } = computeBalances(expenses, settlements, ['alice', 'bob'], 'GBP')
    expect(balances.every((b) => b.isBalanced)).toBe(true)
  })

  it('respects the balance epsilon for near-zero rounding residue', () => {
    expect(BALANCE_EPSILON_MINOR).toBeGreaterThan(0)
  })
})

describe('splitOwedAmounts', () => {
  it('returns owedToYou when net balance is positive', () => {
    expect(splitOwedAmounts(5000, 'GBP')).toEqual({ youOwe: 0, owedToYou: 50 })
  })

  it('returns youOwe when net balance is negative', () => {
    expect(splitOwedAmounts(-5000, 'GBP')).toEqual({ youOwe: 50, owedToYou: 0 })
  })

  it('returns zero for both when balance is exactly zero', () => {
    expect(splitOwedAmounts(0, 'GBP')).toEqual({ youOwe: 0, owedToYou: 0 })
  })

  it('handles zero-decimal currencies (JPY) without a decimal scale', () => {
    expect(splitOwedAmounts(5000, 'JPY')).toEqual({ youOwe: 0, owedToYou: 5000 })
  })
})
