import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: {} }))

import {
  runReitemize, previewReitemize, reitemizeErrorMessage, toRpcHeader, toRpcLines, parseReitemizeResult, ReitemizeError,
  type RpcFn,
} from './reitemizeRun'
import type { ItemizedSaveLine } from '../itemized/itemizedState'

const line = (name: string, id: string | null = null): ItemizedSaveLine => ({
  name_original: name, name_english: null, quantity: 1, unit_price: 5, subtotal: 5, tax_amount: 0, service_amount: 0, line_discount_amount: null, total_amount: 5, keepFromLineItemId: id,
})

const rpcOk = (data: unknown): RpcFn => vi.fn(async () => ({ data, error: null }))

describe('reitemize_expense', () => {
  it('sends only the allowed header keys and the lines with their ids', async () => {
    const rpc = rpcOk({ kept_claims: 2, cleared_claims: 1, cleared_user_ids: ['u2'], leftovers_cleared: true })
    const out = await runReitemize(rpc, { expenseId: 'e1', expense: { description: 'D', amount: 10, status: 'unallocated', ai_parsed: true, currency: 'GBP', participant_ids: null }, lineItems: [line('A', 'l1'), line('B')] })
    expect(out).toEqual({ clearedClaims: 1, clearedUserIds: ['u2'], leftoversCleared: true, reconfirmUserIds: [], needsLink: false })
    const [fn, args] = (rpc as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fn).toBe('reitemize_expense')
    expect(args.p_preview).toBe(false)
    expect(args.p_header).toEqual({ description: 'D', currency: 'GBP', participant_ids: null })
    expect(args.p_lines.map((l: { id: string | null }) => l.id)).toEqual(['l1', null])
  })

  it('preview asks for p_preview = true and reports who would be cleared', async () => {
    const rpc = rpcOk({ cleared_claims: 3, cleared_user_ids: ['u1', 'u2'] })
    const p = await previewReitemize(rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A', 'l1')] })
    expect((rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_preview).toBe(true)
    expect(p).toEqual({ keptClaims: 0, clearedClaims: 3, clearedUserIds: ['u1', 'u2'], reconfirmUserIds: [], needsLink: false, leftoversCleared: false })
  })

  it.each([
    ['forbidden', /person who paid/],
    ['frozen', /frozen/],
    ['currency_unsupported', /currency/],
    ['bad_line', /amount we can't save/],
    ['claims_closed', /claims are closed/],
    ['reload', /Reload the page/],
  ])('maps the %s hint to a plain message', async (hint, re) => {
    const rpc: RpcFn = vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'raw db text', hint } }))
    await expect(runReitemize(rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toThrow(re)
    await expect(previewReitemize(rpc, { expenseId: 'e1', expense: {}, lineItems: [line('A')] })).rejects.toThrow(re)
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
  })
})

describe('refuses writes the database would reject', () => {
  it.each([
    ['zero total', { description: 'D', amount: 0 }],
    ['long title', { description: 'D'.repeat(501), amount: 5 }],
    ['long vendor', { description: 'D', vendor_name: 'v'.repeat(201), amount: 5 }],
  ])('%s: no rpc call', async (_n, expense) => {
    const rpc: RpcFn = vi.fn(async () => ({ data: {}, error: null }))
    await expect(runReitemize(rpc, { expenseId: 'e1', expense, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
    await expect(previewReitemize(rpc, { expenseId: 'e1', expense, lineItems: [line('A')] })).rejects.toBeInstanceOf(ReitemizeError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses an over-long item name', async () => {
    await expect(runReitemize(rpcOk({}), { expenseId: 'e1', expense: { description: 'D', amount: 5 }, lineItems: [line('n'.repeat(201))] })).rejects.toBeInstanceOf(ReitemizeError)
  })
})
