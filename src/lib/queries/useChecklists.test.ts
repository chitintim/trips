/**
 * Regression coverage for the organizer Activity feed bug: the same
 * checklist item getting "ticked off" multiple times in a few seconds from
 * one rapid on/off/on double-tap (fat-finger or a retry on a slow network).
 * Two independent guards are covered here:
 *  - useChecklistTogglePendingIds: per-item (not global) in-flight state,
 *    read from react-query's mutation cache rather than a single
 *    useMutation()'s last-call-wins isPending/variables.
 *  - shouldLogChecklistCompletion: a short client-side coalescing window
 *    so a rapid double-fire doesn't write duplicate activity_feed rows,
 *    without a DB unique constraint (legitimate re-completion weeks later
 *    must still log).
 *
 * react-query's hooks are mocked (same pattern as useExpenses.mutations.test.ts)
 * since this suite runs in vitest's node environment with no React renderer;
 * `useMutationState` is mocked to apply the real `select` callback over a
 * test-controlled list of fake mutation-cache entries, and `react`'s
 * useMemo is mocked to just invoke its callback (no dispatcher outside an
 * actual render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeMutationEntry {
  state: { variables: unknown }
}

let mutationStates: FakeMutationEntry[] = []

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutationState: (opts: { select: (entry: FakeMutationEntry) => unknown }) => mutationStates.map(opts.select),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useMemo: (fn: () => unknown) => fn() }
})

vi.mock('../supabase', () => ({ supabase: {} }))

import {
  useChecklistTogglePendingIds,
  shouldLogChecklistCompletion,
  __resetChecklistCompletionDedupeStateForTests,
} from './useChecklists'

beforeEach(() => {
  mutationStates = []
  __resetChecklistCompletionDedupeStateForTests()
})

describe('useChecklistTogglePendingIds', () => {
  it('returns an empty set when nothing is toggling', () => {
    expect(useChecklistTogglePendingIds('trip-1').size).toBe(0)
  })

  it('returns one entry per item currently in flight', () => {
    mutationStates = [
      { state: { variables: { id: 'item-1', done: true, doneBy: 'u1' } } },
      { state: { variables: { id: 'item-2', done: false, doneBy: 'u1' } } },
    ]
    expect(useChecklistTogglePendingIds('trip-1')).toEqual(new Set(['item-1', 'item-2']))
  })

  it('does not collapse two different in-flight items into one flag (would regress into a global pending state)', () => {
    mutationStates = [
      { state: { variables: { id: 'item-1', done: true, doneBy: 'u1' } } },
      { state: { variables: { id: 'item-2', done: true, doneBy: 'u1' } } },
    ]
    const ids = useChecklistTogglePendingIds('trip-1')
    expect(ids.has('item-1')).toBe(true)
    expect(ids.has('item-2')).toBe(true)
    expect(ids.has('item-3')).toBe(false)
  })
})

describe('shouldLogChecklistCompletion', () => {
  it('allows the first completion of an item', () => {
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 1_000)).toBe(true)
  })

  it('coalesces a rapid on/off/on double-tap into a single log within the window', () => {
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 1_000)).toBe(true)
    // 8 seconds later, same as the reported incident's timestamp spread.
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 9_000)).toBe(false)
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 29_999)).toBe(false)
  })

  it('logs again once the dedupe window has elapsed', () => {
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 1_000)).toBe(true)
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 1_000 + 30_000)).toBe(true)
  })

  it('does not coalesce across distinct items or distinct trips', () => {
    expect(shouldLogChecklistCompletion('trip-1', 'item-1', 1_000)).toBe(true)
    expect(shouldLogChecklistCompletion('trip-1', 'item-2', 1_000)).toBe(true)
    expect(shouldLogChecklistCompletion('trip-2', 'item-1', 1_000)).toBe(true)
  })
})
