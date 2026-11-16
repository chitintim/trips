import { describe, it, expect } from 'vitest'
import { evaluateRemovalGuard } from './removalGuard'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

function expense(o: Partial<ExpenseWithDetails> & { id: string }): ExpenseWithDetails {
  return { amount: 100, currency: 'GBP', paid_by: 'alice', fx_rate: null, ai_parsed: false, status: null, splits: [], line_items: [], claims: [], ...o } as unknown as ExpenseWithDetails
}
const split = (userId: string, amount: number) => ({ user_id: userId, amount }) as ExpenseWithDetails['splits'][number]
const settlement = (o: Partial<Settlement>) => ({ id: 's', status: 'confirmed', currency: 'GBP', amount: 1, ...o }) as Settlement

const base = { carryovers: [], activeUserIds: ['alice', 'bob'], baseCurrency: 'GBP' }

describe('evaluateRemovalGuard', () => {
  it('blocks while expenses have not loaded (no undefined-balance race)', () => {
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: undefined, settlements: undefined })
    expect(r.loading).toBe(true)
    expect(r.blocked).toBe(true)
  })

  it('blocks a creditor with an open balance', () => {
    const e = expense({ id: 'e', paid_by: 'bob', amount: 600, splits: [split('alice', 300), split('bob', 300)] })
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: [e], settlements: [] })
    expect(r.hasBalance).toBe(true)
    expect(r.netBalanceMinor).toBe(30000)
    expect(r.blocked).toBe(true)
  })

  it('allows removal once the balance is settled by a confirmed payment', () => {
    const e = expense({ id: 'e', paid_by: 'bob', amount: 600, splits: [split('alice', 300), split('bob', 300)] })
    const s = settlement({ from_user_id: 'alice', to_user_id: 'bob', amount: 300 })
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: [e], settlements: [s] })
    expect(r.blocked).toBe(false)
  })

  it('blocks on an unconfirmed settlement even at zero balance', () => {
    const s = settlement({ from_user_id: 'alice', to_user_id: 'bob', status: 'marked_paid' })
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: [], settlements: [s] })
    expect(r.hasOpenSettlement).toBe(true)
    expect(r.blocked).toBe(true)
  })

  it('blocks when the person paid an expense with no exchange rate', () => {
    const e = expense({ id: 'e', paid_by: 'bob', currency: 'EUR', fx_rate: null, splits: [split('alice', 50)] })
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: [e], settlements: [] })
    expect(r.hasUnconvertedExpenses).toBe(true)
    expect(r.blocked).toBe(true)
  })

  it('allows someone with no money involvement', () => {
    const e = expense({ id: 'e', paid_by: 'alice', splits: [split('alice', 100)] })
    const r = evaluateRemovalGuard({ ...base, userId: 'bob', expenses: [e], settlements: [] })
    expect(r.blocked).toBe(false)
  })
})
