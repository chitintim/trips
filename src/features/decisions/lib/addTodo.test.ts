import { describe, it, expect, vi } from 'vitest'
import { addTodoAndLink } from './addTodo'

describe('addTodoAndLink', () => {
  it('merges the stamp over the CURRENT metadata, keeping other keys', async () => {
    const write = vi.fn(async () => {})
    const out = await addTodoAndLink({
      createAction: async () => ({ id: 'a1' }),
      readMetadata: async () => ({ decision_shape: 'vote', decided_option_id: 'o1' }),
      writeMetadata: write,
    })
    expect(out).toEqual({ action: { id: 'a1' }, linked: true })
    expect(write).toHaveBeenCalledWith({ decision_shape: 'vote', decided_option_id: 'o1', followup_action_id: 'a1' })
  })
  it('handles null metadata', async () => {
    const write = vi.fn(async () => {})
    await addTodoAndLink({ createAction: async () => ({ id: 'a1' }), readMetadata: async () => null, writeMetadata: write })
    expect(write).toHaveBeenCalledWith({ followup_action_id: 'a1' })
  })
  it('keeps the to-do when the stamp fails (read or write)', async () => {
    const a = await addTodoAndLink({ createAction: async () => ({ id: 'a1' }), readMetadata: async () => null, writeMetadata: async () => { throw new Error('denied') } })
    expect(a).toEqual({ action: { id: 'a1' }, linked: false, linkError: 'denied' })
    const b = await addTodoAndLink({ createAction: async () => ({ id: 'a1' }), readMetadata: async () => { throw new Error('offline') }, writeMetadata: vi.fn() })
    expect(b.linked).toBe(false)
  })
  it('throws when the to-do itself fails, writing nothing', async () => {
    const read = vi.fn()
    await expect(addTodoAndLink({ createAction: async () => { throw new Error('nope') }, readMetadata: read, writeMetadata: vi.fn() })).rejects.toThrow('nope')
    expect(read).not.toHaveBeenCalled()
  })
})
