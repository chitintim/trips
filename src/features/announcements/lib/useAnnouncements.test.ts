/**
 * Dismissal-flow tests: closing the popup must (a) write the dismissal row
 * for the right user, (b) hide the announcement immediately and for the
 * whole session even when the insert fails (optimistic, no rollback), and
 * (c) treat "already dismissed on another device" (23505) as success.
 *
 * react-query is mocked to hand back the hook config so mutationFn/onMutate
 * can be exercised directly (node environment, no renderHook) — same
 * pattern as useExpenses.mutations.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const setQueryData = vi.fn()
const cancelQueries = vi.fn()
const invalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  useQueryClient: () => ({ setQueryData, cancelQueries, invalidateQueries }),
}))

const inserts: Array<{ table: string; payload: unknown }> = []
let insertError: { message: string; code?: string } | null = null

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (payload: unknown) => {
        inserts.push({ table, payload })
        return { error: insertError }
      },
    }),
  },
}))

// node env has no window; give sessionDismissals a real (fake) sessionStorage
// so the session-stickiness of a dismissal is observable.
const sessionStore = new Map<string, string>()
vi.stubGlobal('window', {
  sessionStorage: {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => void sessionStore.set(k, v),
  },
})

import { useDismissAnnouncement, announcementKeys, VisibleAnnouncementsData } from './useAnnouncements'
import { getSessionDismissedIds } from './sessionDismissals'

interface DismissHookConfig {
  mutationFn: (announcementId: string) => Promise<void>
  onMutate: (announcementId: string) => Promise<void>
  onError?: unknown
}

beforeEach(() => {
  inserts.length = 0
  insertError = null
  sessionStore.clear()
  setQueryData.mockClear()
  cancelQueries.mockClear()
  invalidateQueries.mockClear()
})

describe('useDismissAnnouncement mutationFn', () => {
  it('inserts the (announcement, user) dismissal row', async () => {
    await (useDismissAnnouncement('user-1') as unknown as DismissHookConfig).mutationFn('ann-1')
    expect(inserts).toEqual([
      { table: 'announcement_dismissals', payload: { announcement_id: 'ann-1', user_id: 'user-1' } },
    ])
  })

  it('treats a duplicate-key error (already dismissed elsewhere) as success', async () => {
    insertError = { message: 'duplicate key value violates unique constraint', code: '23505' }
    await expect((useDismissAnnouncement('user-1') as unknown as DismissHookConfig).mutationFn('ann-1')).resolves.toBeUndefined()
  })

  it('surfaces other insert errors', async () => {
    insertError = { message: 'permission denied', code: '42501' }
    await expect((useDismissAnnouncement('user-1') as unknown as DismissHookConfig).mutationFn('ann-1')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('useDismissAnnouncement optimistic hide', () => {
  it('marks the announcement dismissed in the cache before the insert settles', async () => {
    await (useDismissAnnouncement('user-1') as unknown as DismissHookConfig).onMutate('ann-1')

    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: announcementKeys.visible('user-1') })
    expect(setQueryData).toHaveBeenCalledTimes(1)
    const [key, updater] = setQueryData.mock.calls[0] as [
      unknown,
      (prev: VisibleAnnouncementsData | undefined) => VisibleAnnouncementsData | undefined,
    ]
    expect(key).toEqual(announcementKeys.visible('user-1'))

    const prev: VisibleAnnouncementsData = {
      announcements: [],
      dismissedIds: ['older'],
    }
    expect(updater(prev)?.dismissedIds).toEqual(['older', 'ann-1'])
    expect(updater(undefined)).toBeUndefined()
  })

  it('remembers the dismissal for the session so a failed insert cannot resurface it', async () => {
    await (useDismissAnnouncement('user-1') as unknown as DismissHookConfig).onMutate('ann-1')
    expect(getSessionDismissedIds()).toEqual(['ann-1'])
    // No rollback handler: a failed insert must leave the optimistic hide in place.
    expect((useDismissAnnouncement('user-1') as unknown as DismissHookConfig).onError).toBeUndefined()
  })
})
