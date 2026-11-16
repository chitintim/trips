import { describe, it, expect } from 'vitest'
import { explainMoneyPosition } from '../../../lib/cost/moneyEquation'
import { buildMoneyPositionView } from './moneyPositionView'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

const USERS = ['me', 'a', 'b']
const NAMES = { me: 'Me', a: 'Sam', b: 'Raine' }
const expense = (id: string, amount: number, paidBy: string): ExpenseWithDetails =>
  ({
    id, trip_id: 't', description: id, amount, currency: 'GBP', fx_rate: null, paid_by: paidBy, status: null,
    option_id: null, booking_id: null, line_items: [], claims: [], payment_date: '2027-01-01',
    splits: USERS.map((u) => ({ user_id: u, amount: amount / 3 })),
  }) as unknown as ExpenseWithDetails
const settlement = (id: string, from: string, to: string, amount: number, status: string): Settlement =>
  ({ id, trip_id: 't', from_user_id: from, to_user_id: to, amount, currency: 'GBP', status, notes: null, payment_method: null, settled_at: null, created_at: '2027-01-02' }) as unknown as Settlement

const run = (expenses: ExpenseWithDetails[], settlements: Settlement[]) =>
  buildMoneyPositionView(explainMoneyPosition({ expenses, settlements, participantUserIds: USERS, currentUserId: 'me', baseCurrency: 'GBP', names: NAMES }))

describe('buildMoneyPositionView', () => {
  it('owing: headline says You owe and the rows add up', () => {
    const v = run([expense('e1', 300, 'a')], [])
    expect(v.headline).toBe('You owe £100.00')
    expect(v.tone).toBe('owe')
    expect(v.rows.map((r) => r.label)).toEqual(['You paid for the group', 'Your share of everything', 'So far you owe'])
    expect(v.square).toBe(false)
  })

  it('already marked paid: never says You owe', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 100, 'marked_paid')])
    expect(v.headline).toBe('£100.00 sent — waiting for Sam to confirm')
    expect(v.headline).not.toMatch(/You owe/)
    expect(v.tone).toBe('waiting')
    expect(v.rows.some((r) => r.label === 'Sent, waiting for Sam to confirm' && r.amount === '£100.00')).toBe(true)
    expect(v.rows[v.rows.length - 1]?.label).toBe('Nothing more to pay once confirmed')
  })

  it('part-sent: owe the rest, with the sent note', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 40, 'marked_paid')])
    expect(v.headline).toBe('You owe £60.00')
    expect(v.note).toBe('£40.00 sent — waiting for Sam to confirm')
    expect(v.rows[v.rows.length - 1]).toMatchObject({ label: 'Still to pay', amount: '£60.00' })
  })

  it('square only when truly settled', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 100, 'confirmed'), settlement('s2', 'b', 'a', 100, 'confirmed')])
    expect(v.square).toBe(true)
    expect(v.headline).toBe("You're square ✓")
  })

  it("owed money with a payment waiting for you to confirm", () => {
    const v = run([expense('e1', 300, 'me')], [settlement('s1', 'a', 'me', 100, 'marked_paid')])
    expect(v.headline).toMatch(/You're owed £100.00|says they've paid you/)
    expect(v.square).toBe(false)
  })

  it('someone who left: their share and payments stay in the sums, the headline stays one clear line', () => {
    // 'b' left (not in participantUserIds) but still has a share of the dinner and owes 'a'.
    const v = buildMoneyPositionView(
      explainMoneyPosition({
        expenses: [expense('e1', 300, 'a')],
        settlements: [settlement('s1', 'b', 'a', 50, 'confirmed')],
        participantUserIds: ['me', 'a'],
        currentUserId: 'me',
        baseCurrency: 'GBP',
        names: NAMES,
      })
    )
    expect(v.headline).toMatch(/^You owe £/)
    expect(v.rows.length).toBeGreaterThan(0)
  })

  it('nothing recorded yet: square, no equation rows', () => {
    const v = run([], [])
    expect(v.square).toBe(true)
    expect(v.rows).toEqual([])
  })
})

describe('review D1/D2/D3/E1 in the view', () => {
  it('D2: frozen with a stale suggested row is not "square" and prints no suggested footnote beside it', () => {
    const v = buildMoneyPositionView(
      explainMoneyPosition({
        expenses: [expense('e1', 300, 'a')],
        settlements: [settlement('d', 'me', 'a', 100, 'confirmed'), settlement('s', 'me', 'a', 100, 'suggested')],
        participantUserIds: USERS, currentUserId: 'me', baseCurrency: 'GBP', names: NAMES, frozen: true,
      })
    )
    expect(v.square).toBe(false)
    expect(v.headline).toBe('Balances changed since they were frozen — ask the organizer to refresh')
    expect(v.headline).not.toMatch(/square/)
    expect(v.footnote).toBeNull()
  })

  it('D2: square and not frozen never carries the suggested footnote', () => {
    const v = buildMoneyPositionView(
      explainMoneyPosition({
        expenses: [expense('e1', 300, 'a')],
        settlements: [settlement('d', 'me', 'a', 100, 'confirmed'), settlement('d2', 'b', 'a', 100, 'confirmed'), settlement('s', 'me', 'a', 100, 'suggested')],
        participantUserIds: USERS, currentUserId: 'me', baseCurrency: 'GBP', names: NAMES,
      })
    )
    expect(v.square).toBe(true)
    expect(v.footnote).toBeNull()
  })

  it('D1: a carried-over debt reads "Carried over from ...", not "Payments you received"', () => {
    const v = buildMoneyPositionView(
      explainMoneyPosition({
        expenses: [], settlements: [], participantUserIds: USERS, currentUserId: 'me', baseCurrency: 'GBP', names: NAMES,
        carryovers: [{ id: 'c', trip_id: 't', source_trip_id: 'x', from_user_id: 'me', to_user_id: 'a', amount: 20, currency: 'GBP', created_by: 'me', created_at: '2027-01-01' } as never],
        carryoverTripNames: { x: 'Sicily' },
      })
    )
    expect(v.rows.map((r) => r.label)).toContain('Carried over from Sicily (you owe Sam)')
    expect(v.rows.map((r) => r.label)).not.toContain('Payments you received (confirmed)')
    expect(v.headline).toBe('You owe £20.00')
  })

  it('D3: a foreign-currency marked-paid payment is listed separately with a note', () => {
    const v = buildMoneyPositionView(
      explainMoneyPosition({
        expenses: [expense('e1', 300, 'a')],
        settlements: [{ ...settlement('y', 'me', 'a', 5000, 'marked_paid'), currency: 'JPY' } as Settlement],
        participantUserIds: USERS, currentUserId: 'me', baseCurrency: 'GBP', names: NAMES,
      })
    )
    expect(v.headline).toBe('You owe £100.00')
    expect(v.foreignNote).toBe("¥5,000 marked paid to Sam isn't counted above (different currency)")
  })

  it('E1: the Today chip text (this headline) never says "You owe" for money already marked paid', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 100, 'marked_paid')])
    expect(v.headline).not.toMatch(/You owe/)
  })

  it('Sicily: sent twice what is owed -> says so, never "Nothing more to pay", points at Settle up', () => {
    const dup = (id: string) => settlement(id, 'me', 'a', 100, 'marked_paid')
    const v = run([expense('e1', 300, 'a')], [dup('s1'), dup('s2')])
    expect(v.headline).toBe("You've sent £100.00 more than you owe")
    expect(v.note).toBe('£200.00 sent, waiting for Sam to confirm but you only owe £100.00')
    expect(v.rows.some((r) => r.label === 'Nothing more to pay once confirmed')).toBe(false)
    expect(v.rows[v.rows.length - 1]).toMatchObject({ label: "You've sent £100.00 too much", amount: null })
    expect(v.rows.find((r) => r.key === 'ledger')).toMatchObject({ label: 'Before payments you owed', amount: '£100.00' })
    expect(v.settleHint).toBe('Some payments look recorded twice — check Settle up')
    expect(v.settleHintLink).toBe('?open=settle')
    expect(v.tone).toBe('owe')
  })

  it('sent exactly what is owed: unchanged, no duplicate hint', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 100, 'marked_paid')])
    expect(v.headline).toBe('£100.00 sent — waiting for Sam to confirm')
    expect(v.settleHint).toBeNull()
  })

  it('overpaid with different (not duplicate) payments gets no duplicate hint', () => {
    const v = run([expense('e1', 300, 'a')], [settlement('s1', 'me', 'a', 100, 'marked_paid'), settlement('s2', 'me', 'a', 30, 'marked_paid')])
    expect(v.headline).toBe("You've sent £30.00 more than you owe")
    expect(v.settleHint).toBeNull()
  })
})
