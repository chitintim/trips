/**
 * A person's own claims are saved through `set_my_receipt_claims` (the server computes the amounts). Until that function exists the old
 * direct path still works. A refusal throws with its hint and the screen is refetched either way. react-query is mocked to hand back its
 * config so the mutation functions can be called directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const chains: Array<{ table: string; op: string }> = []
const invalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: () => ({}),
  useQueryClient: () => ({ invalidateQueries }),
}))

function chainFor(table: string) {
  let op = 'select'
  const result = () => {
    if (table === 'expense_item_claims' && op === 'select') return { data: [{ quantity_claimed: 1, line_item_id: 'l1' }], error: null }
    if (table === 'expense_line_items') return { data: [{ id: 'l1', quantity: 1, total_amount: 5 }], error: null }
    return { data: [{ id: 'e1' }], error: null }
  }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'delete']) {
    chain[m] = () => {
      if (m !== 'select' || chains.every((c) => c.table !== table)) op = m === 'select' && op !== 'select' ? op : m
      chains.push({ table, op: m })
      return chain
    }
  }
  for (const m of ['eq', 'in']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => void) => resolve(result())
  return chain
}
vi.mock('../supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => chainFor(t) } }))

import { buildOwnClaimLines, resetOwnClaimsRpcCache, useSaveItemClaims } from './useExpenses'

type Vars = { expenseId: string; userId: string; claims: Array<{ line_item_id: string; quantity_claimed: number; amount_owed: number }>; lineItemIds: string[] }
type Opts = { mutationFn: (v: Vars) => Promise<unknown>; onSettled: (d: unknown, e: unknown, v: Vars) => void }
const opts = () => (useSaveItemClaims as unknown as () => Opts)()
const vars: Vars = { expenseId: 'e1', userId: 'u1', claims: [{ line_item_id: 'l1', quantity_claimed: 2, amount_owed: 9.99 }], lineItemIds: ['l1', 'l2'] }

beforeEach(() => {
  rpc.mockReset()
  invalidateQueries.mockReset()
  chains.length = 0
  resetOwnClaimsRpcCache()
})

describe('buildOwnClaimLines', () => {
  it('sends quantities only; touched lines with no claim go as 0 (take me off)', () => {
    expect(buildOwnClaimLines([{ line_item_id: 'l1', quantity_claimed: 2 }], ['l1', 'l2'])).toEqual([
      { line_item_id: 'l1', quantity: 2 },
      { line_item_id: 'l2', quantity: 0 },
    ])
  })
  it('never sends an amount (the server computes it)', () => {
    const lines = buildOwnClaimLines([{ line_item_id: 'l1', quantity_claimed: 1, amount_owed: 5 } as never], ['l1'])
    expect(JSON.stringify(lines)).not.toMatch(/amount/)
  })
})

describe('useSaveItemClaims', () => {
  it('uses set_my_receipt_claims and writes no table directly', async () => {
    rpc.mockResolvedValue({ data: {}, error: null })
    await opts().mutationFn(vars)
    expect(rpc).toHaveBeenCalledWith('set_my_receipt_claims', { p_expense_id: 'e1', p_lines: [{ line_item_id: 'l1', quantity: 2 }, { line_item_id: 'l2', quantity: 0 }] })
    expect(chains).toEqual([])
  })

  it('falls back to the old direct writes only while the function does not exist, and remembers that', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.set_my_receipt_claims' } })
    await opts().mutationFn(vars)
    expect(chains.some((c) => c.table === 'expense_item_claims' && c.op === 'delete')).toBe(true)
    expect(chains.some((c) => c.table === 'expense_item_claims' && c.op === 'insert')).toBe(true)
    await opts().mutationFn(vars)
    expect(rpc).toHaveBeenCalledTimes(1) // not asked again this session
  })

  it('a refusal throws with its hint, does NOT fall back, and writes nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'raw', hint: 'frozen' } })
    const err = await opts().mutationFn(vars).catch((e) => e)
    expect((err as { hint?: string }).hint).toBe('frozen')
    expect(chains).toEqual([])
  })

  it('refetches the claim page and the trip after a refusal, and the claim page after a success', () => {
    opts().onSettled(undefined, Object.assign(new Error('x'), { hint: 'frozen' }), vars)
    const keys = invalidateQueries.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown }).queryKey ?? 'predicate'))
    expect(keys).toContain(JSON.stringify(['claimLink']))
    expect(invalidateQueries.mock.calls.length).toBeGreaterThanOrEqual(5)
    invalidateQueries.mockReset()
    opts().onSettled({}, null, vars)
    expect(invalidateQueries.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown }).queryKey ?? 'predicate'))).toContain(JSON.stringify(['claimLink']))
  })
})
