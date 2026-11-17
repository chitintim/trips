import { describe, it, expect } from 'vitest'
import {
  canPost,
  changeHint,
  parseReceipt,
  parseServerReply,
  refusedNotice,
  screenOf,
  shareLabel,
  startPosting,
  stateFromHttpFailure,
  stateFromReply,
  type PageState,
  type ReceiptView,
} from './receiptClaimState'
import { buildReceiptRequest } from './useReceiptClaim'
import { payload } from './receiptFixtures'

const view = (over: Record<string, unknown> = {}): ReceiptView => parseReceipt(payload(over)) as ReceiptView

describe('parsing', () => {
  it('reads the peek payload', () => {
    const r = view()
    expect(r).toMatchObject({ tripName: 'Alps', payerFirstName: 'Tim', meFirstName: 'Marj', myTotal: 42, deadline: '2026-11-20T18:00:00Z', editable: true })
    expect(r.myItems.map((i) => i.name)).toEqual(['Pizza', 'Red wine'])
    expect(r.availableItems).toHaveLength(1)
  })
  it('treats junk as invalid', () => {
    expect(parseReceipt(null)).toBeNull()
    expect(parseReceipt({ expense: {} })).toBeNull()
    expect(parseServerReply({ state: 'ok', receipt: {} })).toEqual({ state: 'invalid' })
    expect(parseServerReply('x')).toEqual({ state: 'invalid' })
    expect(parseServerReply({ state: 'whatever' })).toEqual({ state: 'invalid' })
  })
})

describe('states', () => {
  it('a plain look is never posting, and carries the hint only as a pre-selection', () => {
    const s = stateFromReply(parseServerReply({ state: 'ok', receipt: payload() }), 'done')
    expect(s).toMatchObject({ kind: 'ready', hint: 'done', posting: null, notice: null })
    expect(canPost(s)).toBe(true)
  })
  it('a refused tap shows the current truth with our own words', () => {
    const s = stateFromReply(parseServerReply({ state: 'refused', reason: 'deadline_passed', message: 'x', receipt: payload() }))
    expect(s).toMatchObject({ kind: 'ready', hint: null, notice: 'The time to reply has passed.' })
    expect(refusedNotice('weird')).toBe("That didn't go through. Nothing was changed.")
  })
  it('used / expired / invalid / feature-off states', () => {
    expect(stateFromReply({ state: 'expired' })).toEqual({ kind: 'dead', reason: 'expired' })
    expect(stateFromReply({ state: 'revoked' })).toEqual({ kind: 'dead', reason: 'revoked' })
    expect(stateFromReply({ state: 'invalid' })).toEqual({ kind: 'dead', reason: 'invalid' })
    expect(stateFromReply({ state: 'unavailable' })).toEqual({ kind: 'unavailable' })
    expect(stateFromHttpFailure(503)).toEqual({ kind: 'unavailable' })
    expect(stateFromHttpFailure(409)).toEqual({ kind: 'unavailable' })
    expect(stateFromHttpFailure(429)).toEqual({ kind: 'rate_limited' })
    expect(stateFromHttpFailure(403)).toEqual({ kind: 'dead', reason: 'invalid' })
    expect(stateFromHttpFailure(500)).toEqual({ kind: 'error', retry: 'load' })
  })
  it('a double tap cannot post twice, and the hint can be flipped only when idle', () => {
    const ready: PageState = { kind: 'ready', receipt: view(), hint: 'not_there', posting: null, notice: null }
    const posting = startPosting(ready, 'done')
    expect(posting).toMatchObject({ posting: 'done' })
    expect(startPosting(posting, 'not_there')).toBe(posting)
    expect(changeHint(posting)).toBe(posting)
    expect(changeHint(ready)).toMatchObject({ hint: 'done' })
  })
})

describe('which screen', () => {
  it('open / done / not there', () => {
    expect(screenOf(view())).toBe('open')
    expect(screenOf(view({ response: 'done' }))).toBe('done')
    expect(screenOf(view({ response: 'not_there' }))).toBe('not_there')
    expect(screenOf(view({ on_receipt: false }))).toBe('not_there')
  })
  it('closed and frozen win over the answer', () => {
    expect(screenOf(view({ response: 'done', closed_at: '2026-11-21T00:00:00Z', editable: false, closed_reason: 'closed' }))).toBe('closed')
    expect(screenOf(view({ frozen: true, editable: false, closed_reason: 'frozen' }))).toBe('frozen')
    expect(screenOf(view({ editable: false, closed_reason: 'deadline_passed' }))).toBe('read_only')
  })
  it('shows ÷N for shared items', () => {
    const r = view()
    expect(shareLabel(r.myItems[0])).toBe('÷3')
    expect(shareLabel(r.myItems[1])).toBeNull()
  })
})

describe('requests', () => {
  it('always POSTs the token in the body, never in a URL', () => {
    for (const req of [{ action: 'peek' }, { action: 'done' }, { action: 'not_there' }, { action: 'undo_done' }, { action: 'toggle', lineItemId: 'l1', on: true }] as const) {
      const r = buildReceiptRequest('tok', req)
      expect(r.method).toBe('POST')
      expect(r.referrerPolicy).toBe('no-referrer')
      expect(JSON.parse(r.body as string)).toMatchObject({ t: 'tok', action: req.action })
    }
    expect(JSON.parse(buildReceiptRequest('tok', { action: 'toggle', lineItemId: 'l1', on: false }).body as string)).toEqual({ t: 'tok', action: 'toggle', line_item_id: 'l1', on: false })
  })
})

describe('renamed refusal reasons', () => {
  it('claims_closed reads as closed and has_leftovers names the payer', () => {
    expect(refusedNotice('claims_closed')).toBe('This receipt has been closed.')
    expect(refusedNotice('has_leftovers', 'Tim')).toBe('You were chosen to cover the leftovers on this receipt. Ask Tim to change that first.')
  })
})
