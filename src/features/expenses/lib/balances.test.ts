import { describe, it, expect } from 'vitest'
import { toMinorUnits } from '../../../lib/money'
import { computeBalances, claimSource, findUnclaimedReceipts, findFreezeBlockingReceipts, isLineReallyUnclaimed, claimOwnQuantity, claimOwnAmount, claimLeftoverQuantity, claimLeftoverAmount, hasOwnClaim, allLinesClaimedWithinDust, collectMoneyUserIds, withMoneyParticipants, splitOwedAmounts, BALANCE_EPSILON_MINOR, carryoversToPseudoSettlements, partitionCarryovers } from './balances'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'

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

describe('computeBalances with folded settlement_carryovers', () => {
  it('a folded carryover INCREASES what the debtor owes on the target trip (unpaid debt carried forward, not resolved)', () => {
    // Target trip: Alice paid £100 split equally -> Bob owes Alice £50.
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // Carryover: Bob (debtor) still owes Alice (creditor) £30 from a prior
    // completed trip, already folded into THIS trip's settlement.
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 30 })]

    const withoutCarryover = computeBalances(expenses, [], ['alice', 'bob'], 'GBP')
    const withCarryover = computeBalances(expenses, [], ['alice', 'bob'], 'GBP', carryovers)

    // Baseline (no carryover): Bob owes Alice exactly £50.
    expect(withoutCarryover.balances.find((b) => b.userId === 'bob')!.netBalanceMinor).toBe(-5000)

    // With the folded carryover: Bob owes Alice £50 (trip) + £30 (carryover) = £80.
    const alice = withCarryover.balances.find((b) => b.userId === 'alice')!
    const bob = withCarryover.balances.find((b) => b.userId === 'bob')!
    expect(bob.netBalanceMinor).toBe(-8000) // Bob owes £80, NOT reduced to £20
    expect(alice.netBalanceMinor).toBe(8000) // Alice is owed £80
    // Zero-sum invariant still holds with a carryover folded in.
    expect(alice.netBalanceMinor + bob.netBalanceMinor).toBe(0)
  })

  it('a folded carryover in the OTHER direction increases what the target-trip creditor now owes (nets against their existing claim)', () => {
    // Target trip: Alice paid £100 split equally -> Bob owes Alice £50 (Bob -5000, Alice +5000).
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // Carryover: Alice (debtor on the OLD trip) owes Bob (creditor) £80 from a prior trip.
    const carryovers = [makeCarryover({ from_user_id: 'alice', to_user_id: 'bob', amount: 80 })]

    const { balances } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP', carryovers)
    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    // Trip B alone: Alice +50. Carryover flips the direction: Alice owed Bob 80,
    // so combined Alice is net -30 (owes Bob £30), Bob is net +30.
    expect(alice.netBalanceMinor).toBe(-3000)
    expect(bob.netBalanceMinor).toBe(3000)
  })

  it('carryoversToPseudoSettlements reverses from/to relative to the carryover row (debtor/creditor -> settlement payer/receiver swap)', () => {
    const carryovers = [makeCarryover({ id: 'c1', from_user_id: 'bob', to_user_id: 'alice', amount: 30, currency: 'GBP' })]
    const [pseudo] = carryoversToPseudoSettlements(carryovers)
    expect(pseudo.from_user_id).toBe('alice')
    expect(pseudo.to_user_id).toBe('bob')
    expect(pseudo.amount).toBe(30)
    expect(pseudo.status).toBe('confirmed')
    expect(pseudo.id).toBe('carryover:c1')
  })

  it('EXCLUDES a mismatched-currency carryover from the math instead of reading its minor units 1:1 (JPY 10,000 must never count as GBP 100)', () => {
    // Target trip (GBP): Alice paid £100 split equally -> Bob owes Alice £50.
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // A bad historical row: JPY 10,000 folded into this GBP trip. Counting
    // its 10000 minor units as pence would add a phantom £100 (real value
    // is roughly £52) -- it must contribute NOTHING to the math.
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 10000, currency: 'JPY' })]

    const { balances } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP', carryovers)
    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    // Identical to the no-carryover baseline -- the JPY row is fully excluded.
    expect(bob.netBalanceMinor).toBe(-5000)
    expect(alice.netBalanceMinor).toBe(5000)
    // Zero-sum invariant preserved.
    expect(alice.netBalanceMinor + bob.netBalanceMinor).toBe(0)
  })

  it('EXCLUDES a carryover whose party is not among the participants (applying one side only would break zero-sum)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // 'charlie' has left this trip (not in the participant list below) --
    // the .has() guards in the settlement loop would apply only Alice's
    // side of this row, breaking the zero-sum invariant.
    const carryovers = [makeCarryover({ from_user_id: 'charlie', to_user_id: 'alice', amount: 40 })]

    const { balances } = computeBalances(expenses, [], ['alice', 'bob'], 'GBP', carryovers)
    const alice = balances.find((b) => b.userId === 'alice')!
    const bob = balances.find((b) => b.userId === 'bob')!
    // Row fully excluded: same as baseline, and the group still sums to zero.
    expect(alice.netBalanceMinor).toBe(5000)
    expect(bob.netBalanceMinor).toBe(-5000)
    expect(balances.reduce((sum, b) => sum + b.netBalanceMinor, 0)).toBe(0)
  })
})

describe('partitionCarryovers', () => {
  it('splits rows into usable / excludedCurrency / excludedParticipant buckets', () => {
    const usableRow = makeCarryover({ id: 'ok', from_user_id: 'bob', to_user_id: 'alice', amount: 30, currency: 'GBP' })
    const wrongCurrency = makeCarryover({ id: 'jpy', from_user_id: 'bob', to_user_id: 'alice', amount: 10000, currency: 'JPY' })
    const goneParticipant = makeCarryover({ id: 'gone', from_user_id: 'charlie', to_user_id: 'alice', amount: 40, currency: 'GBP' })

    const partition = partitionCarryovers([usableRow, wrongCurrency, goneParticipant], 'GBP', ['alice', 'bob'])
    expect(partition.usable.map((c) => c.id)).toEqual(['ok'])
    expect(partition.excludedCurrency.map((c) => c.id)).toEqual(['jpy'])
    expect(partition.excludedParticipant.map((c) => c.id)).toEqual(['gone'])
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

describe('people who left the trip (money participants)', () => {
  // Bob paid 600 and was removed; Alice and Carol owe 200 each, Bob 200.
  const expenses = [
    makeExpense({
      id: 'villa',
      amount: 600,
      paid_by: 'bob',
      splits: [makeSplit('alice', 200), makeSplit('bob', 200), makeSplit('carol', 200)],
    }),
  ]

  it('active-only roster drops the leaver and no longer sums to zero (the bug)', () => {
    const { balances } = computeBalances(expenses, [], ['alice', 'carol'], 'GBP')
    expect(balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(-40000)
  })

  it('withMoneyParticipants adds payers, split members and settlement parties once, roster first', () => {
    const settlements = [makeSettlement({ from_user_id: 'dave', to_user_id: 'alice', amount: 5 })]
    const ids = withMoneyParticipants(['alice', 'carol'], expenses, settlements, 'GBP')
    expect(ids).toEqual(['alice', 'carol', 'bob', 'dave'])
  })

  it('ignores pending settlements and unconvertible expenses when collecting', () => {
    const pending = makeSettlement({ from_user_id: 'erin', to_user_id: 'alice', amount: 5, status: 'suggested' })
    const noRate = makeExpense({ id: 'x', currency: 'EUR', fx_rate: null, paid_by: 'frank', splits: [makeSplit('gina', 1)] })
    expect(collectMoneyUserIds([noRate], [pending], 'GBP')).toEqual([])
  })

  it('including the leaver keeps the ledger at zero and shows what they are owed', () => {
    const ids = withMoneyParticipants(['alice', 'carol'], expenses, [], 'GBP')
    const { balances } = computeBalances(expenses, [], ids, 'GBP')
    expect(balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
    expect(balances.find((b) => b.userId === 'bob')?.netBalanceMinor).toBe(40000)
  })

  it('stays zero-sum across currencies, settlements and a carryover', () => {
    const mixed = [
      ...expenses,
      makeExpense({ id: 'ski', amount: 12000, currency: 'JPY', fx_rate: 0.005, paid_by: 'carol', splits: [makeSplit('alice', 6000), makeSplit('bob', 6000)] }),
    ]
    const settlements = [makeSettlement({ from_user_id: 'alice', to_user_id: 'bob', amount: 50 })]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'carol', amount: 10 })]
    const ids = withMoneyParticipants(['alice'], mixed, settlements, 'GBP', carryovers)
    const { balances } = computeBalances(mixed, settlements, ids, 'GBP', carryovers)
    expect(balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
    expect(balances.map((b) => b.userId).sort()).toEqual(['alice', 'bob', 'carol'])
  })
})

// ---------------------------------------------------------------------------
// Unclaimed itemised value (receipts): the payer's pending bucket
// ---------------------------------------------------------------------------

type Line = ExpenseWithDetails['line_items'][number]
type Claim = ExpenseWithDetails['claims'][number]

function makeLine(id: string, total: number, quantity = 1): Line {
  return {
    id,
    expense_id: 'e',
    line_number: 1,
    name_original: id,
    name_english: null,
    quantity,
    unit_price: total / quantity,
    subtotal: total,
    tax_amount: null,
    service_amount: null,
    line_discount_amount: null,
    line_discount_percent: null,
    total_amount: total,
    notes: null,
    created_at: null,
  } as Line
}

let claimSeq = 0
function makeClaim(lineId: string, userId: string, quantity: number, owed: number, source?: string, leftover?: { quantity: number; amount: number }): Claim {
  return {
    id: `c${++claimSeq}`,
    expense_id: 'e',
    line_item_id: lineId,
    user_id: userId,
    quantity_claimed: quantity,
    amount_owed: owed,
    confirmed: true,
    claimed_at: null,
    updated_at: null,
    user: {} as never,
    ...(source ? { source } : {}),
    ...(leftover ? { leftover_quantity: leftover.quantity, leftover_amount: leftover.amount } : {}),
  } as unknown as Claim
}

function receipt(id: string, paidBy: string, amount: number, lines: Line[], claims: Claim[], extra: Partial<ExpenseWithDetails> = {}) {
  return makeExpense({ id, paid_by: paidBy, amount, ai_parsed: true, status: 'pending_allocation', line_items: lines, claims, ...extra })
}

/** The implementation before pending buckets existed, kept verbatim as the reference for fully-claimed receipts. */
function legacyNet(expenses: ExpenseWithDetails[], ids: string[], base: string): Map<string, { paid: number; owed: number }> {
  const out = new Map(ids.map((i) => [i, { paid: 0, owed: 0 }]))
  const conv = (amt: number, e: ExpenseWithDetails) => {
    const rate = e.currency === base ? 1 : e.fx_rate
    return rate == null ? null : toMinorUnits(amt * rate, base)
  }
  for (const e of expenses) {
    const total = conv(e.amount, e)
    if (total == null) continue
    const p = out.get(e.paid_by)
    if (p) p.paid += total
    const itemized = !!e.ai_parsed && !!e.status && e.line_items.length > 0
    const rows = itemized ? e.claims.map((c) => ({ u: c.user_id, a: c.amount_owed })) : e.splits.map((s) => ({ u: s.user_id, a: s.amount }))
    for (const r of rows) {
      const o = out.get(r.u)
      if (o) o.owed += conv(r.a, e) ?? 0
    }
  }
  return out
}

describe('unclaimed itemised value', () => {
  it('counts unclaimed value as the payer\'s own share so the ledger sums to zero (worked example)', () => {
    // EUR 120 dinner paid by alice: steak 24 -> bob, wine 36 + dessert 12 unclaimed, rest 48 -> alice.
    const e = receipt('din', 'alice', 120, [makeLine('steak', 24), makeLine('wine', 36), makeLine('dessert', 12), makeLine('mains', 48)], [
      makeClaim('steak', 'bob', 1, 24),
      makeClaim('mains', 'alice', 1, 48),
    ], { currency: 'EUR', description: 'Dinner at Le Bistrot' })
    const r = computeBalances([e], [], ['alice', 'bob'], 'EUR')
    const alice = r.balances.find((b) => b.userId === 'alice')!
    const bob = r.balances.find((b) => b.userId === 'bob')!
    // Before: alice net = 120 - 48 = +72 (but bob only owes 24): ledger sums to +48.
    // After: alice's own share includes the 48 nobody claimed.
    expect(alice.pendingUnclaimedMinor).toBe(4800)
    expect(alice.totalOwedMinor).toBe(9600)
    expect(alice.netBalanceMinor).toBe(2400)
    expect(bob.netBalanceMinor).toBe(-2400)
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
    expect(r.unclaimedTotalMinor).toBe(4800)
    expect(r.unclaimedReceipts).toHaveLength(1)
    expect(r.unclaimedReceipts[0]).toMatchObject({ expenseId: 'din', totalMinor: 12000, claimedMinor: 7200, unclaimedMinor: 4800, dustMinor: 0, currency: 'EUR' })
  })

  it('a fully claimed receipt has no pending value and no unclaimed entry', () => {
    const e = receipt('r', 'alice', 30, [makeLine('a', 10), makeLine('b', 20)], [makeClaim('a', 'bob', 1, 10), makeClaim('b', 'alice', 1, 20)])
    const r = computeBalances([e], [], ['alice', 'bob'], 'GBP')
    expect(r.unclaimedReceipts).toEqual([])
    expect(r.pendingUnclaimedTotalMinor).toBe(0)
    expect(r.receipts[0]).toMatchObject({ unclaimedMinor: 0, dustMinor: 0, pendingMinor: 0 })
  })

  it('a leftover part is an ordinary part of the one row, and a missing source reads as self', () => {
    const e = receipt('r', 'alice', 30, [makeLine('a', 10), makeLine('b', 20)], [
      makeClaim('a', 'bob', 1, 10),
      makeClaim('b', 'bob', 0.5, 10, 'leftover', { quantity: 0.5, amount: 10 }),
      makeClaim('b', 'alice', 0.5, 10, 'leftover', { quantity: 0.5, amount: 10 }),
    ])
    const r = computeBalances([e], [], ['alice', 'bob'], 'GBP')
    expect(r.unclaimedReceipts).toEqual([])
    expect(r.receipts[0].leftoverClaimedMinor).toBe(2000)
    expect(r.balances.find((b) => b.userId === 'bob')!.totalOwedMinor).toBe(2000)
    expect(claimSource({})).toBe('self')
    expect(claimSource({ source: 'weird' })).toBe('self')
    expect(claimSource({ source: 'leftover' })).toBe('leftover')
  })

  it('folds penny dust on fully claimed lines into the payer bucket without changing what claimers owe', () => {
    // GBP 10 bottle shared 0.33 / 0.33 / 0.34 of a unit but amounts rounded 3.30 + 3.30 + 3.30 = 9.90 and the line is claimed in full (0.33 x 3 + 0.01 left).
    const e = receipt('r', 'alice', 10, [makeLine('wine', 10)], [makeClaim('wine', 'bob', 0.33, 3.3), makeClaim('wine', 'carol', 0.33, 3.3), makeClaim('wine', 'alice', 0.34, 3.4)])
    const dusty = receipt('r2', 'alice', 10, [makeLine('wine', 10)], [makeClaim('wine', 'bob', 0.33, 3.33), makeClaim('wine', 'carol', 0.33, 3.33), makeClaim('wine', 'alice', 0.34, 3.33)])
    const r = computeBalances([e, dusty], [], ['alice', 'bob', 'carol'], 'GBP')
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
    const status = r.receipts.find((x) => x.expenseId === 'r2')!
    expect(status.dustMinor).toBe(1)
    expect(status.unclaimedMinor).toBe(0)
    expect(r.unclaimedReceipts).toEqual([]) // dust never raises a warning
    expect(r.balances.find((b) => b.userId === 'bob')!.totalOwedMinor).toBe(333 + 330)
  })

  it('treats three claims of 0.33 as a fully claimed line with dust, not as 1% unclaimed', () => {
    const e = receipt('r', 'alice', 10, [makeLine('wine', 10)], [makeClaim('wine', 'a', 0.33, 3.3), makeClaim('wine', 'b', 0.33, 3.3), makeClaim('wine', 'c', 0.33, 3.3)])
    const r = computeBalances([e], [], ['alice', 'a', 'b', 'c'], 'GBP')
    expect(r.receipts[0]).toMatchObject({ unclaimedMinor: 0, dustMinor: 10, pendingMinor: 10 })
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
  })

  it('converts unclaimed value at the receipt\'s fx rate and keeps its own currency figure', () => {
    const e = receipt('r', 'alice', 100, [makeLine('a', 40), makeLine('b', 60)], [makeClaim('a', 'bob', 1, 40)], { currency: 'EUR', fx_rate: 0.5 })
    const r = computeBalances([e], [], ['alice', 'bob'], 'GBP')
    expect(r.receipts[0]).toMatchObject({ unclaimedMinor: 3000, unclaimedOwnMinor: 6000, currency: 'EUR', totalMinor: 5000 })
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
  })

  it('JPY receipts: zero-decimal unclaimed value', () => {
    const e = receipt('r', 'alice', 9000, [makeLine('a', 3000), makeLine('b', 6000)], [makeClaim('a', 'bob', 1, 3000)], { currency: 'JPY' })
    const r = computeBalances([e], [], ['alice', 'bob'], 'JPY')
    expect(r.unclaimedReceipts[0].unclaimedMinor).toBe(6000)
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
  })

  it('a receipt with no rate stays excluded (not in receipts, not pending)', () => {
    const e = receipt('r', 'alice', 100, [makeLine('a', 100)], [], { currency: 'EUR', fx_rate: null })
    const r = computeBalances([e], [], ['alice', 'bob'], 'GBP')
    expect(r.receipts).toEqual([])
    expect(r.expensesMissingRate).toEqual(['r'])
  })

  it('exposes the claim code and sorts unclaimed receipts largest first', () => {
    const small = receipt('s', 'alice', 10, [makeLine('a', 10)], [], { allocation_link: { code: 'abc' } as never })
    const big = receipt('b', 'bob', 50, [makeLine('a', 50)], [])
    const r = computeBalances([small, big], [], ['alice', 'bob'], 'GBP')
    expect(r.unclaimedReceipts.map((x) => x.expenseId)).toEqual(['b', 's'])
    expect(r.unclaimedReceipts[1].claimCode).toBe('abc')
    expect(findUnclaimedReceipts([small, big], 'GBP').map((x) => x.expenseId)).toEqual(['b', 's'])
  })

  it('property: for random receipts (any claims, any rounding) the ledger sums to exactly zero', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const people = ['p0', 'p1', 'p2', 'p3', 'p4']
    for (let n = 0; n < 300; n++) {
      const cur = rnd() < 0.2 ? 'JPY' : 'GBP'
      const exp = cur === 'JPY' ? 0 : 2
      const lines: Line[] = []
      const claims: Claim[] = []
      let total = 0
      const lineCount = 1 + Math.floor(rnd() * 6)
      for (let l = 0; l < lineCount; l++) {
        const qty = 1 + Math.floor(rnd() * 3)
        const t = Math.round((1 + rnd() * 80) * 10 ** exp) / 10 ** exp
        total += t
        lines.push(makeLine(`l${l}`, t, qty))
        let left = qty
        const takers = Math.floor(rnd() * 4)
        for (let k = 0; k < takers && left > 0.001; k++) {
          const q = rnd() < 0.5 ? Math.min(left, 1) : Math.round(Math.min(left, rnd() * left + 0.01) * 100) / 100
          left -= q
          const owed = Math.round(((t / qty) * q + (rnd() - 0.5) * 0.02) * 10 ** exp) / 10 ** exp // deliberate per-claim rounding noise
          claims.push(makeClaim(`l${l}`, people[Math.floor(rnd() * 5)], q, Math.max(0, owed), rnd() < 0.2 ? 'leftover' : undefined, rnd() < 0.2 ? { quantity: q, amount: Math.max(0, owed) } : undefined))
        }
      }
      total = Math.round(total * 10 ** exp) / 10 ** exp
      const payer = people[Math.floor(rnd() * 5)]
      const rate = cur === 'JPY' ? 0.0052 : 1
      const e = receipt(`e${n}`, payer, total, lines, claims, { currency: cur, fx_rate: rate })
      const r = computeBalances([e], [], people, 'GBP')
      expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
      const st = r.receipts[0]
      expect(st.unclaimedMinor + st.dustMinor).toBe(st.pendingMinor)
      expect(st.unclaimedMinor).toBeGreaterThanOrEqual(0)
    }
  })

  it('no regression: fully claimed receipts (Sicily-shaped GBP/EUR, Meribel-shaped shared halves) match the previous implementation exactly', () => {
    const ids = ['tim', 'ana', 'bo', 'cy', 'di', 'ed', 'flo', 'gus', 'hal']
    // Sicily-shaped: GBP trip, EUR receipts at 0.8, whole-unit claims across a few payers.
    const sicily = [
      receipt('s1', 'tim', 240, [makeLine('a', 80), makeLine('b', 120), makeLine('c', 40)], [makeClaim('a', 'ana', 1, 80), makeClaim('b', 'tim', 1, 120), makeClaim('c', 'bo', 1, 40)], { currency: 'EUR', fx_rate: 0.8 }),
      receipt('s2', 'ana', 60, [makeLine('a', 60, 3)], [makeClaim('a', 'ana', 1, 20), makeClaim('a', 'tim', 1, 20), makeClaim('a', 'cy', 1, 20)], { currency: 'EUR', fx_rate: 0.8 }),
      makeExpense({ id: 'plain', amount: 90, paid_by: 'bo', splits: [makeSplit('tim', 30), makeSplit('ana', 30), makeSplit('bo', 30)] }),
    ]
    // Meribel-shaped: EUR trip, 9 people, shared halves (0.5 claims) and a table item.
    const meribel = [
      receipt('m1', 'hal', 180, [makeLine('fondue', 120, 2), makeLine('wine', 60)], [
        makeClaim('fondue', 'tim', 1, 60), makeClaim('fondue', 'ana', 0.5, 30), makeClaim('fondue', 'bo', 0.5, 30),
        makeClaim('wine', 'cy', 0.5, 30, 'shared'), makeClaim('wine', 'di', 0.5, 30, 'shared'),
      ], { currency: 'EUR' }),
      receipt('m2', 'gus', 90, [makeLine('bread', 90)], ids.map((u) => makeClaim('bread', u, 1 / 9, 10, 'table')), { currency: 'EUR' }),
    ]
    for (const [exps, base] of [[sicily, 'GBP'], [meribel, 'EUR']] as const) {
      const legacy = legacyNet(exps, ids, base)
      const now = computeBalances(exps, [], ids, base)
      for (const b of now.balances) {
        expect(b.totalPaidMinor).toBe(legacy.get(b.userId)!.paid)
        expect(b.totalOwedMinor).toBe(legacy.get(b.userId)!.owed)
        expect(b.pendingUnclaimedMinor).toBe(0)
      }
      expect(now.unclaimedReceipts).toEqual([])
    }
  })

  it('claimers owe exactly what they owed before even when a receipt has unclaimed value; only the payer\'s credit changes', () => {
    const e = receipt('r', 'alice', 100, [makeLine('a', 40), makeLine('b', 60)], [makeClaim('a', 'bob', 1, 40)])
    const legacy = legacyNet([e], ['alice', 'bob'], 'GBP')
    const now = computeBalances([e], [], ['alice', 'bob'], 'GBP')
    expect(now.balances.find((b) => b.userId === 'bob')!.totalOwedMinor).toBe(legacy.get('bob')!.owed)
    // alice's net used to be 100 (more than anyone owes her); now it is exactly what bob owes.
    expect(now.balances.find((b) => b.userId === 'alice')!.netBalanceMinor).toBe(4000)
  })
})

describe('legacy rounding dust is never "unclaimed"', () => {
  const ids = (n: string[]) => ['alice', ...n]
  function expectQuiet(e: ExpenseWithDetails, people: string[], base: string) {
    const r = computeBalances([e], [], people, base)
    expect(r.unclaimedReceipts).toEqual([])
    expect(findUnclaimedReceipts([e], base)).toEqual([])
    expect(findFreezeBlockingReceipts([e], base)).toEqual([])
    expect(r.receipts[0].unclaimedMinor).toBe(0)
    expect(r.receipts[0].unclaimedOwnMinor).toBe(0)
    expect(r.balances.reduce((s, b) => s + b.netBalanceMinor, 0)).toBe(0)
    return r
  }

  it('0.33 x 3 on a GBP 10 line (up to 10p of dust, about 1% of the line)', () => {
    const e = receipt('r', 'alice', 10, [makeLine('l', 10)], [makeClaim('l', 'a', 0.33, 3.3), makeClaim('l', 'b', 0.33, 3.3), makeClaim('l', 'c', 0.33, 3.3)])
    const r = expectQuiet(e, ids(['a', 'b', 'c']), 'GBP')
    expect(r.receipts[0].dustMinor).toBe(10)
  })

  it('0.5 + 0.5 and 0.2 x 5 with per-claim rounding', () => {
    expectQuiet(receipt('r', 'alice', 9.99, [makeLine('l', 9.99)], [makeClaim('l', 'a', 0.5, 5), makeClaim('l', 'b', 0.5, 5)]), ids(['a', 'b']), 'GBP') // 1p over
    const five = ['a', 'b', 'c', 'd', 'e'].map((u) => makeClaim('l', u, 0.2, 1.99))
    expectQuiet(receipt('r', 'alice', 9.97, [makeLine('l', 9.97)], five), ids(['a', 'b', 'c', 'd', 'e']), 'GBP') // 2p short
  })

  it('a 7-way split in JPY (six pieces short each)', () => {
    const users = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const claims = users.map((u, i) => makeClaim('l', u, i === 6 ? 0.16 : 0.14, 142))
    const e = receipt('r', 'alice', 1000, [makeLine('l', 1000)], claims, { currency: 'JPY' })
    const r = expectQuiet(e, ids(users), 'JPY')
    expect(r.receipts[0].dustMinor).toBe(6)
  })

  it('a row with a leftover part counts in full (own + leftover in ONE row), and is still dust-free', () => {
    const e = receipt('r', 'alice', 10, [makeLine('l', 10)], [makeClaim('l', 'a', 0.66, 6.6, 'self', { quantity: 0.33, amount: 3.3 }), makeClaim('l', 'b', 0.33, 3.3)])
    const r = expectQuiet(e, ids(['a', 'b']), 'GBP')
    expect(r.balances.find((b) => b.userId === 'a')!.totalOwedMinor).toBe(660)
    expect(r.receipts[0].leftoverClaimedMinor).toBe(330)
  })

  it('own parts and the dust-tolerant status', () => {
    const row = { quantity_claimed: 1.34, amount_owed: 13.34, leftover_quantity: 0.34, leftover_amount: 3.34 }
    expect([claimOwnQuantity(row), claimOwnAmount(row), claimLeftoverQuantity(row), claimLeftoverAmount(row), hasOwnClaim(row)]).toEqual([1, 10, 0.34, 3.34, true])
    const pure = { quantity_claimed: 0.33, amount_owed: 3.33, leftover_quantity: 0.33, leftover_amount: 3.33 }
    expect(hasOwnClaim(pure)).toBe(false)
    // columns absent (front end before the migration): the whole row is the person's own
    expect([claimOwnQuantity({ quantity_claimed: 2 }), hasOwnClaim({ quantity_claimed: 2 })]).toEqual([2, true])
    const lines = [{ id: 'a', quantity: 1, total_amount: 10 }, { id: 'z', quantity: 1, total_amount: 0 }]
    expect(allLinesClaimedWithinDust(lines, [{ line_item_id: 'a', quantity_claimed: 0.99 }])).toBe(true) // 0.33 x 3 style dust; the zero-total line is ignored
    expect(allLinesClaimedWithinDust(lines, [{ line_item_id: 'a', quantity_claimed: 0.9 }])).toBe(false)
    expect(allLinesClaimedWithinDust(lines, [])).toBe(false)
  })

  it('real unclaimed quantity still counts, and so does a large amount gap on a fully claimed line', () => {
    const half = receipt('r', 'alice', 10, [makeLine('l', 10)], [makeClaim('l', 'a', 0.5, 5)])
    expect(findFreezeBlockingReceipts([half], 'GBP')).toHaveLength(1)
    expect(findUnclaimedReceipts([half], 'GBP')[0].unclaimedOwnMinor).toBe(500)
    const edited = receipt('r', 'alice', 10, [makeLine('l', 10)], [makeClaim('l', 'a', 1, 7)])
    expect(findFreezeBlockingReceipts([edited], 'GBP')).toHaveLength(1)
  })

  it('isLineReallyUnclaimed is the one rule', () => {
    expect(isLineReallyUnclaimed(1, 0.99, 10, 3, 1000)).toBe(false)
    expect(isLineReallyUnclaimed(1, 0.98, 20, 3, 1000)).toBe(true)
    expect(isLineReallyUnclaimed(1, 1, 0, 1, 1000)).toBe(false)
  })
})

// The same cases run against the Postgres guard (_trip_unclaimed_receipts) in the receipts pglite script: client and server must agree.
import parityCases from './unclaimedParityCases.json'

describe('freeze blocking agrees with the server guard (shared cases)', () => {
  for (const c of parityCases.cases) {
    it(c.name, () => {
      const lines = c.lines.map((l, i) => makeLine(`l${i}`, l[1] as number, l[0] as number))
      const claims = c.lines.flatMap((l, i) => (l[2] as number[][]).map(([q, a], k) => makeClaim(`l${i}`, `u${k}`, q, a)))
      const e = receipt('r', 'alice', c.amount, lines, claims, { currency: c.currency, fx_rate: c.fx })
      const blocking = findFreezeBlockingReceipts([e], c.base)
      const got = blocking.length === 0 ? 0 : blocking[0].unclaimedOwnMinor
      expect(got).toBe(c.blockedOwnMinor)
    })
  }
})
