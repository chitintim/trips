import { describe, it, expect } from 'vitest'
import {
  computeMoneyPosition,
  computePairwiseBreakdown,
  computePairwiseLedger,
  mergeSettlementsWithUsableCarryovers,
} from './moneyPosition'
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

  it('correctly zeroes out a pair when the CURRENT USER is the one who paid a real settlement (regression: this branch previously doubled the debt instead of clearing it)', () => {
    // Bob paid £100 for a hotel, split equally -> Alice owes Bob £50.
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'bob', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // Alice pays Bob back £50 (a REAL settlement where the current user,
    // Alice, is the payer -- from_user_id).
    const settlements = [makeSettlement({ from_user_id: 'alice', to_user_id: 'bob', amount: 50, status: 'confirmed' })]
    const pos = computeMoneyPosition(expenses, settlements, ['alice', 'bob'], 'alice', 'GBP')
    expect(pos.kind).toBe('settled')
    expect(pos.perPerson).toEqual([]) // NOT [{ userId: 'bob', netMinor: -10000 }] (the pre-fix doubled-debt bug)
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

  it('folds an already-folded carryover into the headline AND the per-person breakdown consistently', () => {
    // Alice and Bob are otherwise perfectly settled on this trip.
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 25 })]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP', carryovers)
    expect(pos.kind).toBe('owed')
    expect(pos.amount).toBe(25)
    expect(pos.perPerson).toEqual([{ userId: 'bob', netMinor: 2500 }])
  })

  it('excludes a mismatched-currency carryover from BOTH the headline and the per-person breakdown (never mixes minor units 1:1)', () => {
    // Alice and Bob perfectly settled on this GBP trip; a bad historical
    // JPY 10,000 carryover row exists. Reading its minor units as pence
    // would show a phantom £100 (real value ~£52) -- it must contribute
    // nothing anywhere, consistently across headline and breakdown.
    const expenses = [
      makeExpense({ id: 'e1', amount: 60, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      makeExpense({ id: 'e2', amount: 60, paid_by: 'bob', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
    ]
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 10000, currency: 'JPY' })]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP', carryovers)
    expect(pos.kind).toBe('settled')
    expect(pos.amount).toBe(0)
    expect(pos.perPerson).toEqual([])
  })

  it('excludes a carryover involving a departed participant from BOTH the headline and the breakdown (zero-sum guard)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] }),
    ]
    // 'charlie' is not in the participant list -- applying only Alice's side
    // of this row would break zero-sum and desync header vs suggestions.
    const carryovers = [makeCarryover({ from_user_id: 'charlie', to_user_id: 'alice', amount: 40 })]
    const pos = computeMoneyPosition(expenses, [], ['alice', 'bob'], 'alice', 'GBP', carryovers)
    expect(pos.kind).toBe('owed')
    expect(pos.amount).toBe(50) // baseline only -- the charlie row contributes nothing
    expect(pos.perPerson).toEqual([{ userId: 'bob', netMinor: 5000 }])
  })
})

describe('computePairwiseBreakdown', () => {
  it('gives DIFFERENT correct pairwise amounts per counterparty, not the same group-level net repeated (bug fix regression)', () => {
    // Alice paid £90 total, itemized: Bob claimed £30, Charlie claimed £60.
    // Alice's GROUP-level net is +£90 -- the OLD buggy carryover code
    // offered that full £90 against BOTH Bob and Charlie. The pairwise
    // breakdown must instead show £30 vs Bob and £60 vs Charlie.
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 90,
        currency: 'GBP',
        paid_by: 'alice',
        ai_parsed: true,
        status: 'allocated',
        line_items: [
          {
            id: 'li1',
            expense_id: 'e1',
            line_number: 1,
            name_original: 'Dinner',
            name_english: null,
            quantity: 1,
            unit_price: 90,
            subtotal: 90,
            tax_amount: null,
            service_amount: null,
            line_discount_amount: null,
            line_discount_percent: null,
            total_amount: 90,
            notes: null,
            created_at: null,
          },
        ],
        claims: [
          { id: 'c1', expense_id: 'e1', line_item_id: 'li1', user_id: 'bob', quantity_claimed: 1, amount_owed: 30, confirmed: true, claimed_at: null, updated_at: null, user: {} as never },
          { id: 'c2', expense_id: 'e1', line_item_id: 'li1', user_id: 'charlie', quantity_claimed: 1, amount_owed: 60, confirmed: true, claimed_at: null, updated_at: null, user: {} as never },
        ],
        splits: [], // itemized expenses carry no split rows
      }),
    ]
    const breakdown = computePairwiseBreakdown(expenses, [], ['alice', 'bob', 'charlie'], 'alice', 'GBP')
    const bob = breakdown.find((r) => r.userId === 'bob')!
    const charlie = breakdown.find((r) => r.userId === 'charlie')!
    expect(bob.netMinor).toBe(3000) // exactly £30, not Alice's full £90 group net
    expect(charlie.netMinor).toBe(6000) // exactly £60, not Alice's full £90 group net
    expect(bob.netMinor + charlie.netMinor).toBe(9000) // still sums to the group total
  })

  it('debits itemized claimants (not just credits the payer) in the pairwise computation -- mirrors computeBalances', () => {
    const expenses = [
      makeExpense({
        id: 'e1',
        amount: 100,
        currency: 'GBP',
        paid_by: 'alice',
        ai_parsed: true,
        status: 'allocated',
        line_items: [
          { id: 'li1', expense_id: 'e1', line_number: 1, name_original: 'Item', name_english: null, quantity: 1, unit_price: 100, subtotal: 100, tax_amount: null, service_amount: null, line_discount_amount: null, line_discount_percent: null, total_amount: 100, notes: null, created_at: null },
        ],
        claims: [
          { id: 'c1', expense_id: 'e1', line_item_id: 'li1', user_id: 'bob', quantity_claimed: 1, amount_owed: 100, confirmed: true, claimed_at: null, updated_at: null, user: {} as never },
        ],
        splits: [],
      }),
    ]
    const breakdown = computePairwiseBreakdown(expenses, [], ['alice', 'bob'], 'alice', 'GBP')
    const bob = breakdown.find((r) => r.userId === 'bob')!
    // Bob is correctly DEBITED £100 against Alice -- not left at 0 the way
    // the pre-fix stubbed-claims path would (payer credited, nobody debited).
    expect(bob.netMinor).toBe(10000)
  })
})

describe('computePairwiseLedger', () => {
  it('lists the expense shares composing a pairwise balance, one signed entry per expense', () => {
    const expenses = [
      // Alice paid dinner: Bob's share raises what Bob owes Alice (+£30).
      makeExpense({ id: 'e1', description: 'Dinner', amount: 60, payment_date: '2026-08-02', paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30)] }),
      // Bob paid the taxi: Alice's share lowers it (−£10).
      makeExpense({ id: 'e2', description: 'Taxi', amount: 20, payment_date: '2026-08-03', paid_by: 'bob', splits: [makeSplit('alice', 10), makeSplit('bob', 10)] }),
      // Carol paid something -- not between the pair, never appears.
      makeExpense({ id: 'e3', description: 'Gelato', amount: 15, payment_date: '2026-08-03', paid_by: 'carol', splits: [makeSplit('alice', 5), makeSplit('bob', 5), makeSplit('carol', 5)] }),
    ]
    const ledger = computePairwiseLedger(expenses, [], 'alice', 'bob', 'GBP')
    expect(ledger.map((e) => e.id)).toEqual(['e2', 'e1']) // newest first
    expect(ledger.find((e) => e.id === 'e1')).toMatchObject({ kind: 'expense', label: 'Dinner', amountMinor: 3000, pending: false })
    expect(ledger.find((e) => e.id === 'e2')).toMatchObject({ kind: 'expense', label: 'Taxi', amountMinor: -1000, pending: false })
  })

  it('includes P2P payments between the pair with the note, signed from the current user\'s perspective', () => {
    const settlements = [
      makeSettlement({ id: 's1', from_user_id: 'bob', to_user_id: 'alice', amount: 1000, notes: 'Pre-payment', settled_at: '2026-07-01T00:00:00Z' }),
      makeSettlement({ id: 's2', from_user_id: 'alice', to_user_id: 'bob', amount: 40, settled_at: '2026-08-11T00:00:00Z' }),
      makeSettlement({ id: 's3', from_user_id: 'bob', to_user_id: 'carol', amount: 5 }), // not this pair
    ]
    const ledger = computePairwiseLedger([], settlements, 'alice', 'bob', 'GBP')
    expect(ledger.map((e) => e.id)).toEqual(['s2', 's1'])
    // Bob paid Alice £1000 -> lowers what Bob owes Alice (Alice received).
    expect(ledger.find((e) => e.id === 's1')).toMatchObject({ kind: 'payment', amountMinor: -100000, note: 'Pre-payment', date: '2026-07-01' })
    // Alice paid Bob £40 -> raises Alice's net vs Bob.
    expect(ledger.find((e) => e.id === 's2')).toMatchObject({ kind: 'payment', amountMinor: 4000, note: null })
  })

  it('shows marked_paid payments as PENDING and excludes suggested rows entirely', () => {
    const settlements = [
      makeSettlement({ id: 's1', from_user_id: 'bob', to_user_id: 'alice', amount: 20, status: 'marked_paid' }),
      makeSettlement({ id: 's2', from_user_id: 'bob', to_user_id: 'alice', amount: 20, status: 'suggested' }),
    ]
    const ledger = computePairwiseLedger([], settlements, 'alice', 'bob', 'GBP')
    expect(ledger.map((e) => e.id)).toEqual(['s1'])
    expect(ledger[0].pending).toBe(true)
  })

  it('INVARIANT: non-pending entries sum exactly to the pair\'s computePairwiseBreakdown net', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 90, paid_by: 'alice', splits: [makeSplit('alice', 30), makeSplit('bob', 30), makeSplit('carol', 30)] }),
      makeExpense({ id: 'e2', amount: 40, paid_by: 'bob', splits: [makeSplit('alice', 20), makeSplit('bob', 20)] }),
    ]
    const settlements = [
      makeSettlement({ id: 's1', from_user_id: 'bob', to_user_id: 'alice', amount: 5, status: 'confirmed' }),
      makeSettlement({ id: 's2', from_user_id: 'bob', to_user_id: 'alice', amount: 3, status: 'marked_paid' }), // pending: in neither sum
    ]
    const breakdown = computePairwiseBreakdown(expenses, settlements, ['alice', 'bob', 'carol'], 'alice', 'GBP')
    const bobNet = breakdown.find((r) => r.userId === 'bob')!.netMinor
    const ledger = computePairwiseLedger(expenses, settlements, 'alice', 'bob', 'GBP')
    const ledgerSum = ledger.filter((e) => !e.pending).reduce((sum, e) => sum + e.amountMinor, 0)
    expect(ledgerSum).toBe(bobNet)
    expect(bobNet).toBe(3000 - 2000 - 500) // Bob's dinner share − Alice's taxi share − Bob's £5 payment
  })

  it('labels folded carryover pseudo-settlements as kind "carryover"', () => {
    const carryovers = [makeCarryover({ from_user_id: 'bob', to_user_id: 'alice', amount: 25 })]
    const merged = mergeSettlementsWithUsableCarryovers([], carryovers, 'GBP', ['alice', 'bob'])
    const ledger = computePairwiseLedger([], merged, 'alice', 'bob', 'GBP')
    expect(ledger).toHaveLength(1)
    expect(ledger[0].kind).toBe('carryover')
    // Bob owed Alice £25 from the previous trip -> raises Bob's debt to Alice.
    expect(ledger[0].amountMinor).toBe(2500)
    expect(ledger[0].pending).toBe(false)
  })

  it('skips expenses missing an FX rate (excluded from balances, so excluded from the composition too)', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 5000, currency: 'JPY', fx_rate: null, paid_by: 'alice', splits: [makeSplit('bob', 5000)] }),
    ]
    expect(computePairwiseLedger(expenses, [], 'alice', 'bob', 'GBP')).toEqual([])
  })

  it('returns [] with no current user', () => {
    expect(computePairwiseLedger([], [makeSettlement({ from_user_id: 'a', to_user_id: 'b', amount: 1 })], undefined, 'b', 'GBP')).toEqual([])
  })
})
