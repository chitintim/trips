import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'

/**
 * What the activity feed says about the receipt email for a payment.
 * Read from the activity feed (not `notifications`, which the payer cannot
 * read): `settlement_receipt_requested` is written when the email goes out,
 * `settlement_receipt_disputed` when the receiver says "I haven't received it".
 */
export const RECEIPT_REQUESTED_VERB = 'settlement_receipt_requested'
export const RECEIPT_DISPUTED_VERB = 'settlement_receipt_disputed'

export interface PaymentNoticeInfo {
  requestedAt: string | null
  disputedAt: string | null
}

function settlementIdOf(e: ActivityFeedEntry): string | null {
  const entity = e.entity && typeof e.entity === 'object' && !Array.isArray(e.entity) ? (e.entity as { id?: unknown }) : null
  return typeof entity?.id === 'string' ? entity.id : null
}

/**
 * Latest receipt-request and dispute time per settlement id.
 *
 * activity_feed rows can be inserted by any trip participant (with a null actor), so a row counts only
 * when its actor fits the claim: a dispute must come from the RECEIVER (the token flow writes it with
 * actor = receiver), a receipt request from the PAYER or someone who can manage the trip (the payment-notice
 * function writes it with actor = the caller it authorised). Rows with no actor are ignored.
 */
export function paymentNoticeBySettlement(
  entries: ActivityFeedEntry[],
  settlements: Array<Pick<Settlement, 'id' | 'from_user_id' | 'to_user_id'>>,
  managerIds: ReadonlySet<string>
): Map<string, PaymentNoticeInfo> {
  const parties = new Map(settlements.map((s) => [s.id, s]))
  const out = new Map<string, PaymentNoticeInfo>()
  for (const e of entries) {
    if (e.verb !== RECEIPT_REQUESTED_VERB && e.verb !== RECEIPT_DISPUTED_VERB) continue
    const id = settlementIdOf(e)
    const row = id ? parties.get(id) : undefined
    if (!id || !row || !e.actor) continue
    const trusted = e.verb === RECEIPT_DISPUTED_VERB ? e.actor === row.to_user_id : e.actor === row.from_user_id || managerIds.has(e.actor)
    if (!trusted) continue
    const at = e.created_at ?? ''
    const cur = out.get(id) ?? { requestedAt: null, disputedAt: null }
    if (e.verb === RECEIPT_REQUESTED_VERB) {
      if (!cur.requestedAt || cur.requestedAt < at) cur.requestedAt = at
    } else if (!cur.disputedAt || cur.disputedAt < at) cur.disputedAt = at
    out.set(id, cur)
  }
  return out
}

export interface NoticeViewer {
  viewerId: string | undefined
  canManageTrip: boolean
}

/** The extra caption lines for a marked-paid row (empty for other statuses). */
export function paymentNoticeLines(
  row: Pick<Settlement, 'status' | 'from_user_id' | 'to_user_id'>,
  info: PaymentNoticeInfo | undefined,
  viewer: NoticeViewer,
  receiverName: string,
  formatDate: (iso: string) => string
): string[] {
  if (row.status !== 'marked_paid' || !info) return []
  const isPayer = !!viewer.viewerId && viewer.viewerId === row.from_user_id
  const isReceiver = !!viewer.viewerId && viewer.viewerId === row.to_user_id
  const lines: string[] = []
  if (info.requestedAt && (isPayer || viewer.canManageTrip) && !isReceiver) {
    lines.push(`Receipt request emailed to ${receiverName} on ${formatDate(info.requestedAt)}`)
  }
  if (info.disputedAt && (isPayer || isReceiver || viewer.canManageTrip)) {
    lines.push(`${receiverName} says they haven't received this`)
  }
  return lines
}
