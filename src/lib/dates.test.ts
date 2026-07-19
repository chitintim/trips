import { describe, it, expect } from 'vitest'
import { daysUntil, daysUntilClamped, deadlineUrgency, SOON_WITHIN_DAYS, URGENT_WITHIN_DAYS } from './dates'

describe('daysUntil', () => {
  it('is 0 for today', () => {
    const now = new Date('2026-07-10T15:30:00')
    expect(daysUntil('2026-07-10', now)).toBe(0)
  })

  it('counts whole days forward', () => {
    const now = new Date('2026-07-10T09:00:00')
    expect(daysUntil('2026-07-15', now)).toBe(5)
  })

  it('is negative for past dates', () => {
    const now = new Date('2026-07-10T09:00:00')
    expect(daysUntil('2026-07-05', now)).toBe(-5)
  })

  it('does not flicker within the same day regardless of time-of-day', () => {
    const morning = new Date('2026-07-10T00:05:00')
    const night = new Date('2026-07-10T23:55:00')
    expect(daysUntil('2026-07-15', morning)).toBe(daysUntil('2026-07-15', night))
  })
})

describe('daysUntilClamped', () => {
  it('clamps negative diffs to 0', () => {
    const now = new Date('2026-07-10T09:00:00')
    expect(daysUntilClamped('2026-07-05', now)).toBe(0)
  })

  it('passes through non-negative diffs', () => {
    const now = new Date('2026-07-10T09:00:00')
    expect(daysUntilClamped('2026-07-13', now)).toBe(3)
  })
})

describe('deadlineUrgency', () => {
  it('is overdue for any negative days-left', () => {
    expect(deadlineUrgency(-1)).toBe('overdue')
    expect(deadlineUrgency(-30)).toBe('overdue')
  })

  it('is urgent (red) from due-today through the urgent window, inclusive', () => {
    expect(deadlineUrgency(0)).toBe('urgent')
    expect(deadlineUrgency(1)).toBe('urgent')
    expect(deadlineUrgency(URGENT_WITHIN_DAYS)).toBe('urgent')
  })

  it('is soon (amber) from just past the urgent window through the soon window, inclusive', () => {
    expect(deadlineUrgency(URGENT_WITHIN_DAYS + 1)).toBe('soon')
    expect(deadlineUrgency(SOON_WITHIN_DAYS)).toBe('soon')
  })

  it('is normal beyond the soon window', () => {
    expect(deadlineUrgency(SOON_WITHIN_DAYS + 1)).toBe('normal')
    expect(deadlineUrgency(60)).toBe('normal')
  })

  it('pins the agreed thresholds: red ≤2 days, amber ≤7 days', () => {
    expect(URGENT_WITHIN_DAYS).toBe(2)
    expect(SOON_WITHIN_DAYS).toBe(7)
  })
})
