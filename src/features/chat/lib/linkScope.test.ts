import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } } }))

import { detachedActions, resolveLink, withoutLinkCards } from './linkTargets'
import { reminderWords } from '../actions/addTodo'
import { envelope, todoParams } from './chatFixtures'

const link = (id: string, turn: string) => envelope('open_screen', { target: 'settle', id: null, open_param: 'settle' }, { id, requires: 'link', turn_id: turn })

describe('link cards belong to their turn and chat', () => {
  it('New chat / trip change drops link cards but keeps stored suggestions', () => {
    const known = { l1: link('l1', 't1'), a1: envelope('add_todo', todoParams(), { id: 'a1', turn_id: 't1' }) }
    expect(Object.keys(withoutLinkCards(known))).toEqual(['a1'])
  })
  it('a link card from an earlier turn is never drawn as a detached card under later turns', () => {
    const known = { l1: link('l1', 'old'), a1: envelope('add_todo', todoParams(), { id: 'a1', turn_id: 'old' }), a2: envelope('add_todo', todoParams(), { id: 'a2', turn_id: 'cur' }) }
    const out = detachedActions(known, 'cur', new Set())
    expect(out.map((a) => a.id)).toEqual(['a1'])
    expect(detachedActions({ l1: link('l1', 'old') }, null, new Set())).toEqual([])
  })
})

describe('link captions are neutral descriptions of where the button goes', () => {
  it('no caption claims an outcome, a refusal reason or a task', () => {
    for (const open of ['settle', 'decide:q1', 'claim:e1', 'todos', 'rsvp', 'setup']) {
      const r = resolveLink({ open_param: open })
      if (!r) continue
      expect(r.copy.message).toMatch(/^Opens /)
    }
  })
})

describe('reminder line on the add-to-do card', () => {
  it('promises no dates and says it depends on the to-do still being open', () => {
    const t = reminderWords('me', 'Tim')
    expect(t).toMatch(/still open/)
    expect(t).not.toMatch(/\d/)
    expect(reminderWords('anyone', 'Anyone')).toMatch(/until someone takes it/)
    expect(reminderWords('person', 'Sam')).toMatch(/^If it's still open, Sam gets/)
  })
})
