import { describe, it, expect } from 'vitest'
import { parseServerReply, stateFromReply, stateFromHttpFailure, canPost, startPosting, changeAnswer, parseAnswerHint, NO_TOKEN_STATE, COPY, type PaymentSummary } from './confirmPaymentState'

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
  it('valid with a payment is actionable', () => expect(stateFromReply({ state: 'valid', payment: pay })).toEqual({ kind: 'valid', payment: pay, answer: null, posting: null }))
  it('valid without a payment is invalid', () => expect(stateFromReply({ state: 'valid' })).toMatchObject({ kind: 'dead', reason: 'invalid' }))
  it('confirmed and disputed are done', () => {
    expect(stateFromReply({ state: 'confirmed', payment: pay })).toMatchObject({ kind: 'done', result: 'confirmed' })
    expect(stateFromReply({ state: 'disputed' }, null, 'post')).toMatchObject({ kind: 'done', result: 'disputed', payment: null })
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

describe('answer hint', () => {
  it('only yes and no are hints', () => {
    expect(parseAnswerHint('yes')).toBe('yes')
    expect(parseAnswerHint('no')).toBe('no')
    for (const junk of ['YES', 'maybe', '', null, undefined]) expect(parseAnswerHint(junk)).toBeNull()
  })
  it('a valid reply carries the hint; junk means both buttons', () => {
    expect(stateFromReply({ state: 'valid', payment: pay }, 'yes')).toMatchObject({ kind: 'valid', answer: 'yes' })
    expect(stateFromReply({ state: 'valid', payment: pay }, 'no')).toMatchObject({ answer: 'no' })
    expect(stateFromReply({ state: 'valid', payment: pay }, parseAnswerHint('zzz'))).toMatchObject({ answer: null })
  })
  it('change my answer flips and flips back, only when something is preselected', () => {
    const yes = stateFromReply({ state: 'valid', payment: pay }, 'yes')
    const no = changeAnswer(yes)
    expect(no).toMatchObject({ answer: 'no' })
    expect(changeAnswer(no)).toMatchObject({ answer: 'yes' })
    const none = stateFromReply({ state: 'valid', payment: pay })
    expect(changeAnswer(none)).toBe(none)
  })
  it('the answer is locked while posting and survives into the post', () => {
    const posting = startPosting(stateFromReply({ state: 'valid', payment: pay }, 'no'), 'not_received')
    expect(changeAnswer(posting)).toBe(posting)
    expect(posting).toMatchObject({ answer: 'no', posting: 'not_received' })
  })
})

describe('no token and returning links', () => {
  it('no token is its own state, not the generic invalid one', () => {
    expect(NO_TOKEN_STATE).toMatchObject({ kind: 'dead', reason: 'no_token' })
    expect(COPY.noToken).toBe('This link is missing its code — open the email again or open the app.')
  })
  it('peek of a disputed link shows the current truth; a press shows "we told them"', () => {
    expect(stateFromReply({ state: 'disputed', payment: pay })).toMatchObject({ kind: 'status', reason: 'disputed' })
    expect(stateFromReply({ state: 'disputed', payment: pay }, null, 'post')).toMatchObject({ kind: 'done', result: 'disputed' })
  })
  it('asked_again and retracted are read-only statuses', () => {
    expect(stateFromReply({ state: 'asked_again', payment: pay })).toMatchObject({ kind: 'status', reason: 'asked_again' })
    expect(stateFromReply({ state: 'retracted', payment: pay })).toMatchObject({ kind: 'status', reason: 'retracted' })
    expect(parseServerReply({ state: 'asked_again', payment: { ...pay, settlementId: 's1' } }).payment?.settlementId).toBe('s1')
  })
  it('copy', () => {
    expect(COPY.yesButton(pay)).toBe('Yes, I received £105.11 from Salim')
    expect(COPY.noButton(pay)).toBe("Tell Salim it hasn't arrived")
    expect(COPY.askedAgain('Salim')).toBe("Salim says they've sent it — check again.")
    expect(COPY.askedAgainHelp).toBe("We've emailed you a new link, or open the payment in the app.")
    expect(COPY.retracted('Salim')).toBe("Salim's payment is no longer marked as paid.")
    expect(COPY.told('Salim')).toBe("You told Salim it hasn't arrived.")
    expect(COPY.changeAnswer).toBe('Change my answer')
  })
})
