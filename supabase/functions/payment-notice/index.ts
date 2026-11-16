// payment-notice: the immediate "X paid you" email to the RECEIVER when a
// payment becomes marked_paid, and the "X confirmed your payment" email to the
// PAYER when the receiver confirms it themself in the app.
//
// verify_jwt = true. The client calls it fire-and-forget after the status
// change succeeded; it trusts nothing from the caller beyond their identity
// (JWT) and a settlement id. With the service-role client it re-loads the
// settlement and checks the status, the caller's right to ask, that both people
// are on the trip, the email gates, a per-recipient daily cap and the dedupe row
// (see _shared/paymentNoticeSend.ts). Idempotent: a second
// call for the same payment sends nothing.
//
// Body: { settlement_id } (event 'paid') or { settlement_id, event } with event one of
//   'paid' (payer / manager), 'confirmed' (receiver), 're_ask' and 'retracted' (payer / manager),
//   'disputed' (receiver, in-app "It hasn't arrived").
// Answers (see ./response.ts): 200 { success: true } only when the thing happened (or nothing needs saying: a recipient
// who opted out is a silent success, so the receiver's email settings are never revealed); 409 { success:false, reason }
// for refusals (reask_limit, not_disputed, wrong_state, capped); 502 { success:false, reason } when OUR side failed
// (send_failed, token_failed, clear_failed, state_failed); 403 not allowed; 429 rate limited.
// Not gated by the trip's reminder switch (transactional), and outside the
// daily digest and its one-email-per-day cap.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, ForbiddenError, jsonResponse, ValidationError } from '../_shared/errors.ts'
import { callerClient, requireUser, serviceClient } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { getEmailSender } from '../_shared/emailSender.ts'
import { mayRequestConfirmedNotice, mayRequestDisputedNotice, mayRequestPaidNotice, mayRequestReAsk, mayRequestRetractedNotice } from '../_shared/paymentNoticeCore.ts'
import { sendConfirmedNotice, sendDisputedNotice, sendPaidNotice, sendReAskNotice, sendRetractedNotice, userCanManageTrip } from '../_shared/paymentNoticeSend.ts'
import { parseNoticeRequest, type NoticeEvent } from './request.ts'
import { noticeResponse } from './response.ts'

const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai').replace(/\/$/, '')

/** The reason is logged for us only (no addresses, no tokens); the caller gets the status from ./response.ts. */
function answer(event: NoticeEvent, result: { sent: boolean; reason: string | null }): Response {
  console.log(`[payment-notice] ${event}:`, result.sent ? 'sent' : result.reason)
  const { status, body } = noticeResponse(event, result)
  return jsonResponse(body, status)
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    if (req.method !== 'POST') throw new ValidationError('POST only')
    const parsed = parseNoticeRequest(await req.json().catch(() => null))
    if (!parsed.ok) throw new ValidationError(parsed.error)
    const { settlementId, event } = parsed

    const caller = callerClient(req)
    const user = await requireUser(caller)
    await consumeRateLimit(caller, RATE_LIMITS.paymentNotice)

    // Service role: reads the payment and the parties regardless of RLS, writes the dedupe row. Every use is gated below.
    const admin = serviceClient()
    const { data: s } = await admin
      .from('settlements')
      .select('id, trip_id, from_user_id, to_user_id')
      .eq('id', settlementId)
      .maybeSingle()
    // Same answer for "no such payment" and "not yours": do not reveal which payments exist.
    if (!s) throw new ForbiddenError()

    const sender = getEmailSender()

    if (event === 'confirmed') {
      if (!mayRequestConfirmedNotice({ callerId: user.id, receiverId: s.to_user_id })) throw new ForbiddenError()
      const result = await sendConfirmedNotice(admin, sender, { settlementId, appBaseUrl: APP_BASE_URL })
      return answer('confirmed', result)
    }

    const canManage = user.id !== s.from_user_id ? await userCanManageTrip(admin, s.trip_id, user.id) : false

    if (event === 'disputed') {
      if (!mayRequestDisputedNotice({ callerId: user.id, receiverId: s.to_user_id })) throw new ForbiddenError()
      const result = await sendDisputedNotice(admin, sender, { settlementId, appBaseUrl: APP_BASE_URL, requireFlag: true, activityActorId: user.id })
      return answer('disputed', result)
    }
    if (event === 're_ask') {
      if (!mayRequestReAsk({ callerId: user.id, payerId: s.from_user_id, canManage })) throw new ForbiddenError()
      const result = await sendReAskNotice(admin, sender, { settlementId, actorId: user.id, appBaseUrl: APP_BASE_URL })
      return answer('re_ask', result)
    }
    if (event === 'retracted') {
      if (!mayRequestRetractedNotice({ callerId: user.id, payerId: s.from_user_id, canManage })) throw new ForbiddenError()
      const result = await sendRetractedNotice(admin, sender, { settlementId, actorId: user.id, appBaseUrl: APP_BASE_URL })
      return answer('retracted', result)
    }
    if (!mayRequestPaidNotice({ callerId: user.id, payerId: s.from_user_id, canManage })) throw new ForbiddenError()

    const result = await sendPaidNotice(admin, sender, { settlementId, actorId: user.id, appBaseUrl: APP_BASE_URL })
    return answer('paid', result)
  } catch (error) {
    return errorResponse(error)
  }
})
