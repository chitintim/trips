import { describe, it, expect } from 'vitest'
import { parseServerReply, stateFromReply, stateFromHttpFailure, canPost, startPosting, COPY, type PaymentSummary } from './confirmPaymentState'

const pay: PaymentSummary = { payerName: 'Salim', receiverName: 'Tim', amount: 105.11, currency: 'GBP', formatted: '£105.11', tripName: 'Japow', tripId: 't1', note: null }

describe('parseServerReply', () => {
  it('rejects junk as invalid', () => {
    expect(parseServerReply(null)).toEqual({ state: 'invalid' })
    expect(parseServerReply({ state: 'weird' })).toEqual({ state: 'invalid' })
  })
  it('keeps a well formed payment and drops blank notes', () => {
    const r = parseServerReply({ state: 'valid', payment: { ...pay, note: '  ' } })
    expect(r.state).toBe('valid')
    expect(r.payment?.note).toBeNull()
  })
  it('ignores a malformed payment', () => expect(parseServerReply({ state: 'valid', payment: { payerName: 1 } }).payment).toBeUndefined())
  it('needs the receiver name too (whose payment it is)', () => {
    const noReceiver = { ...pay, receiverName: undefined }
    expect(parseServerReply({ state: 'valid', payment: noReceiver }).payment).toBeUndefined()
    expect(parseServerReply({ state: 'valid', payment: pay }).payment?.receiverName).toBe('Tim')
  })
})

describe('stateFromReply', () => {
  it('valid with a payment is actionable', () => expect(stateFromReply({ state: 'valid', payment: pay })).toEqual({ kind: 'valid', payment: pay, posting: null }))
  it('valid without a payment is invalid', () => expect(stateFromReply({ state: 'valid' })).toMatchObject({ kind: 'dead', reason: 'invalid' }))
  it('confirmed and disputed are done', () => {
    expect(stateFromReply({ state: 'confirmed', payment: pay })).toMatchObject({ kind: 'done', result: 'confirmed' })
    expect(stateFromReply({ state: 'disputed' })).toMatchObject({ kind: 'done', result: 'disputed', payment: null })
  })
  it.each(['expired', 'changed', 'invalid'] as const)('%s is dead', (s) => expect(stateFromReply({ state: s })).toMatchObject({ kind: 'dead', reason: s }))
})

describe('failures and double taps', () => {
  it('429 is rate limited, anything else retryable', () => {
    expect(stateFromHttpFailure(429, 'post')).toEqual({ kind: 'rate_limited' })
    expect(stateFromHttpFailure(500, 'load')).toEqual({ kind: 'error', retry: 'load' })
    expect(stateFromHttpFailure(null, 'post')).toEqual({ kind: 'error', retry: 'post' })
    expect(stateFromHttpFailure(400, 'load')).toEqual({ kind: 'dead', reason: 'invalid', payment: null })
  })
  it('only the first tap posts', () => {
    const idle = stateFromReply({ state: 'valid', payment: pay })
    expect(canPost(idle)).toBe(true)
    const posting = startPosting(idle, 'confirm')
    expect(canPost(posting)).toBe(false)
    expect(startPosting(posting, 'not_received')).toBe(posting)
  })
})

describe('copy', () => {
  it('reads plainly', () => {
    expect(COPY.headline(pay)).toBe('Salim says they paid you £105.11 for Japow')
    expect(COPY.confirmedLine('Salim')).toContain("Salim will see it's received")
    expect(COPY.disputedLine('Salim')).toBe("Thanks. We've told Salim.")
    expect(COPY.forLine('Tim')).toBe('For Tim')
    expect(COPY.checkFirst).toBe('Check the money has arrived before you confirm.')
  })
})
