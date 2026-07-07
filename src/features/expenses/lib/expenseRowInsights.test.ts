import { describe, it, expect } from 'vitest'
import {
  computeLiableUserIds,
  buildExpenseMetaSentence,
  computeExpenseStake,
  computeDayGroupSummary,
  classifyDayLabel,
  isPastDate,
} from './expenseRowInsights'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

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

function makeClaim(userId: string, amountOwed: number) {
  return {
    id: `claim-${userId}-${Math.random()}`,
    expense_id: 'exp',
    line_item_id: 'li1',
    user_id: userId,
    quantity_claimed: 1,
    amount_owed: amountOwed,
    confirmed: true,
    claimed_at: null,
    updated_at: null,
    user: {} as never,
  }
}

describe('computeLiableUserIds', () => {
  it('uses splits (deduped) for a normal expense', () => {
    const e = makeExpense({ id: 'e1', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] })
    expect(computeLiableUserIds(e)).toEqual(['alice', 'bob'])
  })

  it('uses claims (deduped), not participant_ids, for an itemized expense', () => {
    const e = makeExpense({
      id: 'e1',
      ai_parsed: true,
      status: 'allocated',
      participant_ids: ['alice', 'bob', 'carol'], // tagged, but carol hasn't claimed
      line_items: [{ id: 'li1' } as never],
      claims: [makeClaim('alice', 10), makeClaim('bob', 20), makeClaim('alice', 5)],
    })
    expect(computeLiableUserIds(e)).toEqual(['alice', 'bob'])
  })

  it('returns an empty array for an itemized expense with no claims yet', () => {
    const e = makeExpense({ id: 'e1', ai_parsed: true, status: 'allocated', line_items: [{ id: 'li1' } as never], claims: [] })
    expect(computeLiableUserIds(e)).toEqual([])
  })
})

describe('buildExpenseMetaSentence', () => {
  it('"You paid · split N ways" when the viewer paid and shares with others', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alice',
      payerId: 'alice',
      viewerId: 'alice',
      liableUserIds: ['alice', 'bob', 'carol', 'dave'],
      isItemized: false,
    })
    expect(s).toBe('You paid · split 4 ways')
  })

  it('"You paid · just for you" when the viewer paid and is the only liable party', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alice',
      payerId: 'alice',
      viewerId: 'alice',
      liableUserIds: ['alice'],
      isItemized: false,
    })
    expect(s).toBe('You paid · just for you')
  })

  it('"Alex paid · split with you +2" when someone else paid and the viewer shares the bill', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alex',
      payerId: 'alex',
      viewerId: 'you',
      liableUserIds: ['alex', 'you', 'bob'],
      isItemized: false,
    })
    expect(s).toBe('Alex paid · split with you +2')
  })

  it('"Alex paid · split with you +1" for a straight two-way split (payer + viewer)', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alex',
      payerId: 'alex',
      viewerId: 'you',
      liableUserIds: ['alex', 'you'],
      isItemized: false,
    })
    expect(s).toBe('Alex paid · split with you +1')
  })

  it('"Alex paid · split with you" when the viewer is the only OTHER liable party (payer excluded from splits)', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alex',
      payerId: 'alex',
      viewerId: 'you',
      liableUserIds: ['you'],
      isItemized: false,
    })
    expect(s).toBe('Alex paid · split with you')
  })

  it('"Sarah paid · you\'re not in this" when the viewer has no split on a normal expense', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Sarah',
      payerId: 'sarah',
      viewerId: 'you',
      liableUserIds: ['sarah', 'bob'],
      isItemized: false,
    })
    expect(s).toBe("Sarah paid · you're not in this")
  })

  it('itemized: tagged-but-unclaimed viewer reads as "you haven\'t claimed yet", not "not in this"', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Sarah',
      payerId: 'sarah',
      viewerId: 'you',
      liableUserIds: ['bob'], // someone else has claimed already
      isItemized: true,
      taggedUserIds: ['you', 'bob'],
    })
    expect(s).toBe("Sarah paid · you haven't claimed yet")
  })

  it('itemized: nobody has claimed anything yet reads as "not claimed yet"', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Sarah',
      payerId: 'sarah',
      viewerId: 'you',
      liableUserIds: [],
      isItemized: true,
      taggedUserIds: ['bob'], // viewer isn't even tagged
    })
    expect(s).toBe('Sarah paid · not claimed yet')
  })

  it('itemized: a truly uninvolved viewer (not tagged, others have claimed) still reads as "not in this"', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Sarah',
      payerId: 'sarah',
      viewerId: 'you',
      liableUserIds: ['bob'],
      isItemized: true,
      taggedUserIds: ['bob'],
    })
    expect(s).toBe("Sarah paid · you're not in this")
  })

  it('falls back to third-person copy when there is no viewer at all (e.g. logged-out preview)', () => {
    const s = buildExpenseMetaSentence({
      payerName: 'Alex',
      payerId: 'alex',
      viewerId: undefined,
      liableUserIds: ['alex', 'bob'],
      isItemized: false,
    })
    expect(s).toBe("Alex paid · you're not in this")
  })
})

describe('computeExpenseStake', () => {
  it('returns null/uninvolved when there is no viewer', () => {
    const e = makeExpense({ id: 'e1', splits: [makeSplit('alice', 100)] })
    expect(computeExpenseStake(e, undefined)).toEqual({ kind: null, involved: false })
  })

  it('"you\'re owed" when the viewer paid and others owe a share', () => {
    const e = makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] })
    const stake = computeExpenseStake(e, 'alice')
    expect(stake).toEqual({ kind: 'owed', amountMinor: 5000, currency: 'GBP', involved: true })
  })

  it('"you owe" when the viewer has a split and did not pay', () => {
    const e = makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 50), makeSplit('bob', 50)] })
    const stake = computeExpenseStake(e, 'bob')
    expect(stake).toEqual({ kind: 'owe', amountMinor: 5000, currency: 'GBP', involved: true })
  })

  it('uninvolved (muted) when the viewer has no split and did not pay', () => {
    const e = makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 100)] })
    expect(computeExpenseStake(e, 'carol')).toEqual({ kind: null, involved: false })
  })

  it('involved but no stake when the viewer paid and covered only their own share', () => {
    const e = makeExpense({ id: 'e1', amount: 100, paid_by: 'alice', splits: [makeSplit('alice', 100)] })
    expect(computeExpenseStake(e, 'alice')).toEqual({ kind: null, involved: true })
  })

  it('itemized: "you owe" uses the claim amount, not a split', () => {
    const e = makeExpense({
      id: 'e1',
      amount: 100,
      currency: 'GBP',
      paid_by: 'alice',
      ai_parsed: true,
      status: 'allocated',
      line_items: [{ id: 'li1' } as never],
      claims: [makeClaim('bob', 30)],
    })
    expect(computeExpenseStake(e, 'bob')).toEqual({ kind: 'owe', amountMinor: 3000, currency: 'GBP', involved: true })
  })

  it('itemized: "you\'re owed" sums every other claimant when the viewer paid', () => {
    const e = makeExpense({
      id: 'e1',
      amount: 100,
      currency: 'GBP',
      paid_by: 'alice',
      ai_parsed: true,
      status: 'allocated',
      line_items: [{ id: 'li1' } as never],
      claims: [makeClaim('bob', 30), makeClaim('carol', 20), makeClaim('alice', 10)],
    })
    expect(computeExpenseStake(e, 'alice')).toEqual({ kind: 'owed', amountMinor: 5000, currency: 'GBP', involved: true })
  })

  it('itemized: "claim" when the viewer is tagged (participant_ids) but has not claimed', () => {
    const e = makeExpense({
      id: 'e1',
      ai_parsed: true,
      status: 'allocated',
      participant_ids: ['alice', 'bob'],
      line_items: [{ id: 'li1' } as never],
      claims: [],
      paid_by: 'alice',
    })
    expect(computeExpenseStake(e, 'bob')).toEqual({ kind: 'claim', involved: true })
  })

  it('itemized: uninvolved when the viewer is neither tagged nor claimed', () => {
    const e = makeExpense({
      id: 'e1',
      ai_parsed: true,
      status: 'allocated',
      participant_ids: ['alice', 'bob'],
      line_items: [{ id: 'li1' } as never],
      claims: [makeClaim('bob', 100)],
      paid_by: 'alice',
    })
    expect(computeExpenseStake(e, 'carol')).toEqual({ kind: null, involved: false })
  })
})

describe('computeDayGroupSummary', () => {
  it('sums same-currency expenses and counts them', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, currency: 'GBP', splits: [makeSplit('alice', 100)] }),
      makeExpense({ id: 'e2', amount: 40, currency: 'GBP', splits: [makeSplit('alice', 40)] }),
    ]
    const summary = computeDayGroupSummary(expenses, 'GBP')
    expect(summary).toEqual({ count: 2, totalMinor: 14000, currency: 'GBP', hasMissingRate: false })
  })

  it('converts a foreign-currency expense via its fx_rate', () => {
    const expenses = [makeExpense({ id: 'e1', amount: 1000, currency: 'JPY', fx_rate: 0.005, splits: [makeSplit('alice', 1000)] })]
    const summary = computeDayGroupSummary(expenses, 'GBP')
    expect(summary.totalMinor).toBe(500) // 1000 JPY * 0.005 = 5.00 GBP
  })

  it('flags a missing-rate expense and excludes it from the total rather than zeroing it silently', () => {
    const expenses = [
      makeExpense({ id: 'e1', amount: 100, currency: 'GBP', splits: [makeSplit('alice', 100)] }),
      makeExpense({ id: 'e2', amount: 50, currency: 'USD', fx_rate: null, splits: [makeSplit('alice', 50)] }),
    ]
    const summary = computeDayGroupSummary(expenses, 'GBP')
    expect(summary.totalMinor).toBe(10000)
    expect(summary.hasMissingRate).toBe(true)
    expect(summary.count).toBe(2) // count still reflects every expense in the day
  })
})

describe('classifyDayLabel', () => {
  it('classifies a date before the trip as pre-trip', () => {
    expect(classifyDayLabel('2026-07-28', '2026-08-01', '2026-08-10')).toBe('pre-trip')
  })

  it('classifies a date after the trip as post-trip', () => {
    expect(classifyDayLabel('2026-08-15', '2026-08-01', '2026-08-10')).toBe('post-trip')
  })

  it('classifies the start/end boundary days (inclusive) as in-trip', () => {
    expect(classifyDayLabel('2026-08-01', '2026-08-01', '2026-08-10')).toBe('in-trip')
    expect(classifyDayLabel('2026-08-10', '2026-08-01', '2026-08-10')).toBe('in-trip')
  })
})

describe('isPastDate', () => {
  it('is true for a date strictly before today', () => {
    expect(isPastDate('2026-07-06', '2026-07-07')).toBe(true)
  })

  it('is false for today itself and future dates', () => {
    expect(isPastDate('2026-07-07', '2026-07-07')).toBe(false)
    expect(isPastDate('2026-07-08', '2026-07-07')).toBe(false)
  })
})
