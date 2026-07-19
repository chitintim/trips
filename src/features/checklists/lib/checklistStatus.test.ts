import { describe, it, expect } from 'vitest'
import { isBringItemOpenForUser, openBringCountForUser } from './checklistStatus'

describe('isBringItemOpenForUser', () => {
  it('unclaimed + unpacked concerns everyone', () => {
    expect(isBringItemOpenForUser({ done: false, assigned_to: null }, 'me')).toBe(true)
  })

  it('claimed by me + unpacked concerns me', () => {
    expect(isBringItemOpenForUser({ done: false, assigned_to: 'me' }, 'me')).toBe(true)
  })

  it('claimed by someone else does not concern me', () => {
    expect(isBringItemOpenForUser({ done: false, assigned_to: 'them' }, 'me')).toBe(false)
  })

  it('done items concern nobody, claimed or not', () => {
    expect(isBringItemOpenForUser({ done: true, assigned_to: null }, 'me')).toBe(false)
    expect(isBringItemOpenForUser({ done: true, assigned_to: 'me' }, 'me')).toBe(false)
  })
})

describe('openBringCountForUser', () => {
  const items = [
    { done: false, assigned_to: null }, // open, anyone
    { done: false, assigned_to: 'me' }, // open, mine
    { done: false, assigned_to: 'them' }, // open, theirs
    { done: true, assigned_to: null }, // done
    { done: true, assigned_to: 'me' }, // done
  ]

  it('counts unclaimed + claimed-by-me unpacked items only', () => {
    expect(openBringCountForUser(items, 'me')).toBe(2)
    expect(openBringCountForUser(items, 'them')).toBe(2)
  })

  it('is 0 without a user or without items', () => {
    expect(openBringCountForUser(items, undefined)).toBe(0)
    expect(openBringCountForUser(undefined, 'me')).toBe(0)
    expect(openBringCountForUser([], 'me')).toBe(0)
  })
})
