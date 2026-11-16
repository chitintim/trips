import { assertEquals } from 'jsr:@std/assert@1'
import { parseNoticeRequest } from './request.ts'

const ID = '0b1f3b2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b'

Deno.test('parseNoticeRequest', () => {
  assertEquals(parseNoticeRequest({ settlement_id: ID }), { ok: true, settlementId: ID, event: 'paid' })
  assertEquals(parseNoticeRequest({ settlement_id: ID, event: 'confirmed' }), { ok: true, settlementId: ID, event: 'confirmed' })
  assertEquals(parseNoticeRequest({ settlement_id: ID.toUpperCase(), event: 'paid' }), { ok: true, settlementId: ID, event: 'paid' })
  for (const ev of ['re_ask', 'retracted', 'disputed'] as const) {
    assertEquals(parseNoticeRequest({ settlement_id: ID, event: ev }), { ok: true, settlementId: ID, event: ev })
  }
  for (const bad of [null, [], 'x', {}, { settlement_id: 'nope' }, { settlement_id: ID, event: 'refund' }, { settlement_id: 5 }]) {
    assertEquals(parseNoticeRequest(bad).ok, false)
  }
})
