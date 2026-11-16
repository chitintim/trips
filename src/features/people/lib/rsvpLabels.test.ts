import { describe, it, expect } from 'vitest'
import { rsvpStatusLabel, rsvpChipFor, rsvpChipLabel, RSVP_CHIP_ORDER, RSVP_BUTTON_LABELS, RSVP_PROMPT } from './rsvpLabels'

describe('rsvpLabels', () => {
  it('maps every stored status to the agreed chip', () => {
    expect(rsvpStatusLabel('confirmed')).toBe('Going')
    expect(rsvpStatusLabel('interested')).toBe('Not sure')
    expect(rsvpStatusLabel('conditional')).toBe('Not sure')
    expect(rsvpStatusLabel('declined')).toBe('Not going')
    expect(rsvpStatusLabel('cancelled')).toBe('Not going')
    expect(rsvpStatusLabel('pending')).toBe('No reply yet')
    expect(rsvpStatusLabel('waitlist')).toBe('Waitlist')
  })

  it('treats a missing status as no reply yet', () => {
    expect(rsvpStatusLabel(null)).toBe('No reply yet')
    expect(rsvpStatusLabel(undefined)).toBe('No reply yet')
  })

  it('orders every chip exactly once', () => {
    expect([...RSVP_CHIP_ORDER].sort()).toEqual(['going', 'no-reply', 'not-going', 'not-sure', 'waitlist'])
    expect(RSVP_CHIP_ORDER.map(rsvpChipLabel)).toEqual(['Going', 'Not sure', 'No reply yet', 'Waitlist', 'Not going'])
    expect(rsvpChipFor('waitlist')).toBe('waitlist')
  })

  it('exposes the prompt and button words', () => {
    expect(RSVP_PROMPT).toBe('Are you coming?')
    expect(Object.values(RSVP_BUTTON_LABELS)).toEqual(["I'm in", 'Not sure yet', "Can't make it"])
  })
})
