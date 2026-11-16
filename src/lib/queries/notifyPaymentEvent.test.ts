import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('../supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }))

import { buildPaymentNoticeBody, shouldNotifyPaymentEvent, notifyPaymentEvent, notifyPaymentEventAndRefresh, invokePaymentNotice } from './notifyPaymentEvent'

beforeEach(() => {
  invoke.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('buildPaymentNoticeBody', () => {
  it('sends only the id for a paid notice', () => expect(buildPaymentNoticeBody('s1', 'paid')).toEqual({ settlement_id: 's1' }))
  it('adds the event for a confirmed notice', () => expect(buildPaymentNoticeBody('s1', 'confirmed')).toEqual({ settlement_id: 's1', event: 'confirmed' }))
  it.each(['re_ask', 'retracted', 'disputed'] as const)('adds the event for %s', (ev) => expect(buildPaymentNoticeBody('s1', ev)).toEqual({ settlement_id: 's1', event: ev }))
})

describe('shouldNotifyPaymentEvent', () => {
  it('notifies on marked_paid whoever did it', () => expect(shouldNotifyPaymentEvent({ newStatus: 'marked_paid', actorId: 'x', receiverId: 'r' })).toBe('paid'))
  it('notifies the payer when the receiver confirms', () => expect(shouldNotifyPaymentEvent({ newStatus: 'confirmed', actorId: 'r', receiverId: 'r' })).toBe('confirmed'))
  it('stays quiet when someone else confirms', () => expect(shouldNotifyPaymentEvent({ newStatus: 'confirmed', actorId: 'org', receiverId: 'r' })).toBeNull())
  it('stays quiet without a signed-in actor', () => expect(shouldNotifyPaymentEvent({ newStatus: 'confirmed', actorId: null, receiverId: 'r' })).toBeNull())
  it('ignores other statuses', () => expect(shouldNotifyPaymentEvent({ newStatus: 'suggested', actorId: 'r', receiverId: 'r' })).toBeNull())
})

describe('notifyPaymentEvent', () => {
  it('invokes payment-notice', async () => {
    invoke.mockResolvedValue({ data: {}, error: null })
    expect(await notifyPaymentEvent('s1', 'paid')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('payment-notice', { body: { settlement_id: 's1' } })
  })
  it('swallows a returned error (function not deployed)', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'Requested function was not found' } })
    expect(await notifyPaymentEvent('s1', 'paid')).toBe(false)
  })
  it('swallows a thrown error', async () => {
    invoke.mockRejectedValue(new Error('network'))
    expect(await notifyPaymentEvent('s1', 'confirmed')).toBe(false)
  })
})

describe('notifyPaymentEventAndRefresh', () => {
  it('refreshes the activity feed and settlements after the function answers, even on failure', async () => {
    const invalidateQueries = vi.fn()
    invoke.mockResolvedValue({ data: null, error: { message: 'nope' } })
    expect(await notifyPaymentEventAndRefresh({ invalidateQueries } as never, 't1', 's1', 'paid')).toBe(false)
    const keys = invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey.join('/'))
    expect(keys).toEqual(['trip/t1/activityFeed', 'trip/t1/settlements'])
  })
})

describe('invokePaymentNotice (D2: tells the truth)', () => {
  const httpError = (status: number, body: unknown) => ({ message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status }) })
  it('ok only when the function answered 200', async () => {
    invoke.mockResolvedValue({ data: { success: true }, error: null })
    expect(await invokePaymentNotice('s1', 're_ask')).toEqual({ ok: true })
  })
  it('a 409 carries the machine-readable reason', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(409, { success: false, reason: 'reask_limit' }) })
    expect(await invokePaymentNotice('s1', 're_ask')).toEqual({ ok: false, status: 409, reason: 'reask_limit' })
  })
  it('a 502 is a failure with its reason', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(502, { success: false, reason: 'send_failed' }) })
    expect(await invokePaymentNotice('s1', 're_ask')).toEqual({ ok: false, status: 502, reason: 'send_failed' })
  })
  it('an unreadable body or a thrown error is a failure without a reason', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'x', context: new Response('not json', { status: 500 }) } })
    expect(await invokePaymentNotice('s1', 're_ask')).toEqual({ ok: false, status: 500, reason: null })
    invoke.mockRejectedValue(new Error('network'))
    expect(await invokePaymentNotice('s1', 're_ask')).toEqual({ ok: false, status: null, reason: null })
  })
})
