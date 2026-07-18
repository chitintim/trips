/**
 * applyAction create_expense_draft rollback behavior: a splits-insert
 * failure rolls back the just-created expense, and a rollback failure is
 * surfaced via reportError (it used to be silently ignored, leaving an
 * invisible orphaned expense corrupting zero-sum balances).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/reportError', () => ({ reportError: vi.fn() }))

const behaviors = new Map<string, { insertError?: { message: string }; deleteError?: { message: string }; insertReturns?: unknown }>()
const calls: Array<{ table: string; op: string; payload?: unknown }> = []

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b = () => behaviors.get(table) ?? {}
      return {
        insert: (payload: unknown) => {
          calls.push({ table, op: 'insert', payload })
          const result = { data: null, error: b().insertError ?? null }
          return {
            then: (fn: (r: typeof result) => unknown) => Promise.resolve(result).then(fn),
            select: () => ({
              single: async () => ({ data: b().insertReturns ?? null, error: b().insertError ?? null }),
            }),
          }
        },
        delete: () => ({
          eq: async () => {
            calls.push({ table, op: 'delete' })
            return { error: b().deleteError ?? null }
          },
        }),
      }
    },
  },
}))

import { applyAction } from './applyProposal'
import { reportError } from '../../../lib/reportError'
import type { ProposedAction } from '../../../shared/contracts/aiProposal'

const ctx = { tripId: 'trip-1', userId: 'alice', baseCurrency: 'GBP' }

// Same currency as base so resolveExpenseFxFields short-circuits (no fetch).
const action = {
  type: 'create_expense_draft',
  idempotency_key: 'k1',
  description: 'Dinner',
  amount: 100,
  currency: 'GBP',
  participant_ids: ['alice', 'bob'],
} as unknown as ProposedAction

beforeEach(() => {
  behaviors.clear()
  calls.length = 0
  vi.mocked(reportError).mockClear()
})

describe('applyAction create_expense_draft rollback', () => {
  it('rolls back the expense when splits insert fails and does NOT reportError when the rollback succeeds', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' } })
    behaviors.set('expense_splits', { insertError: { message: 'splits boom' } })

    await expect(applyAction(action, ctx)).rejects.toThrow('splits boom')
    expect(calls.some((c) => c.table === 'expenses' && c.op === 'delete')).toBe(true)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('reports the rollback failure via reportError instead of swallowing it', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' }, deleteError: { message: 'rollback boom' } })
    behaviors.set('expense_splits', { insertError: { message: 'splits boom' } })

    await expect(applyAction(action, ctx)).rejects.toThrow('splits boom')
    expect(reportError).toHaveBeenCalledWith({ message: 'rollback boom' }, 'applyProposal.create_expense_draft.rollback')
  })

  it('same-currency create persists null fx fields and equal splits (baseline)', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' } })
    const result = await applyAction(action, ctx)
    expect(result).toEqual({ table: 'expenses', id: 'exp-1' })
    const expenseInsert = calls.find((c) => c.table === 'expenses' && c.op === 'insert')?.payload as Record<string, unknown>
    expect(expenseInsert.fx_rate).toBeNull()
    const splitsInsert = calls.find((c) => c.table === 'expense_splits' && c.op === 'insert')?.payload as Array<Record<string, unknown>>
    expect(splitsInsert).toHaveLength(2)
    expect(splitsInsert[0].base_currency_amount).toBeNull()
  })
})
