import { describe, it, expect } from 'vitest'
import { todayLocal, toLocalDateString } from './localDate'

describe('todayLocal', () => {
  it('uses the local calendar date, not the UTC date', () => {
    // Built from local parts, so this holds in any timezone the tests run in.
    const justAfterMidnight = new Date(2026, 5, 3, 0, 30, 0)
    expect(todayLocal(justAfterMidnight)).toBe('2026-06-03')
    const lateEvening = new Date(2026, 11, 31, 23, 45, 0)
    expect(todayLocal(lateEvening)).toBe('2026-12-31')
  })
  it('pads month and day', () => {
    expect(toLocalDateString(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
  it('defaults to now', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
