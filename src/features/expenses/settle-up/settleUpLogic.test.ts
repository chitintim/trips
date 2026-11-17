import { describe, it, expect } from 'vitest'
import {
  computeSuggestedPayments,
  isFullySettled,
  balanceEpsilonMajor,
  computePendingMismatches,
  computeRemainingSuggestions,
  dedupeTransactions,
  findDuplicatePayments,
  unresolvedDuplicateGroups,
  type SettleUpPerson,
} from './settleUpLogic'
import { explainMoneyPosition } from '../../../lib/cost/moneyEquation'
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

// ---------------------------------------------------------------------------
// Sicily regression: the payer had marked four payments paid BEFORE a (re)freeze;
// balances count only confirmed rows, so the freeze suggested the same four
// payments again and they were marked paid a second time.
// ---------------------------------------------------------------------------
const sicilyPeople: SettleUpPerson[] = ['tim', 'tharindu', 'lv', 'raine', 'leo', 'emma'].map((id) => ({ userId: id, name: id }))

function sicilyExpenses(): ExpenseWithDetails[] {
  // tharindu/lv/raine/leo each paid £200 shared with tim (tim owes each £100); leo also paid £80 shared with emma (emma owes leo £40).
  const shared = (id: string, payer: string, other: string, amount: number) =>
    makeExpense({ id, amount, paid_by: payer, splits: [makeSplit(payer, amount / 2), makeSplit(other, amount / 2)] })
  return [
    shared('e1', 'tharindu', 'tim', 200),
    shared('e2', 'lv', 'tim', 200),
    shared('e3', 'raine', 'tim', 200),
    shared('e4', 'leo', 'tim', 200),
    shared('e5', 'leo', 'emma', 80),
  ]
}
const markedPaidByTim = (to: string, amount = 100, id = `mp-${to}`) =>
  makeSettlement({ id, from_user_id: 'tim', to_user_id: to, amount, status: 'marked_paid', created_at: '2026-09-13T14:29:47Z' })
const timPaidFour = () => ['tharindu', 'lv', 'raine', 'leo'].map((to) => markedPaidByTim(to))
const pairOf = (t: Transaction) => `${t.from}>${t.to}`

describe('Sicily sequence: four payments marked paid, then freeze', () => {
  for (const simplify of [false, true]) {
    it(`does not suggest the four payments again (simplify=${simplify}) but still suggests the other debt`, () => {
      const existing = timPaidFour()
      const before = computeSuggestedPayments(sicilyExpenses(), existing, sicilyPeople, 'GBP', simplify)
      // The old behaviour: marked_paid is not in the balances, so Tim still appears to owe everyone.
      expect(before.filter((t) => t.from === 'tim').length).toBeGreaterThan(0)

      const remaining = computeRemainingSuggestions(sicilyExpenses(), existing, sicilyPeople, 'GBP', simplify)
      expect(remaining.filter((t) => t.from === 'tim' || t.to === 'tim')).toEqual([])
      expect(remaining.map((t) => [t.from, t.to, t.amount])).toEqual([['emma', 'leo', 40]])
    })
  }

  it('a freeze inserts only suggested rows, so the row set has no duplicate payment and each receiver has one confirm', () => {
    const existing = timPaidFour()
    const toInsert = computeRemainingSuggestions(sicilyExpenses(), existing, sicilyPeople, 'GBP', false)
    const afterFreeze: Settlement[] = [
      ...existing,
      ...toInsert.map((t) =>
        makeSettlement({ from_user_id: t.from, to_user_id: t.to, amount: t.amount, status: 'suggested', created_at: '2026-09-14T00:29:20Z' })
      ),
    ]
    expect(findDuplicatePayments(afterFreeze, 'GBP')).toEqual([])
    for (const to of ['tharindu', 'lv', 'raine', 'leo']) {
      expect(afterFreeze.filter((s) => s.from_user_id === 'tim' && s.to_user_id === to && s.status !== 'confirmed')).toHaveLength(1)
    }
    // Refreezing again (unfreeze, freeze) over the same rows still adds nothing for Tim.
    const again = computeRemainingSuggestions(sicilyExpenses(), afterFreeze.filter((s) => s.status !== 'suggested'), sicilyPeople, 'GBP', false)
    expect(again.map(pairOf)).toEqual(['emma>leo'])
  })

  it("the payer's position counts the four sent payments once (sent 400, nothing left to pay)", () => {
    const eq = explainMoneyPosition({
      expenses: sicilyExpenses(),
      settlements: timPaidFour(),
      participantUserIds: sicilyPeople.map((p) => p.userId),
      currentUserId: 'tim',
      baseCurrency: 'GBP',
    })
    expect(eq.sentWaiting).toBe(400)
    expect(eq.remainingToPay).toBe(0)
  })

  it('the duplicated state seen live (eight marked_paid rows) is detected as four pairs, oldest first', () => {
    const batchA = timPaidFour()
    const batchB = ['tharindu', 'lv', 'raine', 'leo'].map((to) =>
      makeSettlement({ id: `b-${to}`, from_user_id: 'tim', to_user_id: to, amount: 100, status: 'marked_paid', created_at: '2026-09-14T00:29:18Z' })
    )
    const groups = findDuplicatePayments([...batchB, ...batchA], 'GBP')
    expect(groups).toHaveLength(4)
    for (const g of groups) {
      expect(g.rows).toHaveLength(2)
      expect(`${g.rows[0].created_at}` < `${g.rows[1].created_at}`).toBe(true)
    }
  })
})

describe('Sailing Sicily live shape: every payment recorded twice (batch A 09-13, batch B 09-14), then unfreeze and freeze', () => {
  const batchB = () =>
    ['tharindu', 'lv', 'raine', 'leo'].map((to) =>
      makeSettlement({ id: `b-${to}`, from_user_id: 'tim', to_user_id: to, amount: 100, status: 'marked_paid', created_at: '2026-09-14T00:29:18Z' })
    )
  const eight = () => [...timPaidFour(), ...batchB()]

  for (const simplify of [false, true]) {
    it(`counts each duplicated payment once, so there are no reverse suggestions (simplify=${simplify})`, () => {
      const remaining = computeRemainingSuggestions(sicilyExpenses(), eight(), sicilyPeople, 'GBP', simplify)
      expect(remaining.filter((t) => t.to === 'tim')).toEqual([])
      expect(remaining.filter((t) => t.from === 'tim')).toEqual([])
      expect(remaining.map((t) => [t.from, t.to, t.amount])).toEqual([['emma', 'leo', 40]])
    })
  }

  it('Freeze is blocked while the four duplicate groups are unresolved, and unblocked once one row of each is gone', () => {
    expect(unresolvedDuplicateGroups(eight(), 'GBP')).toHaveLength(4)
    expect(unresolvedDuplicateGroups(timPaidFour(), 'GBP')).toHaveLength(0)
  })

  it('a marked_paid row duplicating a confirmed one is not counted twice', () => {
    const confirmed = makeSettlement({ id: 'c', from_user_id: 'tim', to_user_id: 'leo', amount: 100, status: 'confirmed', created_at: '2026-09-13T14:00:00Z' })
    const dup = markedPaidByTim('leo', 100, 'dup')
    const r = computeRemainingSuggestions(sicilyExpenses(), [confirmed, dup], sicilyPeople, 'GBP', false)
    const only = computeRemainingSuggestions(sicilyExpenses(), [confirmed], sicilyPeople, 'GBP', false)
    expect(r).toEqual(only)
  })

  it('two equal payments more than 24h apart are separate instalments and both count', () => {
    const first = markedPaidByTim('leo', 50, 'i1')
    const second = makeSettlement({ id: 'i2', from_user_id: 'tim', to_user_id: 'leo', amount: 50, status: 'marked_paid', created_at: '2026-09-20T00:00:00Z' })
    expect(findDuplicatePayments([first, second], 'GBP')).toEqual([])
    expect(unresolvedDuplicateGroups([first, second], 'GBP')).toEqual([])
  })

  it('confirmed-only duplicates do not block a freeze (already in the balances, nothing removable)', () => {
    const a = makeSettlement({ id: 'ca', from_user_id: 'tim', to_user_id: 'leo', amount: 10, status: 'confirmed', created_at: '2026-09-13T14:00:00Z' })
    const b = makeSettlement({ id: 'cb', from_user_id: 'tim', to_user_id: 'leo', amount: 10, status: 'confirmed', created_at: '2026-09-13T15:00:00Z' })
    expect(findDuplicatePayments([a, b], 'GBP')).toHaveLength(1)
    expect(unresolvedDuplicateGroups([a, b], 'GBP')).toHaveLength(0)
  })
})

describe('computeRemainingSuggestions: partial, over- and cross-currency payments', () => {
  const two: SettleUpPerson[] = [
    { userId: 'alice', name: 'Alice' },
    { userId: 'bob', name: 'Bob' },
  ]
  const exp = [makeExpense({ id: 'e1', amount: 200, paid_by: 'alice', splits: [makeSplit('alice', 100), makeSplit('bob', 100)] })]
  const sent = (amount: number, status: Settlement['status'], currency = 'GBP') =>
    makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount, status, currency })

  it('a partial marked_paid payment reduces the suggestion', () => {
    for (const simplify of [false, true]) {
      const r = computeRemainingSuggestions(exp, [sent(30, 'marked_paid')], two, 'GBP', simplify)
      expect(r.map((t) => [t.from, t.to, t.amount])).toEqual([['bob', 'alice', 70]])
    }
  })

  it('a confirmed payment is counted once (already in balances), not twice', () => {
    const r = computeRemainingSuggestions(exp, [sent(30, 'confirmed')], two, 'GBP', true)
    expect(r.map((t) => t.amount)).toEqual([70])
  })

  it('paying more than owed flips into the reverse suggestion, never a negative amount', () => {
    for (const simplify of [false, true]) {
      const r = computeRemainingSuggestions(exp, [sent(130, 'marked_paid')], two, 'GBP', simplify)
      expect(r.map((t) => [t.from, t.to, t.amount])).toEqual([['alice', 'bob', 30]])
      expect(r.every((t) => t.amount > 0)).toBe(true)
    }
  })

  it('a payment in another currency does not reduce a GBP suggestion', () => {
    const r = computeRemainingSuggestions(exp, [sent(100, 'marked_paid', 'EUR')], two, 'GBP', true)
    expect(r.map((t) => t.amount)).toEqual([100])
  })

  it('suggested rows are ignored, and the input rows are not mutated', () => {
    const rows = [sent(100, 'suggested'), sent(30, 'marked_paid')]
    const r = computeRemainingSuggestions(exp, rows, two, 'GBP', true)
    expect(r.map((t) => t.amount)).toEqual([70])
    expect(rows[1].status).toBe('marked_paid')
  })

  it('does not change what computePendingMismatches compares against (plain suggestions ignore marked_paid)', () => {
    const rows = [sent(100, 'marked_paid')]
    expect(computeSuggestedPayments(exp, rows, two, 'GBP', true).map((t) => t.amount)).toEqual([100])
    expect(computeRemainingSuggestions(exp, rows, two, 'GBP', true)).toEqual([])
  })
})

describe('dedupeTransactions', () => {
  it('drops repeated identical from/to/amount entries only', () => {
    const t = [makeTransaction('a', 'b', 5), makeTransaction('a', 'b', 5), makeTransaction('a', 'b', 6), makeTransaction('b', 'a', 5)]
    expect(dedupeTransactions(t)).toHaveLength(3)
  })
})

describe('findDuplicatePayments', () => {
  const row = (over: Partial<Settlement> = {}) => makeSettlement({ from_user_id: 'bob', to_user_id: 'alice', amount: 50, status: 'marked_paid', ...over })

  it('ignores suggested rows and different amounts, pairs or currencies', () => {
    expect(
      findDuplicatePayments(
        [row({ status: 'suggested' }), row({ status: 'suggested' }), row(), row({ amount: 51 }), row({ from_user_id: 'carol' }), row({ currency: 'EUR' })],
        'GBP'
      )
    ).toEqual([])
  })

  it('groups a marked_paid and a confirmed row with the same amount, earliest first', () => {
    const late = row({ id: 'late', created_at: '2026-09-13T10:00:00Z' })
    const early = row({ id: 'early', status: 'confirmed', created_at: '2026-09-13T00:00:00Z' })
    const [g] = findDuplicatePayments([late, early], 'GBP')
    expect(g.rows.map((r) => r.id)).toEqual(['early', 'late'])
    expect(g.amount).toBe(50)
  })

  it('treats a null currency as the base currency', () => {
    expect(findDuplicatePayments([row({ currency: null as unknown as string }), row()], 'GBP')).toHaveLength(1)
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

describe('suggestions with unclaimed receipt value (the payer\'s pending bucket)', () => {
  const people: SettleUpPerson[] = [
    { userId: 'alice', name: 'Alice' },
    { userId: 'bob', name: 'Bob' },
    { userId: 'cy', name: 'Cy' },
  ]
  const line = (id: string, total: number) => ({ id, quantity: 1, total_amount: total })
  const claim = (id: string, lineId: string, userId: string, owed: number) => ({ id, line_item_id: lineId, user_id: userId, quantity_claimed: 1, amount_owed: owed })
  // 120 dinner paid by alice: bob 24, cy 24, alice 24; 48 unclaimed.
  const dinner = makeExpense({
    id: 'din',
    amount: 120,
    paid_by: 'alice',
    ai_parsed: true,
    status: 'pending_allocation',
    line_items: [line('a', 24), line('b', 24), line('c', 24), line('d', 48)] as never,
    claims: [claim('1', 'a', 'bob', 24), claim('2', 'b', 'cy', 24), claim('3', 'c', 'alice', 24)] as never,
  })

  it.each([true, false])('asks only for what people actually owe (simplify=%s): no phantom credit for the payer', (simplify) => {
    const t = computeSuggestedPayments([dinner], [], people, 'GBP', simplify)
    expect(t.map((x) => [x.from, x.to, x.amount]).sort()).toEqual([['bob', 'alice', 24], ['cy', 'alice', 24]])
  })

  it('computeRemainingSuggestions and isFullySettled use the corrected balances too', () => {
    const paid: Settlement[] = [
      { id: 's1', trip_id: 'trip-1', from_user_id: 'bob', to_user_id: 'alice', amount: 24, currency: 'GBP', status: 'marked_paid', created_at: '2026-08-02T00:00:00Z', settled_at: '2026-08-02T00:00:00Z', created_by: 'bob', notes: null, payment_method: null },
      { id: 's2', trip_id: 'trip-1', from_user_id: 'cy', to_user_id: 'alice', amount: 24, currency: 'GBP', status: 'confirmed', created_at: '2026-08-02T00:00:00Z', settled_at: '2026-08-02T00:00:00Z', created_by: 'cy', notes: null, payment_method: null },
    ] as Settlement[]
    expect(computeRemainingSuggestions([dinner], paid, people, 'GBP', true)).toEqual([])
    // Once both payments are confirmed the payer is square: before the fix alice would still be "owed" the unclaimed 48.
    expect(isFullySettled(people, [dinner], paid.map((p) => ({ ...p, status: 'confirmed' })) as Settlement[], 'GBP')).toBe(true)
  })
})
