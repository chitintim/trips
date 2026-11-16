import { describe, it, expect } from 'vitest'
import { countResettableConfirmations, countDeclined, describeResetCount } from './resetConfirmations'
import type { ConfirmationStatus } from '../../../lib/queries/useConfirmations'

const p = (confirmation_status: ConfirmationStatus | null, active = true) => ({ active, confirmation_status })

describe('countResettableConfirmations', () => {
  const roster = [
    p('confirmed'),
    p('confirmed'),
    p('interested'),
    p('conditional'),
    p('waitlist'),
    p('pending'),
    p('declined'),
    p('cancelled'),
    p('confirmed', false),
    p(null),
  ]

  it('counts committed statuses of active participants only', () => {
    expect(countResettableConfirmations(roster)).toBe(5)
  })

  it('adds declined only when asked', () => {
    expect(countResettableConfirmations(roster, true)).toBe(6)
  })

  it('never counts pending, cancelled, inactive or null statuses', () => {
    expect(countResettableConfirmations([p('pending'), p('cancelled'), p('confirmed', false), p(null)], true)).toBe(0)
  })
})

describe('countDeclined / describeResetCount', () => {
  it('counts active declined', () => {
    expect(countDeclined([p('declined'), p('declined', false), p('confirmed')])).toBe(1)
  })
  it('pluralises', () => {
    expect(describeResetCount(1)).toBe('1 confirmation')
    expect(describeResetCount(0)).toBe('0 confirmations')
    expect(describeResetCount(7)).toBe('7 confirmations')
  })
})
