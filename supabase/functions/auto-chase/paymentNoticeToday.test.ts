import { assert, assertFalse } from 'jsr:@std/assert@1'
import { paidNoticeSentToday } from './paymentNoticeToday.ts'

const TODAY = '2026-11-20T00:00:00.000Z'
const rows = [{ entity_id: 's1', user_id: 'u1', sent_at: '2026-11-20T08:00:00.000Z' }]

Deno.test('a paid notice sent today suppresses the daily reminder for that payment and person', () => {
  assert(paidNoticeSentToday(rows, 's1', 'u1', TODAY))
})

Deno.test('a different payment or person is not suppressed', () => {
  assertFalse(paidNoticeSentToday(rows, 's2', 'u1', TODAY))
  assertFalse(paidNoticeSentToday(rows, 's1', 'u2', TODAY))
})

Deno.test('a notice from a previous UTC day does not suppress it', () => {
  assertFalse(paidNoticeSentToday([{ entity_id: 's1', user_id: 'u1', sent_at: '2026-11-19T23:59:59.000Z' }], 's1', 'u1', TODAY))
})

Deno.test('the start of the day itself counts as today', () => {
  assert(paidNoticeSentToday([{ entity_id: 's1', user_id: 'u1', sent_at: TODAY }], 's1', 'u1', TODAY))
})

Deno.test('no rows, nothing suppressed', () => {
  assertFalse(paidNoticeSentToday([], 's1', 'u1', TODAY))
})
