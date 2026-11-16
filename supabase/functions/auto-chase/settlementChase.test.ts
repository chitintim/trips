import { assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { CHASE_KINDS } from './chaseKinds.ts'
import { settlementChase } from './settlementChase.ts'
import { paidNoticeSentToday } from './paymentNoticeToday.ts'
import { PAID_NOTICE_KIND, REASK_NOTICE_KIND } from '../_shared/paymentNoticeCore.ts'

const row = (over: Record<string, unknown>) => ({ id: 's1', from_user_id: 'payer', to_user_id: 'recv', status: 'marked_paid', ...over })

Deno.test('suggested -> the payer is chased to pay', () => {
  assertEquals(settlementChase(row({ status: 'suggested' })), { kind: 'unpaid_settlement', userId: 'payer' })
})

Deno.test('marked_paid -> the receiver is chased to confirm (flag null or column missing)', () => {
  assertEquals(settlementChase(row({})), { kind: 'unconfirmed_settlement', userId: 'recv' })
  assertEquals(settlementChase(row({ receipt_disputed_at: null })), { kind: 'unconfirmed_settlement', userId: 'recv' })
})

Deno.test('marked_paid and disputed -> nobody is chased: not the receiver (already answered), not the payer (not "unpaid")', () => {
  assertEquals(settlementChase(row({ receipt_disputed_at: '2026-11-20T10:00:00Z' })), null)
})

Deno.test('confirmed -> nobody', () => {
  assertEquals(settlementChase(row({ status: 'confirmed' })), null)
})

Deno.test('the job only chases kinds it knows: nothing for the in-app respond_payment to-do', () => {
  assertFalse((CHASE_KINDS as readonly string[]).includes('respond_payment'))
  assertFalse(CHASE_KINDS.some((k) => k.startsWith('respond')))
  // the two payment kinds are exactly the ones settlementChase can return
  assertEquals(CHASE_KINDS.filter((k) => k.endsWith('_settlement')), ['unpaid_settlement', 'unconfirmed_settlement'])
})

Deno.test('a re-ask email earlier today also holds back the daily reminder', () => {
  const start = '2026-11-20T00:00:00Z'
  const rows = [{ entity_id: 's1', user_id: 'recv', sent_at: '2026-11-20T08:00:00Z' }]
  assertEquals(paidNoticeSentToday(rows, 's1', 'recv', start), true)
  assertEquals(REASK_NOTICE_KIND, 'payment_reask_notice')
  assertEquals(PAID_NOTICE_KIND, 'payment_paid_notice')
})
