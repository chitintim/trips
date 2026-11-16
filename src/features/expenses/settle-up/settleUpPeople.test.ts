import { describe, it, expect } from 'vitest'
import { buildSettleUpPeople } from './settleUpPeople'
import { computeSuggestedPayments } from './settleUpLogic'
import { computeMoneyPosition } from '../money-space/moneyPosition'
import { computeBalances, withMoneyParticipants } from '../lib/balances'
import { computePersonalOverview } from '../my-spending/personalAnalytics'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

const villa = {
  id: 'villa', amount: 600, currency: 'GBP', paid_by: 'bob', fx_rate: null, ai_parsed: false, status: null, line_items: [], claims: [],
  splits: [{ user_id: 'alice', amount: 200 }, { user_id: 'bob', amount: 200 }, { user_id: 'carol', amount: 200 }],
} as unknown as ExpenseWithDetails

const row = (id: string, name: string) => ({ user_id: id, user: { full_name: name, email: `${id}@x.com` } })

describe('buildSettleUpPeople', () => {
  it('adds a removed payer as "left" and Settle Up then repays them', () => {
    const active = [row('alice', 'Alice'), row('carol', 'Carol')]
    const all = [...active, row('bob', 'Bob')]
    const people = buildSettleUpPeople({ expenses: [villa], settlements: [], carryovers: [], baseCurrency: 'GBP', active, all })
    expect(people.map((p) => [p.userId, !!p.left])).toEqual([['alice', false], ['carol', false], ['bob', true]])
    const payments = computeSuggestedPayments([villa], [], people, 'GBP', true)
    expect(payments.map((t) => [t.from, t.to, t.amount]).sort()).toEqual([['alice', 'bob', 200], ['carol', 'bob', 200]])
  })

  it('falls back to "Former member" when the inactive row is not readable', () => {
    const people = buildSettleUpPeople({ expenses: [villa], settlements: [], carryovers: [], baseCurrency: 'GBP', active: [row('alice', 'Alice'), row('carol', 'Carol')], all: [] })
    expect(people.find((p) => p.userId === 'bob')).toEqual({ userId: 'bob', name: 'Former member', left: true })
  })
})

describe('headline == breakdown == Settle Up when the payer has left', () => {
  const active = [row('alice', 'Alice'), row('carol', 'Carol')]
  const activeIds = active.map((p) => p.user_id)

  it('gives every surface the same totals and the ledger sums to zero', () => {
    const people = buildSettleUpPeople({ expenses: [villa], settlements: [], carryovers: [], baseCurrency: 'GBP', active, all: [...active, row('bob', 'Bob')] })
    const settle = computeSuggestedPayments([villa], [], people, 'GBP', true)
    const settleTotalMinor = settle.reduce((n, t) => n + Math.round(t.amount * 100), 0)

    // Money headline for Alice, built from the ACTIVE roster only (as the header receives it).
    const position = computeMoneyPosition([villa], [], activeIds, 'alice', 'GBP')
    expect(position.kind).toBe('owe')
    expect(position.amount).toBe(200)
    // Breakdown: Alice owes the departed Bob exactly the headline amount.
    expect(position.perPerson).toHaveLength(1)
    expect(position.perPerson[0].userId).toBe('bob')
    expect(position.perPerson[0].netMinor).toBe(-20000)
    // Settle Up: Alice pays Bob the same 200; total of all payments = what is owed to Bob.
    expect(settle.find((t) => t.from === 'alice')).toMatchObject({ to: 'bob', amount: 200 })
    expect(settleTotalMinor).toBe(40000)

    // Personal analytics agrees on the net.
    const overview = computePersonalOverview([villa], [], activeIds, 'alice', 'GBP', '2026-01-01', '2026-01-05')
    expect(overview.netBalanceMajor).toBe(-200)

    // The ledger over the money participants sums to zero.
    const ids = withMoneyParticipants(activeIds, [villa], [], 'GBP')
    const { balances } = computeBalances([villa], [], ids, 'GBP')
    expect(balances.reduce((n, b) => n + b.netBalanceMinor, 0)).toBe(0)
  })
})
