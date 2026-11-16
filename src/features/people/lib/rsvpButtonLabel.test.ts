import { describe, expect, it } from 'vitest'
import { rsvpButtonLabel } from './rsvpButtonLabel'

describe('rsvpButtonLabel', () => {
  it('asks for a reply when none yet', () => {
    expect(rsvpButtonLabel('pending')).toBe('Reply')
    expect(rsvpButtonLabel(null)).toBe('Reply')
  })
  it('views a confirmed answer', () => expect(rsvpButtonLabel('confirmed')).toBe('View my answer'))
  it('updates other answers', () => {
    expect(rsvpButtonLabel('interested')).toBe('Update my answer')
    expect(rsvpButtonLabel('declined')).toBe('Update my answer')
  })
})
