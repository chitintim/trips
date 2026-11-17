import { assertEquals } from 'jsr:@std/assert@1'
import { parseReceiptNoticeRequest, splitResendTargets } from './request.ts'

const ID = '123e4567-e89b-12d3-a456-426614174000'

Deno.test('parseReceiptNoticeRequest: defaults to send_to_table, lower-cases the id', () => {
  assertEquals(parseReceiptNoticeRequest({ expense_id: ID.toUpperCase() }), { ok: true, expenseId: ID, event: 'send_to_table', deadline: null, resendUserIds: [] })
})

Deno.test('parseReceiptNoticeRequest: result and reminder are not client events', () => {
  for (const event of ['result', 'reminder', 'extended', 'paid', 5, null]) {
    assertEquals(parseReceiptNoticeRequest({ expense_id: ID, event }).ok, false, String(event))
  }
})

Deno.test('parseReceiptNoticeRequest: deadline is normalised to ISO or refused', () => {
  const ok = parseReceiptNoticeRequest({ expense_id: ID, event: 'send_to_table', deadline: '2026-11-20T18:00:00+00:00' })
  assertEquals(ok, { ok: true, expenseId: ID, event: 'send_to_table', deadline: '2026-11-20T18:00:00.000Z', resendUserIds: [] })
  assertEquals(parseReceiptNoticeRequest({ expense_id: ID, deadline: null }).ok, true)
  for (const deadline of ['soon', 5, {}, 'x'.repeat(50)]) assertEquals(parseReceiptNoticeRequest({ expense_id: ID, deadline }).ok, false)
})

Deno.test('parseReceiptNoticeRequest: junk is refused', () => {
  for (const body of [null, undefined, 'x', [], {}, { expense_id: 5 }, { expense_id: 'not-a-uuid' }, { settlement_id: ID }]) {
    assertEquals(parseReceiptNoticeRequest(body).ok, false)
  }
})

Deno.test('parseReceiptNoticeRequest: resend_user_ids are uuids, lower-cased, de-duplicated, capped', () => {
  const U1 = '223e4567-e89b-12d3-a456-426614174001'
  const ok = parseReceiptNoticeRequest({ expense_id: ID, resend_user_ids: [U1.toUpperCase(), U1] })
  assertEquals(ok, { ok: true, expenseId: ID, event: 'send_to_table', deadline: null, resendUserIds: [U1] })
  assertEquals(parseReceiptNoticeRequest({ expense_id: ID, resend_user_ids: [] }).ok, true)
  assertEquals(parseReceiptNoticeRequest({ expense_id: ID, resend_user_ids: null }).ok, true)
  for (const bad of ['x', [5], ['not-a-uuid'], {}, Array.from({ length: 51 }, () => U1)]) {
    assertEquals(parseReceiptNoticeRequest({ expense_id: ID, resend_user_ids: bad }).ok, false)
  }
})

Deno.test('splitResendTargets: ids no longer on the receipt are dropped and counted, not an error', () => {
  assertEquals(splitResendTargets(['a', 'b', 'c'], new Set(['a', 'c'])), { keep: ['a', 'c'], dropped: 1 })
  assertEquals(splitResendTargets(['x'], new Set()), { keep: [], dropped: 1 })
  assertEquals(splitResendTargets([], new Set(['a'])), { keep: [], dropped: 0 })
})
