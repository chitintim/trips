// Same-day suppression of the daily `unconfirmed_settlement` reminder.
//
// The payment-notice function emails the receiver the moment a payment is
// marked paid (notifications.kind 'payment_paid_notice', dedupe key
// `notice:paid:<settlementId>:<receiverId>:1`). The daily job must not then
// nudge the same person about the same payment on the same UTC day. The
// recipient set of the daily job never grows because of this: it can only
// remove an item.
export { PAID_NOTICE_KIND } from '../_shared/paymentNoticeCore.ts'

export interface PaidNoticeRow {
  entity_id: string | null
  user_id: string
  sent_at: string
}

/** True when a paid notice for this settlement went to this person at or after the start of today (UTC). */
export function paidNoticeSentToday(rows: PaidNoticeRow[], settlementId: string, userId: string, todayStartIso: string): boolean {
  const since = new Date(todayStartIso).getTime()
  return rows.some((r) => r.entity_id === settlementId && r.user_id === userId && new Date(r.sent_at).getTime() >= since)
}
