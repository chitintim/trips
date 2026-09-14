import { describe, it, expect } from 'vitest'
import {
  computeSuggestedPayments,
  isFullySettled,
  balanceEpsilonMajor,
  computePendingMismatches,
  excludePendingPairs,
  type SettleUpPerson,
} from './settleUpLogic'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'
import type { Transaction } from '../../../lib/debtMinimization'

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

function makeCarryover(
  overrides: Partial<SettlementCarryover> & { from_user_id: string; to_user_id: string; amount: number }
): SettlementCarryover {
  return {
    id: `carryover-${Math.random()}`,
    trip_id: 'trip-1',
    source_trip_id: 'trip-0-bali',
    created_by: 'alice',
    currency: 'GBP',
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  } as SettlementCarryover
}

const people: SettleUpPerson[] = [
  { userId: 'alice', name: 'Alice' },
  { userId: 'bob', name: 'Bob' },
]

describe('computeSuggestedPayments with folded settlement_carryovers', () => {
  it('a folded carryover changes the suggested payment amount, not just the balances screen', () => {
    // Trip B alone: Bob owes Alice £50.
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const withoutCarryover = computeSuggestedPayments(expenses, [], people, 'GBP', true)
    expect(withoutCarryover).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 50 }])

    // Bob also still owes Alice £30 folded in from a completed trip.
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 30 })]
    const withCarryover = computeSuggestedPayments(expenses, [], people, 'GBP', true, carryovers)
    expect(withCarryover).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 80 }])
  })

  it('a folded carryover can flip who pays whom when it outweighs the target trip balance', () => {
    // Trip B alone: Bob owes Alice £20.
    const expenses = [
      makeExpense({ id: 'e1', amount: 40, paid_by: 'alice', splits: [makeSplit('alice', 20), makeSplit('bob', 20)] }),
    ]
    // But Alice owed Bob £50 from a prior completed trip, now folded in.
    const carryovers = [makeCarryover({ from_user_id: 'alice', to_user_id: 'bob', amount: 50 })]
    const suggested = computeSuggestedPayments(expenses, [], people, 'GBP', true, carryovers)
    // Net: Alice owed Bob 50, Bob owed Alice 20 -> Alice now owes Bob £30 overall.
    expect(suggested).toEqual([{ from: 'alice', to: 'bob', fromName: 'Alice', toName: 'Bob', amount: 30 }])
  })
})

describe('computeSuggestedPayments carryover exclusion guards', () => {
  it('a carryover involving a departed participant is excluded -- suggestions stay consistent with the zero-sum header instead of silently desyncing', () => {
    // Trip: Bob owes Alice £50. A stale carryover names 'charlie', who has
    // left the trip. Pre-guard, only Alice's side of that row was applied,
    // breaking zero-sum -- and min-cash-flow over a non-zero-sum input
    // produces payments that disagree with the position header.
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'charlie', to_user_id: 'alice', amount: 40 })]
    const suggested = computeSuggestedPayments(expenses, [], people, 'GBP', true, carryovers)
    expect(suggested).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 50 }])
  })

  it('a mismatched-currency carryover row is excluded from suggested payments (no 1:1 minor-unit mixing)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 10000, currency: 'JPY' })]
    const suggested = computeSuggestedPayments(expenses, [], people, 'GBP', true, carryovers)
    // Identical to baseline -- the JPY row contributes nothing (NOT +£100).
    expect(suggested).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 50 }])
  })
})

describe('computeSuggestedPayments direct (simplify=false) mode', () => {
  const threePeople: SettleUpPerson[] = [
    { userId: 'alice', name: 'Alice' },
    { userId: 'bob', name: 'Bob' },
    { userId: 'charlie', name: 'Charlie' },
  ]
  // Chain: Bob owes Alice £30 (e1), Charlie owes Bob £30 (e2).
  const chainExpenses = [
    makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('bob', 30), makeSplit('charlie', 30)] }),
  ]

  it('direct mode preserves actual pairwise debts instead of netting through third parties', () => {
    const direct = computeSuggestedPayments(chainExpenses, [], threePeople, 'GBP', false)
    expect(direct).toHaveLength(2)
    expect(direct).toEqual(
      expect.arrayContaining([
        { from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 30 },
        { from: 'charlie', to: 'bob', fromName: 'Charlie', toName: 'Bob', amount: 30 },
      ])
    )
  })

  it('simplify mode collapses the same chain into fewer payments (the toggle actually changes the plan)', () => {
    const simplified = computeSuggestedPayments(chainExpenses, [], threePeople, 'GBP', true)
    expect(simplified).toEqual([{ from: 'charlie', to: 'alice', fromName: 'Charlie', toName: 'Alice', amount: 30 }])
  })

  it('direct mode folds usable carryovers into the pairwise amounts', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 30 })]
    const direct = computeSuggestedPayments(expenses, [], people, 'GBP', false, carryovers)
    expect(direct).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 80 }])
  })

  it('direct mode excludes mismatched-currency carryovers, same as simplify mode', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 10000, currency: 'JPY' })]
    const direct = computeSuggestedPayments(expenses, [], people, 'GBP', false, carryovers)
    expect(direct).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 50 }])
  })

  it('direct mode emits no dust payments for a settled pair (epsilon behavior)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    expect(computeSuggestedPayments(expenses, [], people, 'GBP', false)).toEqual([])
  })

  it('direct mode respects recorded settlements between a pair', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    const settlements = [
      {
        id: 's1',
        trip_id: 'trip-1',
        from_user_id: 'bob',
        to_user_id: 'alice',
        amount: 20,
        currency: 'GBP',
        status: 'confirmed',
        created_at: '2026-08-02T00:00:00Z',
      } as never,
    ]
    const direct = computeSuggestedPayments(expenses, settlements, people, 'GBP', false)
    expect(direct).toEqual([{ from: 'bob', to: 'alice', fromName: 'Bob', toName: 'Alice', amount: 30 }])
  })
})

function makeSettlement(overrides: Partial<Settlement> & { from_user_id: string; to_user_id: string; amount: number }): Settlement {
  return {
    id: `s-${Math.random()}`,
    trip_id: 'trip-1',
    currency: 'GBP',
    status: 'suggested',
    created_by: 'alice',
    created_at: '2026-08-01T00:00:00Z',
    settled_at: '2026-08-01T00:00:00Z',
    notes: null,
    payment_method: null,
    ...overrides,
  } as Settlement
}

function makeTransaction(from: string, to: string, amount: number): Transaction {
  return { from, to, fromName: from, toName: to, amount }
}

describe('balanceEpsilonMajor', () => {
  it('is currency-aware (0.01 for GBP, 1 for JPY)', () => {
    expect(balanceEpsilonMajor('GBP')).toBeCloseTo(0.01)
    expect(balanceEpsilonMajor('JPY')).toBe(1)
  })
})

describe('computePendingMismatches', () => {
  it('flags a marked_paid row whose recorded amount no longer matches the live suggestion for that pair', () => {
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'marked_paid' })]
    const live = [makeTransaction('bob', 'alice', 80)]
    const mismatches = computePendingMismatches(settlements, live, 'GBP')
    expect(mismatches.get(settlements[0].id)).toBe(80)
  })

  it('does not flag a marked_paid row whose amount still matches (within epsilon)', () => {
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'marked_paid' })]
    const live = [makeTransaction('bob', 'alice', 50.001)]
    expect(computePendingMismatches(settlements, live, 'GBP').size).toBe(0)
  })

  it('flags a marked_paid row as recomputing to 0 when the pair no longer owes anything live', () => {
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'marked_paid' })]
    const mismatches = computePendingMismatches(settlements, [], 'GBP')
    expect(mismatches.get(settlements[0].id)).toBe(0)
  })

  it('ignores suggested and confirmed rows -- only marked_paid (awaiting confirmation) is compared', () => {
    const settlements = [
      makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'suggested' }),
      makeSettlement({ from_user_id: 'charlie', to_user_id: 'alice', amount: 20, status: 'confirmed' }),
    ]
    expect(computePendingMismatches(settlements, [], 'GBP').size).toBe(0)
  })
})

describe('excludePendingPairs (refreeze dedup)', () => {
  it('excludes a suggested pair that already has a pending marked_paid row for the same from/to', () => {
    const suggested = [makeTransaction('bob', 'alice', 50), makeTransaction('charlie', 'alice', 20)]
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'marked_paid' })]
    const result = excludePendingPairs(suggested, settlements)
    expect(result).toEqual([makeTransaction('charlie', 'alice', 20)])
  })

  it('does not exclude a pair whose only settlement rows are suggested or confirmed', () => {
    const suggested = [makeTransaction('bob', 'alice', 50)]
    const settlements = [makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'confirmed' })]
    expect(excludePendingPairs(suggested, settlements)).toEqual(suggested)
  })

  it('is a no-op when there are no pending settlements at all', () => {
    const suggested = [makeTransaction('bob', 'alice', 50)]
    expect(excludePendingPairs(suggested, [])).toEqual(suggested)
  })
})

describe('isFullySettled with folded settlement_carryovers', () => {
  it('a trip that looks settled on its own is NOT fully settled once an unpaid carryover is folded in', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    expect(isFullySettled(people, expenses, [], 'GBP')).toBe(true)

    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 25 })]
    expect(isFullySettled(people, expenses, [], 'GBP', carryovers)).toBe(false)
  })
})
