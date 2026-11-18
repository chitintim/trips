import { describe, it, expect } from 'vitest'
import { storedLinks, resolveLink } from './linkTargets'
import { statusLine } from './turnStatus'

const ID = '22222222-2222-4222-8222-222222222222'

describe('buttons kept with a stored reply', () => {
  it('rebuilds the same button a live link card gives, from target + id only (the shape the function writes)', () => {
    const stored = { links: [{ target: 'claim', id: ID, subject: 'Test dinner' }, { target: 'settle', id: null, subject: null }], action_ids: ['a'] }
    const out = storedLinks(stored)
    expect(out).toEqual([resolveLink({ open_param: `claim:${ID}` }), resolveLink({ open_param: 'settle' })])
    expect(out[0].copy.button).toBe('Open the receipt')
    expect(out[1].copy.button).toBe('Open Settle up')
  })

  it('old rows (no metadata, other metadata, wrong types) show no buttons', () => {
    for (const m of [null, undefined, {}, { proposal_id: 'p' }, 'x', 5, [], { links: 'settle' }, { links: {} }]) expect(storedLinks(m)).toEqual([])
  })

  it('ignores malformed entries and never trusts a stored URL or open_param', () => {
    const out = storedLinks({
      links: [
        { target: 'settle', id: null, open_param: 'claim:evil', href: 'https://evil.test' },
        null, 'settle', 7, {},
        { target: 'javascript:alert(1)', id: null },
        { target: 'https://evil.test', id: null },
        { target: 'constructor', id: null },
        { target: 'claim', id: null }, // needs an id
        { target: 'claim', id: 'not-a-uuid' },
        { target: 'settle', id: ID }, // takes no id
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0].openParam).toBe('settle')
  })

  it('reads at most five entries, each destination once', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ target: 'todo', id: `00000000-0000-4000-8000-00000000000${i}` }))
    expect(storedLinks({ links: [{ target: 'settle', id: null }, { target: 'settle', id: null }, ...many] })).toHaveLength(5)
  })
})

describe('status line', () => {
  it('shows the label while streaming, and nothing once the stream has ended', () => {
    expect(statusLine({ streaming: true, hasText: false, label: 'Finding the right screen…' })).toBe('Finding the right screen…')
    expect(statusLine({ streaming: true, hasText: false, label: null })).toBe('Thinking…')
    expect(statusLine({ streaming: true, hasText: true, label: null })).toBe('Working on it…')
    // done, error or cut off: even a label that was still set, and the "working" fallback, are gone
    expect(statusLine({ streaming: false, hasText: true, label: 'Finding the right screen…' })).toBeNull()
    expect(statusLine({ streaming: false, hasText: true, label: null })).toBeNull()
  })
})
