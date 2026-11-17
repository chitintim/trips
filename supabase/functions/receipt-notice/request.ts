// Request parsing for receipt-notice (pure, unit-tested).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The only event a signed-in client may ask for. Result and reminder emails are sent by the daily job (auto-chase) through _shared/receiptNoticeSend.ts. */
export type ReceiptNoticeEvent = 'send_to_table'

/** Most people a single call may ask to be emailed again. */
export const MAX_RESEND = 50

export type ReceiptNoticeRequest =
  | { ok: true; expenseId: string; event: ReceiptNoticeEvent; deadline: string | null; resendUserIds: string[] }
  | { ok: false; error: string }

export function parseReceiptNoticeRequest(body: unknown): ReceiptNoticeRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request' }
  const b = body as Record<string, unknown>
  if (typeof b.expense_id !== 'string' || !UUID_RE.test(b.expense_id)) return { ok: false, error: 'Invalid expense' }
  if (b.event !== undefined && b.event !== 'send_to_table') return { ok: false, error: 'Invalid event' }
  let deadline: string | null = null
  if (b.deadline !== undefined && b.deadline !== null) {
    if (typeof b.deadline !== 'string' || b.deadline.length > 40) return { ok: false, error: 'Invalid deadline' }
    const t = Date.parse(b.deadline)
    if (!Number.isFinite(t)) return { ok: false, error: 'Invalid deadline' }
    // The database enforces "future, within 90 days" (and says bad_deadline); this only normalises.
    deadline = new Date(t).toISOString()
  }
  // resend_user_ids: re-email these people even though their assigned items did not change (the database/caller checks are in index.ts).
  let resendUserIds: string[] = []
  if (b.resend_user_ids !== undefined && b.resend_user_ids !== null) {
    if (!Array.isArray(b.resend_user_ids) || b.resend_user_ids.length > MAX_RESEND) return { ok: false, error: 'Invalid recipients' }
    if (!b.resend_user_ids.every((x) => typeof x === 'string' && UUID_RE.test(x))) return { ok: false, error: 'Invalid recipients' }
    resendUserIds = [...new Set((b.resend_user_ids as string[]).map((x) => x.toLowerCase()))]
  }
  return { ok: true, expenseId: b.expense_id.toLowerCase(), event: 'send_to_table', deadline, resendUserIds }
}

/** Resend targets no longer on the receipt are dropped (counted as skipped), never an error for the whole call. */
export function splitResendTargets(requested: string[], onReceipt: Set<string>): { keep: string[]; dropped: number } {
  const keep = requested.filter((id) => onReceipt.has(id))
  return { keep, dropped: requested.length - keep.length }
}
