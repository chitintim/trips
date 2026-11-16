import { describe, it, expect } from 'vitest'
import { isIdeasBucket } from './ideasBucket'
import { getManageActions } from '../features/decisions/lib/manageActions'

describe('isIdeasBucket', () => {
  it('reads metadata.ideas_bucket === true only', () => {
    expect(isIdeasBucket({ metadata: { ideas_bucket: true } })).toBe(true)
    expect(isIdeasBucket({ metadata: { ideas_bucket: 'true' } })).toBe(false)
    expect(isIdeasBucket({ metadata: null })).toBe(false)
    expect(isIdeasBucket({ metadata: [] })).toBe(false)
    expect(isIdeasBucket({})).toBe(false)
  })
})

describe('Manage actions for the Ideas bucket', () => {
  const ctx = { canManage: true, stage: 'open' as const, finished: false, shape: 'group' as const, hasOptions: true, waitingCount: 3, hasWinner: false, onThePlan: false, hasFollowupTodo: false, hasBooking: false }
  it('offers Decide and Nudge for a normal question, neither for Ideas', () => {
    const ids = (c: typeof ctx & { ideas?: boolean }) => getManageActions(c).map((a) => a.id)
    expect(ids(ctx)).toEqual(expect.arrayContaining(['decide', 'nudge']))
    expect(ids({ ...ctx, ideas: true })).not.toContain('decide')
    expect(ids({ ...ctx, ideas: true })).not.toContain('nudge')
    expect(ids({ ...ctx, ideas: true })).toContain('add_option')
  })
})
