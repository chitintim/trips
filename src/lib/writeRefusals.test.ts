import { describe, it, expect, vi } from 'vitest'
import { describeWriteError, FROZEN_WRITE_MESSAGE, refreshAfterRefusal, refusalHint, refusalMessage, RELOAD_WRITE_MESSAGE, USE_RPC_WRITE_MESSAGE } from './writeRefusals'
import { describeClaimError, describeOwnClaimError } from '../features/expenses/claims/claimErrors'
import { describeTableError } from '../features/expenses/claims/receiptTable'
import { reitemizeErrorMessage } from '../features/expenses/editor/reitemizeRun'
import { FROZEN_EXPENSES_MESSAGE } from '../features/expenses/quick-capture/addExpenseEntry'

describe('refusal hints', () => {
  it('maps each phase-4 hint to a plain message, whatever the raw text says', () => {
    const raw = (hint: string) => ({ code: 'P0001', message: 'frozen trip: expenses write refused (internal text)', hint })
    expect(refusalMessage(raw('frozen'))).toBe(FROZEN_WRITE_MESSAGE)
    expect(refusalMessage(raw('reload'))).toBe(RELOAD_WRITE_MESSAGE)
    expect(refusalMessage(raw('use_rpc'))).toBe(USE_RPC_WRITE_MESSAGE)
    expect(refusalMessage(raw('claims_closed'))).toBeNull()
    expect(refusalMessage(null)).toBeNull()
    expect(refusalHint(new Error('x'))).toBeNull()
  })
  it('describeWriteError prefers the plain message, then the error text', () => {
    expect(describeWriteError({ hint: 'frozen', message: 'raw' })).toBe(FROZEN_WRITE_MESSAGE)
    expect(describeWriteError(new Error('boom'))).toBe('boom')
    expect(describeWriteError({ message: 'plain object' })).toBe('plain object')
    expect(describeWriteError({})).toBeUndefined()
  })
  it('every screen that shows write errors words the new hints plainly (no raw text)', () => {
    for (const hint of ['frozen', 'reload', 'use_rpc']) {
      const err = { hint, message: 'raw db text', code: 'P0001' }
      expect(describeClaimError(err)).not.toMatch(/raw db text/)
    }
    for (const hint of ['frozen', 'reload']) expect(describeTableError({ hint })).not.toBe('Something went wrong. Try again.')
    expect(reitemizeErrorMessage({ hint: 'frozen' })).toMatch(/frozen/)
    expect(reitemizeErrorMessage({ hint: 'reload' })).toMatch(/Reload/)
    expect(describeClaimError({ hint: 'reload' })).toBe(RELOAD_WRITE_MESSAGE)
  })
  it('the add-expense screen and the database refusal say the same thing', () => {
    expect(FROZEN_EXPENSES_MESSAGE).toBe(FROZEN_WRITE_MESSAGE)
  })
})

describe('own-claims refusals', () => {
  it('words every hint of set_my_receipt_claims plainly, and its own meaning of forbidden', () => {
    for (const hint of ['forbidden', 'frozen', 'claims_closed', 'currency_unsupported', 'bad_input', 'bad_line', 'table_item', 'fixed_share', 'overclaimed', 'not_found', 'reload']) {
      const msg = describeOwnClaimError({ hint, message: 'raw db text', code: 'P0001' })
      expect(msg).toBeTruthy()
      expect(msg).not.toMatch(/raw db text/)
    }
    expect(describeOwnClaimError({ hint: 'forbidden' })).toMatch(/not on this receipt/)
    expect(describeOwnClaimError({ hint: 'overclaimed' })).toMatch(/isn't that much/)
    expect(describeOwnClaimError(null)).toBeTruthy()
  })
})

describe('refreshAfterRefusal', () => {
  it('refetches the trip (frozen flag), expenses, settlements and claim pages after a refusal', () => {
    const invalidateQueries = vi.fn()
    refreshAfterRefusal({ invalidateQueries } as never, 't1', { hint: 'frozen' })
    const keys = invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
    expect(keys).toContainEqual(['trip', 't1', 'detail'])
    expect(keys).toContainEqual(['trip', 't1', 'expenses'])
    expect(keys).toContainEqual(['trip', 't1', 'settlements'])
    expect(keys).toContainEqual(['claimLink'])
  })
  it('does nothing for an ordinary error', () => {
    const invalidateQueries = vi.fn()
    refreshAfterRefusal({ invalidateQueries } as never, 't1', new Error('network'))
    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})
