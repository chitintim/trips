import { assertEquals } from 'jsr:@std/assert@1'
import { noticeResponse } from './response.ts'

const ok = { status: 200, body: { success: true } }
const refuse = (reason: string) => ({ status: 409, body: { success: false, reason } })
const fail = (reason: string) => ({ status: 502, body: { success: false, reason } })

Deno.test('200 only when something happened or nothing needs saying', () => {
  assertEquals(noticeResponse('re_ask', { sent: true, reason: null }), ok)
  assertEquals(noticeResponse('paid', { sent: true, reason: null }), ok)
})

Deno.test("the recipient's email settings are never revealed: opt-out, no address, no provider stay a silent success", () => {
  for (const reason of ['opt_out', 'no_email', 'no_channel']) {
    for (const event of ['paid', 'confirmed', 're_ask', 'retracted', 'disputed'] as const) assertEquals(noticeResponse(event, { sent: false, reason }), ok)
  }
  assertEquals(noticeResponse('paid', { sent: false, reason: 'already_sent' }), ok)
  assertEquals(noticeResponse('paid', { sent: false, reason: 'self_recorded' }), ok)
})

Deno.test('refusals are 409 with a machine-readable reason', () => {
  assertEquals(noticeResponse('re_ask', { sent: false, reason: 'reask_limit' }), refuse('reask_limit'))
  assertEquals(noticeResponse('re_ask', { sent: false, reason: 'not_disputed' }), refuse('not_disputed'))
  assertEquals(noticeResponse('re_ask', { sent: false, reason: 'not_marked_paid' }), refuse('wrong_state'))
  assertEquals(noticeResponse('re_ask', { sent: false, reason: 'capped' }), refuse('capped'))
  assertEquals(noticeResponse('re_ask', { sent: false, reason: 'already_sent' }), refuse('wrong_state'))
  assertEquals(noticeResponse('paid', { sent: false, reason: 'not_marked_paid' }), refuse('wrong_state'))
  assertEquals(noticeResponse('retracted', { sent: false, reason: 'retract_stale' }), refuse('wrong_state'))
  assertEquals(noticeResponse('retracted', { sent: false, reason: 'not_retracted' }), refuse('wrong_state'))
  assertEquals(noticeResponse('disputed', { sent: false, reason: 'capped' }), refuse('capped'))
  assertEquals(noticeResponse('confirmed', { sent: false, reason: 'not_found' }), refuse('wrong_state'))
})

Deno.test('our own failures are 502', () => {
  for (const reason of ['send_failed', 'token_failed', 'clear_failed', 'state_failed']) assertEquals(noticeResponse('re_ask', { sent: false, reason }), fail(reason))
})

Deno.test('an unknown reason is a refusal, never a success', () => {
  assertEquals(noticeResponse('paid', { sent: false, reason: 'something_new' }), refuse('wrong_state'))
  assertEquals(noticeResponse('paid', { sent: false, reason: null }), refuse('wrong_state'))
})
