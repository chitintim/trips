import { describe, it, expect } from 'vitest'
import {
  NO_RPC_SUPPORT,
  clearedPeopleLine,
  countToTell,
  deadlinePassed,
  describeSendReason,
  describeTableError,
  receiptColumnsOf,
  receiptTableSupport,
  sendOutcomeFrom,
  sentLine,
  failedLine,
  summarizeReplies,
  toTellLine,
} from './receiptTable'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

const ALL = { send: true, extend: true, apply: true, reopen: true, respond: true }
const today = { id: 'e1', paid_by: 'p' } // an expense row from before the migration: no claim columns
const draft = { ...today, claim_deadline: null, claims_sent_at: null, claims_closed_at: null }
const open = { ...draft, claims_sent_at: '2026-11-17T10:00:00Z', claim_deadline: '2026-11-20T18:00:00Z' }
const closed = { ...open, claims_closed_at: '2026-11-21T00:00:00Z' }

describe('fail-soft: nothing new appears before the migration', () => {
  it('no claim columns => every control is off, whatever else exists', () => {
    expect(receiptColumnsOf(today)).toBeNull()
    expect(receiptTableSupport({ expense: today, responsesAvailable: true, rpc: ALL })).toEqual({ canSend: false, canReply: false, hasStatus: false, phase: 'unavailable', columns: null, replyClosedReason: null })
    expect(receiptTableSupport({ expense: null, responsesAvailable: true, rpc: ALL }).phase).toBe('unavailable')
  })
  it('a partly applied migration shows only what is there', () => {
    expect(receiptTableSupport({ expense: { ...today, claim_deadline: null } as object, responsesAvailable: true, rpc: ALL }).phase).toBe('unavailable')
    // columns but no send function: cannot send; no responses table: cannot reply
    expect(receiptTableSupport({ expense: draft, responsesAvailable: true, rpc: NO_RPC_SUPPORT }).canSend).toBe(false)
    expect(receiptTableSupport({ expense: open, responsesAvailable: false, rpc: ALL }).canReply).toBe(false)
    // no respond_to_receipt: the reply controls stay hidden (there is no direct-write path)
    expect(receiptTableSupport({ expense: open, responsesAvailable: true, rpc: { ...ALL, respond: false } }).canReply).toBe(false)
  })
  it('unknown support (loading / offline) reads as none', () => {
    expect(receiptTableSupport({ expense: draft, responsesAvailable: false, rpc: NO_RPC_SUPPORT })).toMatchObject({ canSend: false, canReply: false, hasStatus: false, phase: 'draft' })
  })
})

describe('phases', () => {
  it('draft can send; open can reply and shows the status; closed only shows the status', () => {
    expect(receiptTableSupport({ expense: draft, responsesAvailable: true, rpc: ALL })).toMatchObject({ canSend: true, canReply: false, hasStatus: false, phase: 'draft' })
    expect(receiptTableSupport({ expense: open, responsesAvailable: true, rpc: ALL })).toMatchObject({ canSend: false, canReply: true, hasStatus: true, phase: 'open' })
    expect(receiptTableSupport({ expense: closed, responsesAvailable: true, rpc: ALL })).toMatchObject({ canSend: false, canReply: false, hasStatus: true, phase: 'closed' })
  })
})

const p = (id: string, name: string) => ({ user_id: id, user: { full_name: name, email: `${id}@x.com` } }) as unknown as ParticipantWithUser
const participants = [p('p', 'Tim Payer'), p('a', 'Ann Lee'), p('b', 'Bob Ray'), p('c', 'Cy Dun')]

describe('replies', () => {
  const responses = [
    { expense_id: 'e1', user_id: 'a', response: 'done' },
    { expense_id: 'e1', user_id: 'b', response: 'not_there' },
    { expense_id: 'other', user_id: 'c', response: 'done' },
  ]
  it('counts everyone but the payer, per receipt, with each person’s state', () => {
    const s = summarizeReplies({ peopleIds: ['p', 'a', 'b', 'c'], payerId: 'p', responses, expenseId: 'e1', participants })
    expect(s.total).toBe(3)
    expect(s.replied).toBe(2)
    expect(s.rows).toEqual([
      { userId: 'a', name: 'Ann', state: 'done' },
      { userId: 'b', name: 'Bob', state: 'not_there' },
      { userId: 'c', name: 'Cy', state: 'none' },
    ])
  })
  it('with the shared people rule (a "wasn’t there" person is off the receipt) the counts equal the to-dos and the person is still listed, last', () => {
    const s = summarizeReplies({ peopleIds: ['p', 'a', 'c'], payerId: 'p', responses, expenseId: 'e1', participants })
    expect(s.total).toBe(2)
    expect(s.replied).toBe(1)
    expect(s.rows.map((r) => [r.userId, r.state])).toEqual([['a', 'done'], ['c', 'none'], ['b', 'not_there']])
  })
  it('counts the most people a send can email: not the sender, not the payer, not anyone who already replied', () => {
    expect(countToTell({ peopleIds: ['p', 'a', 'b', 'c'], senderId: 'p', payerId: 'p', responses, expenseId: 'e1' })).toBe(1)
    expect(countToTell({ peopleIds: ['p', 'a'], senderId: 'p', payerId: 'p', responses: [], expenseId: 'e1' })).toBe(1)
    // a manager sends: the payer is not emailed about their own receipt
    expect(countToTell({ peopleIds: ['p', 'a', 'm'], senderId: 'm', payerId: 'p', responses: [], expenseId: 'e1' })).toBe(1)
  })
  it('words the promise as an upper bound', () => {
    expect(toTellLine(3)).toBe('Up to 3 people will be emailed.')
    expect(toTellLine(1)).toBe('Up to 1 person will be emailed.')
    expect(toTellLine(0)).toBe('Nobody else to tell yet.')
  })
})

describe('the reply window', () => {
  const open = { claim_deadline: '2026-11-20T18:00:00Z', claims_sent_at: '2026-11-17T09:00:00Z', claims_closed_at: null }
  it('replies are refused after the deadline, like the public page (and open before it)', () => {
    const before = receiptTableSupport({ expense: open, responsesAvailable: true, rpc: ALL, now: new Date('2026-11-20T17:59:00Z') })
    const after = receiptTableSupport({ expense: open, responsesAvailable: true, rpc: ALL, now: new Date('2026-11-20T18:00:01Z') })
    expect(before).toMatchObject({ canReply: true, replyClosedReason: null })
    expect(after).toMatchObject({ canReply: false, replyClosedReason: 'deadline_passed', phase: 'open' })
    expect(deadlinePassed(null, new Date())).toBe(false)
  })
})

describe('new function answers', () => {
  it('says emails are not set up and counts failures', () => {
    expect(sentLine({ sent: 0, skipped: 0, emailConfigured: false })).toContain("Emails aren't set up")
    expect(failedLine(2)).toBe("2 couldn't be sent — try again")
  })
  it('names the payer when the leftover person says they were not there', () => {
    expect(describeTableError({ hint: 'has_leftovers' }, undefined, 'Tim')).toBe('You were chosen to cover the leftovers on this receipt. Ask Tim to change that first.')
    expect(describeTableError({ hint: 'claims_closed' })).toContain('closed')
  })
  it('asks people who said that is everything to check again', () => {
    const ok = { ok: true, sent: 1, skipped: 0, failed: 0, alreadyTold: 0, emailConfigured: true, reason: null }
    expect(clearedPeopleLine(0, null, 2)).toBe('2 people who said "That\'s everything" will be asked to check again.')
    expect(clearedPeopleLine(1, ok, 1)).toContain('1 person who said')
  })
})

describe('re-itemising a sent receipt', () => {
  const ok = { ok: true, sent: 2, skipped: 0, failed: 0, alreadyTold: 0, emailConfigured: true, reason: null }
  it('tells the payer what happened to the people whose claims were cleared', () => {
    expect(clearedPeopleLine(2, null)).toBe("2 people's claims were cleared.")
    expect(clearedPeopleLine(1, ok)).toBe("1 person's claim was cleared. We emailed 2 people to look again.")
    expect(clearedPeopleLine(1, { ...ok, sent: 0 })).toContain("they'll see it in the app")
    expect(clearedPeopleLine(1, { ...ok, ok: false, reason: 'deadline_passed' })).toContain('nobody was emailed')
    expect(clearedPeopleLine(1, { ...ok, ok: false, reason: 'send_failed' })).toContain('Tell people what changed')
  })
})

describe('sending', () => {
  it('words the result without ever naming people', () => {
    expect(sentLine({ sent: 6, skipped: 2 })).toBe('Sent to 6 people · 2 skipped (no email, emails turned off, or emailed a lot today)')
    expect(sentLine({ sent: 0, skipped: 1, alreadyTold: 3 })).toBe('Sent to 0 people · 3 already told · 1 skipped (no email, emails turned off, or emailed a lot today)')
    expect(sentLine({ sent: 1, skipped: 0 })).toBe('Sent to 1 person')
  })
  it('reads the function’s answers', () => {
    expect(sendOutcomeFrom(200, { success: true, sent: 6, skipped: 2, failed: 0 })).toEqual({ ok: true, sent: 6, skipped: 2, failed: 0, alreadyTold: 0, emailConfigured: null, reason: null })
    expect(sendOutcomeFrom(200, { success: true, sent: 1, skipped: 0, failed: 0, already_told: 4, email_configured: false })).toMatchObject({ ok: true, alreadyTold: 4, emailConfigured: false })
    expect(sendOutcomeFrom(409, { success: false, reason: 'not_available' })).toMatchObject({ ok: false, reason: 'not_available' })
    expect(sendOutcomeFrom(409, null)).toMatchObject({ ok: false, reason: 'not_available' })
    expect(sendOutcomeFrom(502, { success: false, reason: 'send_failed', sent: 0, skipped: 3 })).toMatchObject({ ok: false, reason: 'send_failed', skipped: 3 })
    expect(sendOutcomeFrom(null, null)).toMatchObject({ ok: false, reason: null })
    expect(describeSendReason('deadline_passed')).toContain('Pick a later one')
    expect(describeSendReason('nonsense')).toBe("Couldn't send this. Try again.")
  })
  it('explains database refusals', () => {
    expect(describeTableError({ hint: 'payer_not_there' })).toContain("can't say you weren't there")
    expect(describeTableError({ hint: 'has_claims' })).toContain('take them off')
    expect(describeTableError({ hint: 'closed' })).toContain('closed')
    expect(describeTableError(new Error('x'))).toBe('Something went wrong. Try again.')
  })
})
