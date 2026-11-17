// receipt-notice: "Send to the table" for an itemised receipt. Sets the claim deadline (through the database function
// send_receipt_to_table, called AS THE CALLER so the database's own permission check applies) and emails each person on the receipt
// a personal link: "<Payer> put you down for £42.00 — <Receipt> · <Trip>".
//
// verify_jwt = true. The client calls it when the payer taps "Done — send to the table". It trusts nothing from the caller beyond their
// identity (JWT), an expense id and an optional deadline. With the service-role client it re-checks every email gate per recipient
// (see _shared/receiptNoticeSend.ts): trip switch, both people on the trip, email present, opt-out, provider, the per-person daily cap,
// the dedupe row. Idempotent: a second call sends nothing unless the payer changed a person's items (max 3 emails per person per receipt).
//
// Body: { expense_id, event?: 'send_to_table', deadline?: ISO string, resend_user_ids?: uuid[] }. `resend_user_ids` (payer / manager only, ids must be on the
// receipt) re-emails those people even if their assigned items did not change; the per-person-per-receipt cap of 3, the daily cap and every other gate still apply.
// Answers: 200 { success:true, sent, already_told, skipped, failed, email_configured, claim_deadline } (counts only: never who, never why a recipient was skipped);
// 401/403 (not allowed; the same answer for "no such receipt"); 409 { success:false, reason } for refusals
// (not_available, not_itemised, frozen, claims_closed, deadline_passed, bad_deadline, capped); 422 malformed; 429 rate limited;
// 502 { success:false, reason, sent:0, already_told, skipped, failed, email_configured } when OUR side failed for everyone attempted (send_failed, token_failed, state_failed).
// The result ("unclaimed items were added to your share") and reminder emails are NOT callable here: the daily job sends them.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCorsPreflight, corsHeaders } from '../_shared/cors.ts'
import { errorResponse, ForbiddenError, jsonResponse, ValidationError } from '../_shared/errors.ts'
import { callerClient, requireUser, serviceClient } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { getEmailSender } from '../_shared/emailSender.ts'
import { userCanManageTrip } from '../_shared/paymentNoticeSend.ts'
import { mapSendRpcError, mayRequestSendToTable, summariseSendOutcomes } from '../_shared/receiptNoticeCore.ts'
import { sendReceiptTableNotices } from '../_shared/receiptNoticeSend.ts'
import { parseReceiptNoticeRequest, splitResendTargets } from './request.ts'

const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai').replace(/\/$/, '')

function reply(status: number, body: unknown): Response {
  return status === 200 ? jsonResponse(body, 200) : new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    if (req.method !== 'POST') throw new ValidationError('POST only')
    const parsed = parseReceiptNoticeRequest(await req.json().catch(() => null))
    if (!parsed.ok) throw new ValidationError(parsed.error)
    const { expenseId, deadline } = parsed
    let resendUserIds = parsed.resendUserIds
    let droppedResend = 0

    const caller = callerClient(req)
    const user = await requireUser(caller)
    await consumeRateLimit(caller, RATE_LIMITS.receiptNotice)

    // Service role: reads the expense regardless of RLS (to answer "not yours" and "no such receipt" identically).
    const admin = serviceClient()
    const { data: e } = await admin.from('expenses').select('id, trip_id, paid_by').eq('id', expenseId).maybeSingle()
    if (!e) throw new ForbiddenError()
    const canManage = user.id !== e.paid_by ? await userCanManageTrip(admin, e.trip_id, user.id) : false
    if (!mayRequestSendToTable({ callerId: user.id, payerId: e.paid_by, canManage })) throw new ForbiddenError()

    // Resend targets no longer on the receipt are filtered out (counted in `skipped`), never an error for the whole call (checked BEFORE anything is written). The senders re-check every gate.
    if (resendUserIds.length > 0) {
      const { data: tagged, error: tErr } = await admin.rpc('_receipt_tagged', { p_expense_id: expenseId })
      if (tErr) {
        const failure = mapSendRpcError(tErr)
        return reply(failure.status, failure.body)
      }
      const onReceipt = new Set(Array.isArray(tagged) ? (tagged as unknown[]).filter((x): x is string => typeof x === 'string') : [])
      const split = splitResendTargets(resendUserIds, onReceipt)
      resendUserIds = split.keep
      droppedResend = split.dropped
    }

    // The deadline is set (and the receipt marked sent) by the database function, as the caller.
    const { data, error } = await caller.rpc('send_receipt_to_table', { p_expense_id: expenseId, p_deadline: deadline })
    if (error) {
      const failure = mapSendRpcError(error)
      console.log('[receipt-notice] send_to_table refused:', failure.status)
      return reply(failure.status, failure.body)
    }
    const r = (data ?? {}) as { notify_user_ids?: unknown; claim_deadline?: string | null }
    const userIds = Array.isArray(r.notify_user_ids) ? r.notify_user_ids.filter((x): x is string => typeof x === 'string') : []

    const sender = getEmailSender()
    const outcomes = await sendReceiptTableNotices(admin, sender, { expenseId, userIds, actorId: user.id, appBaseUrl: APP_BASE_URL, resendUserIds })
    const summary = summariseSendOutcomes(outcomes)
    const status = summary.status
    const body = status === 200 ? { ...summary.body, skipped: Number(summary.body.skipped ?? 0) + droppedResend } : summary.body
    console.log('[receipt-notice] send_to_table:', JSON.stringify({ status, sent: body.sent ?? 0, recipients: outcomes.length }))
    return reply(status, status === 200 ? { ...body, claim_deadline: r.claim_deadline ?? null } : body)
  } catch (error) {
    return errorResponse(error)
  }
})
