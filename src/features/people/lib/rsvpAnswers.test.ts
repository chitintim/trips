import { describe, it, expect } from 'vitest'
import { resolveCantSayYet, resolveImOut, resolveImIn, answerFromStatus, waitingOnFromStatus } from './rsvpAnswers'

describe('resolveImIn', () => {
  it('always resolves to confirmed', () => {
    expect(resolveImIn()).toEqual({ status: 'confirmed', conditionalType: 'none' })
  })
})

describe('resolveCantSayYet', () => {
  it('maps "date" to conditional/date', () => {
    expect(resolveCantSayYet('date')).toEqual({ status: 'conditional', conditionalType: 'date' })
  })
  it('maps "someone" to conditional/users', () => {
    expect(resolveCantSayYet('someone')).toEqual({ status: 'conditional', conditionalType: 'users' })
  })
  it('maps "both" to conditional/both', () => {
    expect(resolveCantSayYet('both')).toEqual({ status: 'conditional', conditionalType: 'both' })
  })
  it('maps "just-thinking" to interested/none', () => {
    expect(resolveCantSayYet('just-thinking')).toEqual({ status: 'interested', conditionalType: 'none' })
  })
})

describe('resolveImOut', () => {
  it('resolves to declined when the participant was not previously confirmed', () => {
    expect(resolveImOut(false)).toEqual({ status: 'declined', conditionalType: 'none' })
  })
  it('resolves to cancelled (self-service) when the participant was previously confirmed', () => {
    expect(resolveImOut(true)).toEqual({ status: 'cancelled', conditionalType: 'none' })
  })
})

describe('answerFromStatus', () => {
  it('maps confirmed -> in', () => {
    expect(answerFromStatus('confirmed')).toBe('in')
  })
  it('maps interested and conditional -> cant-say-yet', () => {
    expect(answerFromStatus('interested')).toBe('cant-say-yet')
    expect(answerFromStatus('conditional')).toBe('cant-say-yet')
  })
  it('maps declined and cancelled -> out', () => {
    expect(answerFromStatus('declined')).toBe('out')
    expect(answerFromStatus('cancelled')).toBe('out')
  })
  it('maps waitlist and pending (system states, never choices) -> null', () => {
    expect(answerFromStatus('waitlist')).toBeNull()
    expect(answerFromStatus('pending')).toBeNull()
  })
})

describe('waitingOnFromStatus', () => {
  it('maps interested -> just-thinking regardless of conditionalType', () => {
    expect(waitingOnFromStatus('interested', 'none')).toBe('just-thinking')
  })
  it('maps conditional/date -> date', () => {
    expect(waitingOnFromStatus('conditional', 'date')).toBe('date')
  })
  it('maps conditional/users -> someone', () => {
    expect(waitingOnFromStatus('conditional', 'users')).toBe('someone')
  })
  it('maps conditional/both -> both', () => {
    expect(waitingOnFromStatus('conditional', 'both')).toBe('both')
  })
  it('returns null for non-conditional, non-interested statuses', () => {
    expect(waitingOnFromStatus('confirmed', 'none')).toBeNull()
    expect(waitingOnFromStatus('declined', 'none')).toBeNull()
    expect(waitingOnFromStatus('waitlist', 'none')).toBeNull()
  })
})
