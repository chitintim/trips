import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: {} }))

import {
  runReitemize, previewReitemize, reitemizeErrorMessage, toRpcHeader, toRpcLines, parseReitemizeResult, fallbackLineNumbers, ReitemizeError,
  type Db, type RpcFn,
} from './reitemizeRun'
import type { ItemizedSaveLine } from '../itemized/itemizedState'

const line = (name: string, id: string | null = null): ItemizedSaveLine => ({
  name_original: name, name_english: null, quantity: 1, unit_price: 5, subtotal: 5, tax_amount: 0, service_amount: 0, line_discount_amount: null, total_amount: 5, keepFromLineItemId: id,
})
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.reitemize_expense' }

/** A recording stand-in for the supabase client: every chain is thenable and resolves to results[`table.op`]. */
function fakeDb(results: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = []
  const db: Db = {
    from(table: string) {
      let op = ''
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in']) {
        chain[m] = (...args: unknown[]) => {
          if (['select', 'insert', 'update', 'delete'].includes(m) && !op) op = m
          calls.push({ table, op: m === 'eq' || m === 'in' ? `${op}.${m}` : m, args })
          return chain
        }
      }
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, ...(results[`${table}.${op}`] ?? {}) })
      return chain
    },
  }
  return { db, calls }
}
const rpcOk = (data: unknown): RpcFn => vi.fn(async () => ({ data, error: null }))
const rpcMissing: RpcFn = vi.fn(async () => ({ data: null, error: MISSING }))

describe('reitemize_expense (database function present)', () => {
  it('sends only the allowed header keys and the lines with their ids', async () => {
    const rpc = rpcOk({ kept_claims: 2, cleared_claims: 1, cleared_user_ids: ['u2'], leftovers_cleared: true })
    const { db } = fakeDb()
    const out = await runReitemize(db, rpc, { expenseId: 'e1', expense: { description: 'D', amount: 10, status: 'unallocated', ai_parsed: true, currency: 'GBP', participant_ids: null }, lineItems: [line('A', 'l1'), line('B')] })
    expect(out).toEqual({ clearedClaims: 1, clearedUserIds: ['u2'], leftoversCleared: true, reconfirmUserIds: [], needsLink: false, usedFallback: false })
    const [fn, args] = (rpc as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fn).toBe('reitemize_expense')
    expect(args.p_preview).toBe(false)
    expect(args.p_header).toEqual({ description: 'D', currency: 'GBP', participant_ids: null })
    expect(args.p_lines.map((l: { id: string | null }) => l.id)).toEqual(['l1', null])
  })

  it('preview asks for p_preview = true and reports who would be cleared', async () => {
    const rpc = rpcOk({ cleared_claims: 3, cleared_user_ids: ['u1', 'u2'] })
    const { db } = fakeDb()
    const p = await previewReitemize(db, rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A', 'l1')] })
    expect((rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_preview).toBe(true)
    expect(p).toEqual({ supported: true, outcome: { keptClaims: 0, clearedClaims: 3, clearedUserIds: ['u1', 'u2'], reconfirmUserIds: [], needsLink: false, leftoversCleared: false } })
  })

  it.each([
    ['forbidden', /person who paid/],
    ['frozen', /frozen/],
    ['currency_unsupported', /currency/],
    ['bad_line', /amount we can't save/],
    ['claims_closed', /claims are closed/],
  ])('maps the %s hint to a plain message and does not fall back', async (hint, re) => {
    const rpc: RpcFn = vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'raw db text', hint } }))
    const { db, calls } = fakeDb()
    await expect(runReitemize(db, rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toThrow(re)
    expect(calls).toHaveLength(0)
    await expect(previewReitemize(db, rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toThrow(re)
  })

  it('has a generic message for unknown errors and never shows raw text', () => {
    expect(reitemizeErrorMessage({ code: 'XX000', message: 'duplicate key value violates unique constraint' })).not.toMatch(/duplicate|constraint/)
    expect(reitemizeErrorMessage({ code: '42501', message: 'x' })).toMatch(/person who paid/)
    expect(reitemizeErrorMessage(null)).toBeTruthy()
  })

  it('helpers', () => {
    expect(toRpcHeader({ amount: 5, status: 'x', vendor_name: 'V', fx_rate: undefined })).toEqual({ vendor_name: 'V' })
    expect(toRpcLines([line('A', 'l1')])[0]).toMatchObject({ id: 'l1', name_original: 'A', total_amount: 5 })
    expect(parseReitemizeResult({ reconfirm_user_ids: ['u3'], needs_link: true })).toMatchObject({ reconfirmUserIds: ['u3'], needsLink: true })
    expect(parseReitemizeResult(null)).toEqual({ keptClaims: 0, clearedClaims: 0, clearedUserIds: [], reconfirmUserIds: [], needsLink: false, leftoversCleared: false })
    expect(fallbackLineNumbers([1, 2, 7], 2)).toEqual([8, 9])
    expect(fallbackLineNumbers([], 2)).toEqual([1, 2])
  })
})

describe('before the database function exists (fallback)', () => {
  it('preview reports ALL current claims with the count and who', async () => {
    const { db } = fakeDb({ 'expense_item_claims.select': { data: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }] } })
    const p = await previewReitemize(db, rpcMissing, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })
    expect(p).toEqual({ supported: false, claimCount: 3, userIds: ['u1', 'u2'] })
  })

  it('inserts the new lines after the highest line number, then removes the old ones, then updates the header', async () => {
    const { db, calls } = fakeDb({
      'expense_line_items.select': { data: [{ id: 'old1', line_number: 1 }, { id: 'old2', line_number: 2 }] },
      'expense_line_items.insert': { data: [{ id: 'new1' }, { id: 'new2' }] },
      'expense_item_claims.delete': { data: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u2' }] },
      'expense_line_items.delete': { data: [{ id: 'old1' }, { id: 'old2' }] },
      'expenses.update': { data: [{ id: 'e1' }] },
    })
    const out = await runReitemize(db, rpcMissing, { expenseId: 'e1', expense: { amount: 10 }, lineItems: [line('A', 'old1'), line('B')] })
    expect(out).toEqual({ clearedClaims: 3, clearedUserIds: ['u1', 'u2'], leftoversCleared: false, reconfirmUserIds: [], needsLink: false, usedFallback: true })

    const firsts = calls.filter((c) => ['select', 'insert', 'update', 'delete'].includes(c.op)).map((c) => `${c.table}.${c.op}`)
    const insertAt = firsts.indexOf('expense_line_items.insert')
    const deleteLinesAt = firsts.indexOf('expense_line_items.delete')
    const headerAt = firsts.indexOf('expenses.update')
    expect(insertAt).toBeGreaterThan(-1)
    expect(insertAt).toBeLessThan(deleteLinesAt)
    expect(deleteLinesAt).toBeLessThan(headerAt)

    const rows = calls.find((c) => c.op === 'insert')!.args[0] as Array<{ line_number: number; expense_id: string }>
    expect(rows.map((r) => r.line_number)).toEqual([3, 4])
    expect(rows.every((r) => r.expense_id === 'e1')).toBe(true)
  })

  it('a failed insert loses nothing: no claim or line is deleted', async () => {
    const { db, calls } = fakeDb({
      'expense_line_items.select': { data: [{ id: 'old1', line_number: 1 }] },
      'expense_line_items.insert': { error: { message: 'check constraint' } },
    })
    await expect(runReitemize(db, rpcMissing, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
    expect(calls.some((c) => c.op === 'delete')).toBe(false)
  })

  it('puts the new lines back when the old ones cannot be removed (not the payer)', async () => {
    const { db, calls } = fakeDb({
      'expense_line_items.select': { data: [{ id: 'old1', line_number: 1 }, { id: 'old2', line_number: 2 }] },
      'expense_line_items.insert': { data: [{ id: 'new1' }] },
      'expense_line_items.delete': { data: [] },
    })
    await expect(runReitemize(db, rpcMissing, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toThrow(/person who paid/)
    const deletes = calls.filter((c) => c.table === 'expense_line_items' && c.op === 'delete')
    expect(deletes.length).toBe(2) // the attempt on the old lines, then the undo of the new ones
    expect(calls.some((c) => c.table === 'expenses' && c.op === 'update')).toBe(false)
  })

  it('plain to itemised: no old lines, so nothing is deleted; a failed header update takes the new lines back out', async () => {
    const { db, calls } = fakeDb({
      'expense_line_items.select': { data: [] },
      'expense_line_items.insert': { data: [{ id: 'new1' }] },
      'expenses.update': { data: [] },
    })
    await expect(runReitemize(db, rpcMissing, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
    expect(calls.some((c) => c.table === 'expense_item_claims')).toBe(false)
    expect(calls.filter((c) => c.table === 'expense_line_items' && c.op === 'delete')).toHaveLength(1)
  })
})

describe('refuses writes the database would reject', () => {
  it.each([
    ['zero total', { description: 'D', amount: 0 }],
    ['long title', { description: 'D'.repeat(501), amount: 5 }],
    ['long vendor', { description: 'D', vendor_name: 'v'.repeat(201), amount: 5 }],
  ])('%s: no rpc, no fallback writes', async (_n, expense) => {
    for (const result of [{ data: {}, error: null }, { data: null, error: MISSING }]) {
      const rpc: RpcFn = vi.fn(async () => result)
      const { db, calls } = fakeDb()
      await expect(runReitemize(db, rpc, { expenseId: 'e1', expense, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
      await expect(previewReitemize(db, rpc, { expenseId: 'e1', expense, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
      expect(rpc).not.toHaveBeenCalled()
      expect(calls).toEqual([])
    }
  })

  it('refuses an over-long item name', async () => {
    const { db } = fakeDb()
    await expect(runReitemize(db, rpcOk({}), { expenseId: 'e1', expense: { description: 'D', amount: 5 }, lineItems: [line('n'.repeat(201))] })).rejects.toBeInstanceOf(ReitemizeError)
  })
})
