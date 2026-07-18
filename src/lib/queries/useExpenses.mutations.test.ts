/**
 * Money-path safety tests for the expense mutation hooks: a splits-insert
 * failure must never leave an orphaned expense (broken zero-sum), and the
 * edit path must never delete existing splits before the replacement rows
 * are safely written.
 *
 * react-query's useMutation is mocked to hand back its config so the
 * mutationFn can be exercised directly (node environment, no renderHook).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('../reportError', () => ({ reportError: vi.fn() }))

interface TableBehavior {
  insertError?: { message: string } | null
  upsertError?: { message: string } | null
  updateError?: { message: string } | null
  deleteError?: { message: string } | null
  insertReturns?: unknown
}

const behaviors = new Map<string, TableBehavior>()
const calls: Array<{ table: string; op: string; payload?: unknown }> = []

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b = () => behaviors.get(table) ?? {}
      return {
        insert: (payload: unknown) => {
          calls.push({ table, op: 'insert', payload })
          const result = { data: null, error: b().insertError ?? null }
          return {
            ...Promise.resolve(result),
            then: (fn: (r: typeof result) => unknown) => Promise.resolve(result).then(fn),
            select: () => ({
              single: async () => ({ data: b().insertReturns ?? null, error: b().insertError ?? null }),
            }),
          }
        },
        upsert: async (payload: unknown) => {
          calls.push({ table, op: 'upsert', payload })
          return { error: b().upsertError ?? null }
        },
        update: (payload: unknown) => ({
          eq: async () => {
            calls.push({ table, op: 'update', payload })
            return { error: b().updateError ?? null }
          },
        }),
        delete: () => ({
          eq: () => {
            calls.push({ table, op: 'delete' })
            const result = Promise.resolve({ error: b().deleteError ?? null })
            return Object.assign(result, {
              in: async () => ({ error: b().deleteError ?? null }),
            })
          },
        }),
      }
    },
  },
}))

import { useCreateExpense, useUpdateExpense, type SplitRow } from './useExpenses'
import { reportError } from '../reportError'

type MutationConfig<TVars> = { mutationFn: (vars: TVars) => Promise<unknown> }

const splits: SplitRow[] = [
  { user_id: 'alice', amount: 50, split_type: 'equal' },
  { user_id: 'bob', amount: 50, split_type: 'equal' },
]

beforeEach(() => {
  behaviors.clear()
  calls.length = 0
  vi.mocked(reportError).mockClear()
})

describe('useCreateExpense rollback on splits failure', () => {
  it('deletes the just-created expense and rethrows when splits insert fails', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' } })
    behaviors.set('expense_splits', { insertError: { message: 'splits boom' } })

    const hook = useCreateExpense('trip-1') as unknown as MutationConfig<{ expense: object; splits: SplitRow[] }>
    await expect(hook.mutationFn({ expense: { description: 'Dinner' }, splits })).rejects.toEqual({ message: 'splits boom' })

    expect(calls.some((c) => c.table === 'expenses' && c.op === 'delete')).toBe(true)
  })

  it('reports (but still rethrows original error) when the rollback delete itself fails', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' }, deleteError: { message: 'delete boom' } })
    behaviors.set('expense_splits', { insertError: { message: 'splits boom' } })

    const hook = useCreateExpense('trip-1') as unknown as MutationConfig<{ expense: object; splits: SplitRow[] }>
    await expect(hook.mutationFn({ expense: { description: 'Dinner' }, splits })).rejects.toEqual({ message: 'splits boom' })
    expect(reportError).toHaveBeenCalledWith({ message: 'delete boom' }, 'useCreateExpense.rollback')
  })

  it('does not delete anything on success', async () => {
    behaviors.set('expenses', { insertReturns: { id: 'exp-1' } })
    const hook = useCreateExpense('trip-1') as unknown as MutationConfig<{ expense: object; splits: SplitRow[] }>
    const created = await hook.mutationFn({ expense: { description: 'Dinner' }, splits })
    expect(created).toEqual({ id: 'exp-1' })
    expect(calls.some((c) => c.op === 'delete')).toBe(false)
  })
})

describe('useUpdateExpense split write ordering', () => {
  const vars = {
    expenseId: 'exp-1',
    expense: { description: 'Dinner v2' },
    splits,
    removedUserIds: ['charlie'],
  }

  it('upserts the new splits BEFORE deleting removed participants (no window with missing rows)', async () => {
    const hook = useUpdateExpense('trip-1') as unknown as MutationConfig<typeof vars>
    await hook.mutationFn(vars)

    const upsertIndex = calls.findIndex((c) => c.table === 'expense_splits' && c.op === 'upsert')
    const deleteIndex = calls.findIndex((c) => c.table === 'expense_splits' && c.op === 'delete')
    expect(upsertIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(upsertIndex).toBeLessThan(deleteIndex)
  })

  it('an upsert failure aborts before any splits are deleted (old rows stay intact)', async () => {
    behaviors.set('expense_splits', { upsertError: { message: 'upsert boom' } })
    const hook = useUpdateExpense('trip-1') as unknown as MutationConfig<typeof vars>
    await expect(hook.mutationFn(vars)).rejects.toEqual({ message: 'upsert boom' })
    expect(calls.some((c) => c.table === 'expense_splits' && c.op === 'delete')).toBe(false)
  })

  it('skipSplits touches no split rows at all', async () => {
    const hook = useUpdateExpense('trip-1') as unknown as MutationConfig<{ expenseId: string; expense: object; skipSplits: boolean }>
    await hook.mutationFn({ expenseId: 'exp-1', expense: {}, skipSplits: true })
    expect(calls.filter((c) => c.table === 'expense_splits')).toEqual([])
  })
})
