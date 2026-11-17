/**
 * In-app receipt answers go through `respond_to_receipt` (never direct table writes), and surface
 * the database's reason as `hint`. react-query is mocked to hand back its config so the functions can be called directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const from = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: () => ({}),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('../supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a), functions: { invoke: vi.fn() } } }))

import { useReplyToReceipt } from './useReceiptTable'
import { normalizeLeftovers } from './useExpenses'
import { describeTableError } from '../../features/expenses/claims/receiptTable'

type ReplyOpts = { mutationFn: (v: { expenseId: string; response: 'done' | 'not_there' | null; deadline?: string | null }) => Promise<unknown> }

beforeEach(() => {
  rpc.mockReset()
  from.mockReset()
})

describe('useReplyToReceipt', () => {
  const opts = () => (useReplyToReceipt as unknown as (t: string) => ReplyOpts)('t1')

  it('sends done / not_there / undo through the RPC and writes no table', async () => {
    rpc.mockResolvedValue({ data: { changed: true }, error: null })
    await opts().mutationFn({ expenseId: 'e1', response: 'done' })
    await opts().mutationFn({ expenseId: 'e1', response: 'not_there' })
    await opts().mutationFn({ expenseId: 'e1', response: null })
    expect(rpc.mock.calls).toEqual([
      ['respond_to_receipt', { p_expense_id: 'e1', p_response: 'done' }],
      ['respond_to_receipt', { p_expense_id: 'e1', p_response: 'not_there' }],
      ['respond_to_receipt', { p_expense_id: 'e1', p_response: 'undo' }],
    ])
    expect(from).not.toHaveBeenCalled()
  })

  it('turns the database hint into the plain message', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x', hint: 'has_claims' } })
    const err = await opts().mutationFn({ expenseId: 'e1', response: 'not_there' }).catch((e) => e)
    expect(describeTableError(err)).toBe("You've got items on this receipt, so take them off first.")
    for (const h of ['claims_closed', 'deadline_passed', 'payer_not_there', 'has_leftovers', 'frozen', 'forbidden', 'auth', 'bad_input']) {
      expect(describeTableError({ hint: h })).not.toBe('Something went wrong. Try again.')
    }
  })

  it('refuses locally once the deadline has gone', async () => {
    const err = await opts().mutationFn({ expenseId: 'e1', response: 'done', deadline: '2000-01-01T00:00:00Z' }).catch((e) => e)
    expect((err as { hint?: string }).hint).toBe('deadline_passed')
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('apply preview', () => {
  it('reads leftover_user_id', () => {
    expect(normalizeLeftovers({ people: [], leftover_user_id: 'u9' }, 'GBP').leftoverUserId).toBe('u9')
    expect(normalizeLeftovers({ people: [] }, 'GBP').leftoverUserId).toBeNull()
  })
})
