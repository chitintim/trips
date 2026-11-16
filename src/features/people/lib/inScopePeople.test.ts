import { describe, it, expect } from 'vitest'
import { inScopePeople, inScopeUserIds, inScopeHeadcount } from './inScopePeople'

const p = (user_id: string, confirmation_status: string, active = true) => ({ user_id, confirmation_status, active })

describe('inScopePeople', () => {
  it('tracking off: all active participants, regardless of status', () => {
    const list = [p('a', 'declined'), p('b', 'pending'), p('c', 'confirmed'), p('d', 'confirmed', false)]
    expect(inScopeUserIds(list, false)).toEqual(['a', 'b', 'c'])
  })
  it('tracking on: confirmed only when someone is confirmed', () => {
    const list = [p('a', 'confirmed'), p('b', 'pending'), p('c', 'declined'), p('d', 'confirmed')]
    expect(inScopeUserIds(list, true)).toEqual(['a', 'd'])
  })
  it('tracking on, nobody confirmed: everyone except declined/cancelled', () => {
    const list = [p('a', 'pending'), p('b', 'declined'), p('c', 'cancelled'), p('d', 'interested')]
    expect(inScopeUserIds(list, true)).toEqual(['a', 'd'])
  })
  it('treats missing active as active, drops inactive', () => {
    expect(inScopeUserIds([{ user_id: 'a', confirmation_status: 'confirmed' }, p('b', 'confirmed', false)], true)).toEqual(['a'])
  })
  it('empty input', () => {
    expect(inScopePeople([], true)).toEqual([])
  })
})

describe('inScopeHeadcount', () => {
  it('is exact only when tracking is on and someone is confirmed', () => {
    expect(inScopeHeadcount([p('a', 'confirmed'), p('b', 'pending')], true)).toEqual({ count: 1, isEstimate: false })
    expect(inScopeHeadcount([p('a', 'pending'), p('b', 'pending')], true)).toEqual({ count: 2, isEstimate: true })
    expect(inScopeHeadcount([p('a', 'confirmed'), p('b', 'pending')], false)).toEqual({ count: 2, isEstimate: true })
  })
})
