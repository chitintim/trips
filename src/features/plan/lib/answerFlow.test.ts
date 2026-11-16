import { describe, it, expect } from 'vitest'
import { freezeFlowIds, resolveFlowSteps, progressLabel, canAdvance, stepOutcome, summariseFlow } from './answerFlow'

describe('answerFlow', () => {
  it('freezes unique ids in order and resolves against live sections', () => {
    const ids = freezeFlowIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }])
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(resolveFlowSteps(ids, [{ id: 'c' }, { id: 'a' }]).map((s) => s.id)).toEqual(['a', 'c'])
  })

  it('labels progress', () => {
    expect(progressLabel(1, 5)).toBe('2 of 5')
    expect(progressLabel(9, 5)).toBe('5 of 5')
  })

  it('gates Next on an answer, a pass, or nothing to answer', () => {
    expect(canAdvance(undefined)).toBe(false)
    expect(canAdvance({ state: 'unanswered', closed: false })).toBe(false)
    expect(canAdvance({ state: 'answered', closed: false })).toBe(true)
    expect(canAdvance({ state: 'passed', closed: false })).toBe(true)
    expect(canAdvance({ state: 'unanswered', closed: true })).toBe(true)
  })

  it('classifies outcomes', () => {
    expect(stepOutcome({ state: 'unanswered', closed: false })).toBe('skipped')
    expect(stepOutcome({ state: 'unanswered', closed: true })).toBe('closed')
    expect(stepOutcome({ state: 'passed', closed: false })).toBe('passed')
    expect(stepOutcome(undefined)).toBe('skipped')
  })

  it('is truthful when something was skipped', () => {
    const s = summariseFlow(['a', 'b', 'c'], {
      a: { state: 'answered', closed: false },
      b: { state: 'unanswered', closed: false },
      c: { state: 'passed', closed: false },
    })
    expect(s.skippedIds).toEqual(['b'])
    expect(s.headline).toBe('1 question still needs your answer')
    expect(s.detail).toContain('1 answer saved')
    expect(s.detail).toContain('1 question passed on')
  })

  it('says all caught up only when nothing is skipped', () => {
    const s = summariseFlow(['a', 'b'], { a: { state: 'answered', closed: false }, b: { state: 'unanswered', closed: true } })
    expect(s.skippedIds).toEqual([])
    expect(s.headline).toBe("You're all caught up")
    expect(s.detail).toBe('1 answer saved, 1 question already closed.')
  })

  it('handles an empty flow', () => {
    expect(summariseFlow([], {}).headline).toBe('Nothing needs your answer')
  })
})
