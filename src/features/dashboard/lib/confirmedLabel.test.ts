import { describe, it, expect } from 'vitest'
import { confirmedCountLabel } from './confirmedLabel'

describe('confirmedCountLabel', () => {
  it('keeps the real confirmed count when confirmation tracking is on', () => {
    expect(
      confirmedCountLabel({ confirmation_enabled: true, confirmed_count: 4, participant_count: 10 })
    ).toBe('4 confirmed')
  })

  it('counts the whole active roster as confirmed when tracking is off', () => {
    expect(
      confirmedCountLabel({ confirmation_enabled: false, confirmed_count: 1, participant_count: 10 })
    ).toBe('10/10 confirmed')
  })

  it('treats a null confirmation_enabled as tracking off', () => {
    expect(
      confirmedCountLabel({ confirmation_enabled: null, confirmed_count: 0, participant_count: 3 })
    ).toBe('3/3 confirmed')
  })
})
