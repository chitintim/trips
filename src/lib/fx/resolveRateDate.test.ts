import { describe, it, expect } from 'vitest'
import { resolveRateDate } from './resolveRateDate'

describe('resolveRateDate', () => {
  it('returns the payment date unchanged for an ordinary weekday equal to today', () => {
    // 2026-07-06 is a Monday
    const result = resolveRateDate('2026-07-06', '2026-07-06')
    expect(result).toEqual({ resolvedDate: '2026-07-06', wasAdjusted: false, reason: 'none' })
  })

  it('returns the payment date unchanged for an ordinary past weekday', () => {
    // 2026-07-01 is a Wednesday
    const result = resolveRateDate('2026-07-01', '2026-07-06')
    expect(result).toEqual({ resolvedDate: '2026-07-01', wasAdjusted: false, reason: 'none' })
  })

  it('future date resolves to today', () => {
    // today (2026-07-06, Monday) with a future payment date
    const result = resolveRateDate('2026-07-10', '2026-07-06')
    expect(result.resolvedDate).toBe('2026-07-06')
    expect(result.wasAdjusted).toBe(true)
    expect(result.reason).toBe('future_date')
  })

  it('future date where today itself is a weekend walks back to Friday', () => {
    // today = Saturday 2026-07-04, payment date in the future
    const result = resolveRateDate('2026-07-10', '2026-07-04')
    expect(result.resolvedDate).toBe('2026-07-03') // Friday
    expect(result.wasAdjusted).toBe(true)
    expect(result.reason).toBe('future_date')
  })

  it('Saturday payment date walks back to Friday', () => {
    // 2026-07-04 is a Saturday
    const result = resolveRateDate('2026-07-04', '2026-07-06')
    expect(result.resolvedDate).toBe('2026-07-03')
    expect(result.wasAdjusted).toBe(true)
    expect(result.reason).toBe('weekend')
  })

  it('Sunday payment date walks back to Friday (crossing the weekend boundary)', () => {
    // 2026-07-05 is a Sunday
    const result = resolveRateDate('2026-07-05', '2026-07-06')
    expect(result.resolvedDate).toBe('2026-07-03')
    expect(result.wasAdjusted).toBe(true)
    expect(result.reason).toBe('weekend')
  })

  it('Monday is unaffected (not treated as needing a walk-back)', () => {
    // 2026-07-06 is a Monday
    const result = resolveRateDate('2026-07-06', '2026-07-06')
    expect(result.wasAdjusted).toBe(false)
  })

  it('handles the Fri/Mon boundary: Friday payment date is untouched', () => {
    // 2026-07-03 is a Friday
    const result = resolveRateDate('2026-07-03', '2026-07-06')
    expect(result.resolvedDate).toBe('2026-07-03')
    expect(result.wasAdjusted).toBe(false)
  })

  it('handles a payment date exactly today which happens to be a weekend', () => {
    // today = Sunday 2026-07-05, payment date = today
    const result = resolveRateDate('2026-07-05', '2026-07-05')
    expect(result.resolvedDate).toBe('2026-07-03')
    expect(result.wasAdjusted).toBe(true)
    expect(result.reason).toBe('weekend')
  })

  it('handles a far-future date the same as a near-future date (both -> today)', () => {
    const near = resolveRateDate('2026-07-07', '2026-07-06')
    const far = resolveRateDate('2027-01-01', '2026-07-06')
    expect(near.resolvedDate).toBe('2026-07-06')
    expect(far.resolvedDate).toBe('2026-07-06')
  })

  it('does not mutate across a month boundary incorrectly (Sat Aug 1 2026 -> Fri Jul 31)', () => {
    // 2026-08-01 is a Saturday
    const result = resolveRateDate('2026-08-01', '2026-08-03')
    expect(result.resolvedDate).toBe('2026-07-31')
    expect(result.reason).toBe('weekend')
  })

  it('does not mutate across a year boundary (Sat Jan 1 2028 -> Fri Dec 31 2027)', () => {
    // 2028-01-01 is a Saturday
    const result = resolveRateDate('2028-01-01', '2028-01-02')
    expect(result.resolvedDate).toBe('2027-12-31')
  })
})
