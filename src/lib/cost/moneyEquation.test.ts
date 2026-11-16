import { describe, it, expect } from 'vitest'
import { explainMoneyPosition } from './moneyEquation'
import { computeMoneyPosition } from '../../features/expenses/money-space/moneyPosition'
import type { ExpenseWithDetails } from '../queries/useExpenses'
import type { Settlement } from '../queries/useSettlements'
import type { SettlementCarryover } from '../queries/useSettlements'

// Sicily-shaped fixture: I fronted the villa and cars (£11,563.80), my share of the
// trip is £5,719.28, and others have already paid me back £10,543.13 -> I owe £4,698.61.
const ME = 'me'
const ALEX = 'alex'
const BEN = 'ben'
const NAMES = { [ME]: 'Tim', [ALEX]: 'Alex', [BEN]: 'Ben' }
const PEOPLE = [ME, ALEX, BEN]

const villa = {
  id: 'villa',
  trip_id: 't',
  description: 'Villa and cars',
  amount: 11563.8,
  currency: 'GBP',
  fx_rate: null,
  paid_by: ME,
  payment_date: '2026-09-01',
  ai_parsed: false,
  status: null,
  line_items: [],
  claims: [],
  splits: [
    { user_id: ME, amount: 5719.28 },
    { user_id: ALEX, amount: 3000 },
    { user_id: BEN, amount: 2844.52 },
  ],
} as unknown as ExpenseWithDetails

function pay(id: string, from: string, to: string, amount: number, status: string): Settlement {
  return { id, trip_id: 't', from_user_id: from, to_user_id: to, amount, status, currency: 'GBP', settled_at: '2026-09-10T00:00:00Z', created_at: '2026-09-10T00:00:00Z', notes: null, payment_method: null, created_by: from } as unknown as Settlement
}

const confirmedBack = [pay('r1', ALEX, ME, 5000, 'confirmed'), pay('r2', BEN, ME, 5543.13, 'confirmed')]

function explain(settlements: Settlement[]) {
  return explainMoneyPosition({ expenses: [villa], settlements, participantUserIds: PEOPLE, currentUserId: ME, baseCurrency: 'GBP', names: NAMES })
}

describe('explainMoneyPosition: Sicily', () => {
  it('spells the arithmetic out', () => {
    const eq = explain(confirmedBack)
    expect(eq.paid).toBe(11563.8)
    expect(eq.share).toBe(5719.28)
    expect(eq.receivedConfirmed).toBe(10543.13)
    expect(eq.sentConfirmed).toBe(0)
    expect(eq.net).toBe(-4698.61)
    expect(eq.kind).toBe('owe')
    expect(eq.terms.map((t) => [t.key, t.sign, t.amount])).toEqual([
      ['paid', '+', 11563.8],
      ['share', '−', 5719.28],
      ['received', '−', 10543.13],
    ])
    expect(eq.equationText).toBe('You paid £11,563.80 − your share £5,719.28 − paid back to you £10,543.13 = you owe £4,698.61')
    expect(eq.headline).toEqual({ kind: 'owe', amount: 4698.61, text: 'You owe £4,698.61', note: null })
  })

  it('agrees with the existing money position headline', () => {
    const pos = computeMoneyPosition([villa], confirmedBack, PEOPLE, ME, 'GBP')
    const eq = explain(confirmedBack)
    expect(eq.kind).toBe(pos.kind)
    expect(eq.ledgerAmount).toBe(pos.amount)
  })

  it('money already marked paid is NOT in the "You owe" headline', () => {
    const eq = explain([...confirmedBack, pay('p1', ME, ALEX, 2000, 'marked_paid'), pay('p2', ME, BEN, 1000, 'marked_paid')])
    expect(eq.ledgerAmount).toBe(4698.61)
    expect(eq.sentWaiting).toBe(3000)
    expect(eq.remainingToPay).toBe(1698.61)
    expect(eq.headline.kind).toBe('owe')
    expect(eq.headline.text).toBe('You owe £1,698.61')
    expect(eq.headline.note).toBe('£3,000.00 sent — waiting for Alex and Ben to confirm')
    // the confirmed arithmetic is unchanged
    expect(eq.net).toBe(-4698.61)
  })

  it('everything sent: "£X sent — waiting for <name> to confirm"', () => {
    const eq = explain([...confirmedBack, pay('p1', ME, ALEX, 4698.61, 'marked_paid')])
    expect(eq.remainingToPay).toBe(0)
    expect(eq.headline).toEqual({
      kind: 'sent_waiting',
      amount: 4698.61,
      text: '£4,698.61 sent — waiting for Alex to confirm',
      note: null,
    })
    expect(eq.headline.text).not.toMatch(/You owe/)
  })

  it('splits payments by status', () => {
    const eq = explain([...confirmedBack, pay('p1', ME, ALEX, 2000, 'marked_paid'), pay('p2', ME, BEN, 500, 'suggested'), pay('p3', BEN, ME, 100, 'suggested')])
    expect(eq.sentPayments.map((p) => [p.counterpartyName, p.status, p.amount])).toEqual([
      ['Alex', 'marked_paid', 2000],
      ['Ben', 'suggested', 500],
    ])
    expect(eq.receivedPayments.filter((p) => p.status === 'confirmed').map((p) => p.counterpartyName)).toEqual(['Alex', 'Ben'])
    expect(eq.sentSuggested).toBe(500)
    expect(eq.receivedSuggested).toBe(100)
    // suggested rows are not money: balance unchanged
    expect(eq.net).toBe(-4698.61)
  })

  it('a confirmed payment I sent is a "+" term and shrinks the debt', () => {
    const eq = explain([...confirmedBack, pay('p1', ME, ALEX, 1000, 'confirmed')])
    expect(eq.terms.find((t) => t.key === 'sent')).toMatchObject({ sign: '+', amount: 1000 })
    expect(eq.net).toBe(-3698.61)
    expect(eq.headline.text).toBe('You owe £3,698.61')
    expect(eq.equationText).toBe('You paid £11,563.80 − your share £5,719.28 + you paid back £1,000.00 − paid back to you £10,543.13 = you owe £3,698.61')
  })
})

describe('explainMoneyPosition: being owed', () => {
  // Alex's view: Alex owes me, so from Alex's side Alex owes. From MY side before anyone paid back I'm owed.
  it('"owed" with someone saying they paid you: confirm receipt', () => {
    const eq = explain([pay('r', ALEX, ME, 3000, 'marked_paid')])
    expect(eq.kind).toBe('owed')
    expect(eq.ledgerAmount).toBe(5844.52)
    expect(eq.receivedWaiting).toBe(3000)
    expect(eq.remainingToReceive).toBe(2844.52)
    expect(eq.headline.text).toBe("You're owed £2,844.52")
    expect(eq.headline.note).toBe("Alex says they've paid you £3,000.00 — confirm receipt")
  })
  it('all of it reported paid: confirm receipt headline', () => {
    const eq = explain([pay('r', ALEX, ME, 3000, 'marked_paid'), pay('r2', BEN, ME, 2844.52, 'marked_paid')])
    expect(eq.headline.kind).toBe('confirm_receipt')
    expect(eq.headline.text).toBe("Alex and Ben say they've paid you £5,844.52 — confirm receipt")
  })
  it('settled', () => {
    const eq = explain([pay('r', ALEX, ME, 3000, 'confirmed'), pay('r2', BEN, ME, 2844.52, 'confirmed')])
    expect(eq.kind).toBe('settled')
    // the ledger: paid 11563.80 - share 5719.28 - received 5844.52 = 0
    expect(eq.net).toBe(0)
    expect(eq.headline).toEqual({ kind: 'settled', amount: 0, text: 'All square', note: null })
  })
})

// ---------------------------------------------------------------------------
// Phase 3 review regressions
// ---------------------------------------------------------------------------

const dinner = {
  id: 'dinner',
  trip_id: 't',
  description: 'Dinner',
  amount: 300,
  currency: 'GBP',
  fx_rate: null,
  paid_by: ALEX,
  payment_date: '2026-09-01',
  ai_parsed: false,
  status: null,
  line_items: [],
  claims: [],
  splits: PEOPLE.map((u) => ({ user_id: u, amount: 100 })),
} as unknown as ExpenseWithDetails

function carry(id: string, from: string, to: string, amount: number): SettlementCarryover {
  return { id, trip_id: 't', source_trip_id: 'sicily', from_user_id: from, to_user_id: to, amount, currency: 'GBP', created_by: from, created_at: '2026-09-01T00:00:00Z' } as unknown as SettlementCarryover
}

describe('D1: carryovers are described as carryovers, never as payments', () => {
  it('a debt carried in is a "carried over from <trip>" term, not "paid back to you"', () => {
    const eq = explainMoneyPosition({
      expenses: [], settlements: [], participantUserIds: PEOPLE, currentUserId: ME, baseCurrency: 'GBP', names: NAMES,
      carryovers: [carry('c1', ME, ALEX, 20)], carryoverTripNames: { sicily: 'Sicily' },
    })
    expect(eq.net).toBe(-20)
    expect(eq.receivedConfirmed).toBe(0)
    expect(eq.sentConfirmed).toBe(0)
    expect(eq.carriedOver).toEqual([{ id: 'c1', tripLabel: 'Sicily', amount: 20, direction: 'owed_by_you', otherPartyName: 'Alex' }])
    expect(eq.terms.map((t) => [t.key, t.label, t.sign, t.amount])).toContainEqual(['carried', 'carried over from Sicily', '−', 20])
    expect(eq.equationText).toContain('− carried over from Sicily £20.00')
    expect(eq.equationText).not.toContain('paid back to you')
    expect(eq.headline.text).toBe('You owe £20.00')
  })
  it('a credit carried in is a plus term; the identity still holds with real payments alongside', () => {
    const eq = explainMoneyPosition({
      expenses: [dinner], settlements: [pay('p', ME, ALEX, 30, 'confirmed')], participantUserIds: PEOPLE, currentUserId: ME, baseCurrency: 'GBP', names: NAMES,
      carryovers: [carry('c2', ALEX, ME, 15)],
    })
    expect(eq.carriedOver[0]).toMatchObject({ direction: 'owed_to_you', tripLabel: 'another trip', amount: 15 })
    expect(eq.sentConfirmed).toBe(30)
    const signed = eq.terms.reduce((acc, t) => acc + (t.sign === '+' ? t.amount : -t.amount), 0)
    expect(Math.round(signed * 100) / 100).toBe(eq.net)
  })
})

describe('D2: a frozen trip cannot be square while suggested payments from you exist', () => {
  // Alex paid £300 dinner, I owe £100; a direct payment of £100 landed AFTER the freeze, so the live ledger is square,
  // yet the frozen suggested row ("Pay Alex £100") is still there and so is the pay to-do.
  const settlements = [pay('direct', ME, ALEX, 100, 'confirmed'), pay('sug', ME, ALEX, 100, 'suggested')]
  const input = { expenses: [dinner], settlements, participantUserIds: PEOPLE, currentUserId: ME, baseCurrency: 'GBP', names: NAMES }
  it('says the balances changed instead of square', () => {
    const eq = explainMoneyPosition({ ...input, frozen: true })
    expect(eq.kind).toBe('settled')
    expect(eq.stale).toBe(true)
    expect(eq.headline.kind).toBe('stale')
    expect(eq.headline.text).toBe('Balances changed since they were frozen — ask the organizer to refresh')
  })
  it('not frozen: the suggested rows mean nothing and nothing is stale', () => {
    const eq = explainMoneyPosition({ ...input, frozen: false })
    expect(eq.stale).toBe(false)
    expect(eq.headline.kind).toBe('settled')
  })
  it('frozen and consistent (the suggested row is exactly what you owe): the normal owe headline', () => {
    const eq = explainMoneyPosition({ ...input, settlements: [pay('sug', ME, ALEX, 100, 'suggested')], frozen: true })
    expect(eq.stale).toBe(false)
    expect(eq.headline).toMatchObject({ kind: 'owe', text: 'You owe £100.00' })
  })
  it('frozen, you owe less than the suggested row: the owe headline carries the stale note', () => {
    const eq = explainMoneyPosition({ ...input, settlements: [pay('part', ME, ALEX, 40, 'confirmed'), pay('sug', ME, ALEX, 100, 'suggested')], frozen: true })
    expect(eq.headline.text).toBe('You owe £60.00')
    expect(eq.headline.note).toBe('Balances changed since they were frozen — ask the organizer to refresh')
  })
})

describe('D3/E3: money in another currency is never read 1:1', () => {
  const yen = { ...pay('yen', ME, ALEX, 5000, 'marked_paid'), currency: 'JPY' } as Settlement
  const base = { expenses: [dinner], settlements: [yen], participantUserIds: PEOPLE, currentUserId: ME, baseCurrency: 'GBP', names: NAMES }
  it('without a rate it is excluded from the arithmetic and listed (as the to-dos engine does)', () => {
    const eq = explainMoneyPosition(base)
    expect(eq.sentWaiting).toBe(0)
    expect(eq.remainingToPay).toBe(100)
    expect(eq.headline.text).toBe('You owe £100.00')
    expect(eq.headline.note).toBeNull()
    expect(eq.excludedForeign.map((p) => p.id)).toEqual(['yen'])
  })
  it('with a rate it is converted and marked ≈', () => {
    const eq = explainMoneyPosition({ ...base, fxRates: { JPY: 0.0052 } })
    expect(eq.sentWaiting).toBe(26)
    expect(eq.remainingToPay).toBe(74)
    expect(eq.waitingConverted).toBe(true)
    expect(eq.headline.note).toBe('≈£26.00 sent — waiting for Alex to confirm')
    expect(eq.excludedForeign).toEqual([])
  })
})
