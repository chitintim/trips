/**
 * 0-row updates/deletes on trip_actions (RLS match nothing) must surface as
 * errors instead of looking like success (same pattern as the expenses fix).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('./makeOptimisticMutation', () => ({ useOptimisticMutation: (opts: unknown) => opts }))
vi.mock('./usePlanning', () => ({ useOptions: vi.fn(), useVotes: vi.fn(), useSections: vi.fn() }))
vi.mock('./useTrip', () => ({ useParticipants: vi.fn() }))

let rows: Array<{ id: string }> = []
let dbError: { message: string } | null = null

vi.mock('../supabase', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    c.update = () => c
    c.delete = () => c
    c.eq = () => c
    c.select = () => Promise.resolve({ data: rows, error: dbError })
    return c
  }
  return { supabase: { from: () => chain() } }
})

import { useUpdateAction, useDeleteAction, useToggleActionDone } from './useActions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (hook: any, vars: unknown) => hook('trip-1').mutationFn(vars)

beforeEach(() => {
  rows = [{ id: 'a1' }]
  dbError = null
})

describe('trip_actions mutations detect zero affected rows', () => {
  it('update succeeds when a row matched', async () => {
    await expect(run(useUpdateAction, { id: 'a1', update: { title: 'x' } })).resolves.toBeUndefined()
  })
  it('update throws when nothing matched', async () => {
    rows = []
    await expect(run(useUpdateAction, { id: 'a1', update: { title: 'x' } })).rejects.toThrow(/permission to edit/)
  })
  it('delete throws when nothing matched', async () => {
    rows = []
    await expect(run(useDeleteAction, 'a1')).rejects.toThrow(/permission to delete/)
  })
  it('individual toggle throws when nothing matched', async () => {
    rows = []
    await expect(run(useToggleActionDone, { actionId: 'a1', isGroupAction: false, userId: 'u1', done: true })).rejects.toThrow(
      /permission to update/
    )
  })
  it('propagates real database errors', async () => {
    dbError = { message: 'boom' }
    await expect(run(useDeleteAction, 'a1')).rejects.toThrow('boom')
  })
})
