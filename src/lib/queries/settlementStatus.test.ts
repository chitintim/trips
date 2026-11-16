import { describe, it, expect } from 'vitest'
import { expectedPriorStatus } from './useSettlements'

describe('expectedPriorStatus', () => {
  it('only lets suggested -> marked_paid and marked_paid -> confirmed through', () => {
    expect(expectedPriorStatus('marked_paid')).toBe('suggested')
    expect(expectedPriorStatus('confirmed')).toBe('marked_paid')
    expect(expectedPriorStatus('suggested')).toBeNull()
  })
})
