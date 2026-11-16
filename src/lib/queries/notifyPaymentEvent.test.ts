import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('../supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }))

import { buildPaymentNoticeBody, shouldNotifyPaymentEvent, notifyPaymentEvent } from './notifyPaymentEvent'

beforeEach(() => {
  invoke.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('buildPaymentNoticeBody', () => {
  it('sends only the id for a paid notice', () => expect(buildPaymentNoticeBody('s1', 'paid')).toEqual({ settlement_id: 's1' }))
  it('adds the event for a confirmed notice', () => expect(buildPaymentNoticeBody('s1', 'confirmed')).toEqual({ settlement_id: 's1', event: 'confirmed' }))
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
