import { describe, it, expect } from 'vitest'
import { resolveAvatar } from './resolveAvatar'

/**
 * Avatar system v2 resolver order (UX_REDESIGN.md "Avatar system v2"):
 * avatar_url -> icon -> legacy emoji -> initials. Nothing here mutates
 * data -- these are pure-function checks that the priority order and the
 * "unwrap a raw user object" convenience both hold, since ~20 call sites
 * across the app rely on both.
 */
describe('resolveAvatar', () => {
  it('resolves a photo when avatarUrl is present', () => {
    expect(resolveAvatar({ avatarUrl: 'https://example.com/a.jpg' })).toEqual({
      kind: 'photo',
      url: 'https://example.com/a.jpg',
    })
  })

  it('prefers avatarUrl over avatarData when both are given', () => {
    const result = resolveAvatar({
      avatarUrl: 'https://example.com/a.jpg',
      avatarData: { emoji: '😊', bgColor: '#0ea5e9' },
    })
    expect(result.kind).toBe('photo')
  })

  it('resolves the v2 icon shape when there is no avatarUrl', () => {
    expect(
      resolveAvatar({ avatarData: { type: 'icon', icon: 'mountain', bgColor: '#0ea5e9' } })
    ).toEqual({ kind: 'icon', icon: 'mountain', bgColor: '#0ea5e9' })
  })

  it('falls back to legacy emoji shape when icon is unrecognized', () => {
    // Defends against a bad/renamed icon name in old data -- still falls
    // through to emoji resolution rather than throwing or rendering blank.
    const result = resolveAvatar({ avatarData: { type: 'icon', icon: 'not-a-real-icon', bgColor: '#fff' } })
    expect(result.kind).toBe('initials')
  })

  it('resolves the legacy emoji shape', () => {
    expect(
      resolveAvatar({ avatarData: { emoji: '🎉', accessory: '🎩', bgColor: '#f97316' } })
    ).toEqual({ kind: 'emoji', emoji: '🎉', accessory: '🎩', bgColor: '#f97316' })
  })

  it('falls back to initials when nothing is present', () => {
    expect(resolveAvatar({})).toEqual({ kind: 'initials' })
    expect(resolveAvatar({ avatarData: null })).toEqual({ kind: 'initials' })
  })

  it('unwraps a raw user-row-shaped object passed as avatarData (the common call-site convention)', () => {
    const user = { avatar_url: 'https://example.com/me.jpg', avatar_data: { emoji: '😊', bgColor: '#000' } }
    expect(resolveAvatar({ avatarData: user })).toEqual({ kind: 'photo', url: 'https://example.com/me.jpg' })
  })

  it('unwraps a raw user-row-shaped object with no avatar_url, falling through to its avatar_data', () => {
    const user = { avatar_url: null, avatar_data: { type: 'icon' as const, icon: 'sushi', bgColor: '#111' } }
    expect(resolveAvatar({ avatarData: user })).toEqual({ kind: 'icon', icon: 'sushi', bgColor: '#111' })
  })

  it('treats a bare legacy avatar_data blob (no avatar_url/avatar_data keys) as the emoji shape directly', () => {
    // This is the pre-v2 calling convention: <UserAvatar avatarData={user.avatar_data} />
    expect(resolveAvatar({ avatarData: { emoji: '🌟', bgColor: '#eab308' } })).toEqual({
      kind: 'emoji',
      emoji: '🌟',
      accessory: null,
      bgColor: '#eab308',
    })
  })
})
