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
// Body: { settlement_id } (event 'paid') or { settlement_id, event: 'confirmed' }.
// The answer is always just { success: true } once the caller is authorised: it never says whether an
// email was sent, skipped or capped (that would leak the receiver's email settings).
// Not gated by the trip's reminder switch (transactional), and outside the
// daily digest and its one-email-per-day cap.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, ForbiddenError, jsonResponse, ValidationError } from '../_shared/errors.ts'
import { callerClient, requireUser, serviceClient } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { getEmailSender } from '../_shared/emailSender.ts'
import { canManageTripFacts, mayRequestConfirmedNotice, mayRequestPaidNotice } from '../_shared/paymentNoticeCore.ts'
import { sendConfirmedNotice, sendPaidNotice } from '../_shared/paymentNoticeSend.ts'
import { parseNoticeRequest } from './request.ts'

const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai').replace(/\/$/, '')

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
      console.log('[payment-notice] confirmed:', result.sent ? 'sent' : result.reason)
      return jsonResponse({ success: true })
    }

    let canManage = false
    if (user.id !== s.from_user_id) {
      const [{ data: u }, { data: org }, { data: trip }] = await Promise.all([
        admin.from('users').select('role').eq('id', user.id).maybeSingle(),
        admin.from('trip_participants').select('user_id').eq('trip_id', s.trip_id).eq('user_id', user.id).eq('role', 'organizer').eq('active', true).maybeSingle(),
        admin.from('trips').select('created_by').eq('id', s.trip_id).maybeSingle(),
      ])
      canManage = canManageTripFacts({
        isSiteAdmin: u?.role === 'admin',
        isActiveOrganizer: !!org,
        isTripCreator: trip?.created_by === user.id,
      })
    }
    if (!mayRequestPaidNotice({ callerId: user.id, payerId: s.from_user_id, canManage })) throw new ForbiddenError()

    const result = await sendPaidNotice(admin, sender, { settlementId, actorId: user.id, appBaseUrl: APP_BASE_URL })
    // Never tell the caller whether (or why not) an email went out: that would reveal the receiver's
    // email preferences. The reason is logged for us only (no addresses, no tokens).
    console.log('[payment-notice] paid:', result.sent ? 'sent' : result.reason)
    return jsonResponse({ success: true })
  } catch (error) {
    return errorResponse(error)
  }
})
