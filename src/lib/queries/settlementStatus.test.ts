import { describe, it, expect } from 'vitest'
import { askAgainErrorMessage, expectedPriorStatus } from './useSettlements'

describe('expectedPriorStatus', () => {
  it('only lets suggested -> marked_paid and marked_paid -> confirmed through', () => {
    expect(expectedPriorStatus('marked_paid')).toBe('suggested')
    expect(expectedPriorStatus('confirmed')).toBe('marked_paid')
    expect(expectedPriorStatus('suggested')).toBeNull()
  })
})

describe('askAgainErrorMessage (D2: the UI shows the truth)', () => {
  it('the limit has its own plain sentence', () => {
    expect(askAgainErrorMessage(409, 'reask_limit', 'Tim')).toBe("You've already asked twice — ask an organizer to help")
  })
  it('other refusals say what changed', () => {
    expect(askAgainErrorMessage(409, 'not_disputed', 'Tim')).toContain('Tim has already replied')
    expect(askAgainErrorMessage(409, 'wrong_state', 'Tim')).toContain('has changed')
    expect(askAgainErrorMessage(409, 'capped', 'Tim')).toContain('right now')
  })
  it('a server failure, a network failure or an unknown answer is a plain retryable error', () => {
    for (const [status, reason] of [[502, 'send_failed'], [502, 'clear_failed'], [null, null], [500, null]] as const) {
      expect(askAgainErrorMessage(status, reason, 'Tim')).toBe("Couldn't ask again. Check your connection and try again.")
    }
  })
  it('403 and 404 keep their wording', () => {
    expect(askAgainErrorMessage(403, null, 'Tim')).toContain("can't ask again")
    expect(askAgainErrorMessage(404, null, 'Tim')).toContain("isn't available yet")
  })
})
