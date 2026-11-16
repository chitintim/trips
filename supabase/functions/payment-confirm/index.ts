// payment-confirm: the PUBLIC half of "confirm receipt from the email".
//
// verify_jwt = false: the one-time token in the link IS the credential. Safe by
// construction:
//   * POST ONLY. The raw token travels in the JSON body, never in a URL, so it cannot land in the
//     gateway / function request logs (GET returns 405).
//   * POST { t, action: 'peek' } only READS and returns { state, payment? }; it consumes nothing and
//     writes nothing but the rate-limit counter, so nothing a mail scanner or preview does can confirm.
//   * POST { t, action: 'confirm' | 'not_received' } does the work through the
//     service-role-only RPCs confirm_payment_by_token / dispute_payment_by_token,
//     which re-validate everything atomically (unused, unexpired, payment still
//     marked_paid, same receiver, same amount and currency). A 'not_received' also emails the payer.
//   * CORS is limited to the app's own origin; requests with any other (or no)
//     Origin get nothing.
//   * Rate limited by IP and by token (payment_confirm_rate_hit, fixed window).
//   * Answers for an unknown or malformed token are identical ({ state: 'invalid' });
//     no token, hash or email address is ever logged.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { serviceClient } from '../_shared/supabaseClients.ts'
import { getEmailSender } from '../_shared/emailSender.ts'
import { formatMoneyExact } from '../_shared/paymentMoney.ts'
import { hashToken, sha256Hex } from '../_shared/paymentToken.ts'
import {
  allowedOrigins,
  clientIp,
  displayFirstName,
  isAllowedOrigin,
  mapRpcResult,
  mapTokenState,
  trimNote,
  type ConfirmState,
} from '../_shared/paymentNoticeCore.ts'
import { sendConfirmedNotice, sendDisputedNotice } from '../_shared/paymentNoticeSend.ts'
import { parseConfirmPost, RATE } from './request.ts'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai').replace(/\/$/, '')
const ORIGINS = allowedOrigins(APP_BASE_URL, Deno.env.get('PAYMENT_CONFIRM_ALLOWED_ORIGINS'))

function headersFor(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': 'application/json',
  }
}

function reply(origin: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headersFor(origin) })
}

interface PaymentSummary {
  payerName: string
  receiverName: string
  amount: number
  currency: string
  formatted: string
  tripName: string
  tripId: string
  settlementId: string
  note: string | null
}

async function loadSummary(admin: SupabaseClient, settlementId: string): Promise<PaymentSummary | null> {
  const { data: s } = await admin.from('settlements').select('trip_id, from_user_id, to_user_id, amount, currency, notes').eq('id', settlementId).maybeSingle()
  if (!s) return null
  const [{ data: trip }, { data: people }] = await Promise.all([
    admin.from('trips').select('id, name, base_currency').eq('id', s.trip_id).maybeSingle(),
    admin.from('users').select('id, first_name, full_name').in('id', [s.from_user_id, s.to_user_id]),
  ])
  const payer = (people ?? []).find((u) => u.id === s.from_user_id)
  const receiver = (people ?? []).find((u) => u.id === s.to_user_id)
  if (!trip) return null
  const currency = s.currency || trip.base_currency
  return {
    payerName: displayFirstName(payer),
    receiverName: displayFirstName(receiver),
    amount: Number(s.amount),
    currency,
    formatted: formatMoneyExact(Number(s.amount), currency),
    tripName: trip.name,
    tripId: trip.id,
    settlementId,
    note: trimNote(s.notes),
  }
}

/** One rate-limit hit; false = over the limit. Fails closed if the counter is unreachable. */
async function allow(admin: SupabaseClient, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc('payment_confirm_rate_hit', { p_key: await sha256Hex(key), p_limit: limit, p_window_seconds: windowSeconds })
  if (error) {
    console.error('[payment-confirm] rate limit check failed')
    return false
  }
  return data === true
}

/** The states in which showing the payment summary is useful (and harmless: the caller holds the token). */
const SHOW_SUMMARY: ConfirmState[] = ['valid', 'confirmed', 'disputed', 'asked_again', 'retracted']

const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' }

/** Read-only description of a token's payment. Writes nothing. */
async function peek(admin: SupabaseClient, hash: string): Promise<{ state: ConfirmState; payment?: PaymentSummary }> {
  const { data: token } = await admin
    .from('payment_confirm_tokens')
    .select('settlement_id, receiver_id, amount, currency, expires_at, used_at, used_action, created_at')
    .eq('token_hash', hash)
    .maybeSingle()
  let settlementFacts = null
  let newerToken = false
  if (token) {
    // receipt_disputed_at / last_retracted_at may not exist yet (migration not applied): retry without them, then
    // `undefined` = old behaviour.
    let withFlag = true
    let { data: s, error: sErr } = await admin.from('settlements').select('status, to_user_id, amount, currency, trip_id, receipt_disputed_at, last_retracted_at').eq('id', token.settlement_id).maybeSingle()
    if (sErr) {
      withFlag = false
      ;({ data: s } = await admin.from('settlements').select('status, to_user_id, amount, currency, trip_id').eq('id', token.settlement_id).maybeSingle())
    }
    // A newer link for the same payment exists (a re-ask, or a fresh paid email after the payment was taken back).
    const { count: newerCount } = await admin
      .from('payment_confirm_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('settlement_id', token.settlement_id)
      .gt('created_at', (token as { created_at: string }).created_at)
    newerToken = (newerCount ?? 0) > 0
    if (s) {
      const { data: trip } = await admin.from('trips').select('base_currency').eq('id', s.trip_id).maybeSingle()
      settlementFacts = {
        status: s.status,
        to_user_id: s.to_user_id,
        amount: Number(s.amount),
        currency: s.currency || trip?.base_currency || '',
        ...(withFlag
          ? {
              receipt_disputed_at: (s as { receipt_disputed_at?: string | null }).receipt_disputed_at ?? null,
              last_retracted_at: (s as { last_retracted_at?: string | null }).last_retracted_at ?? null,
            }
          : {}),
      }
    }
  }
  const state = mapTokenState({
    token: token ? { ...token, amount: Number(token.amount) } : null,
    settlement: settlementFacts,
    now: new Date(),
    newerToken,
  })
  const payment = token && SHOW_SUMMARY.includes(state) ? await loadSummary(admin, token.settlement_id) : null
  return payment ? { state, payment } : { state }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (!isAllowedOrigin(origin, ORIGINS)) {
    // Not our app: no CORS headers, no data. (Also covers scanners and curl without an Origin.)
    return new Response(JSON.stringify({ state: 'invalid' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersFor(origin) })

  try {
    const admin = serviceClient()
    const ip = clientIp(req.headers)

    if (req.method === 'POST') {
      const body = parseConfirmPost(await req.json().catch(() => null))
      if (!body.ok) return reply(origin, { state: 'invalid' }, 400)

      if (body.action === 'peek') {
        if (!(await allow(admin, `ip:${ip}`, RATE.ipRead.limit, RATE.ipRead.windowSeconds))) return reply(origin, TOO_MANY, 429)
        const hash = await hashToken(body.token)
        if (!(await allow(admin, `tok:${hash}`, RATE.tokenRead.limit, RATE.tokenRead.windowSeconds))) return reply(origin, TOO_MANY, 429)
        return reply(origin, await peek(admin, hash))
      }

      if (!(await allow(admin, `ip:${ip}:post`, RATE.ipWrite.limit, RATE.ipWrite.windowSeconds))) return reply(origin, TOO_MANY, 429)
      const hash = await hashToken(body.token)
      if (!(await allow(admin, `tok:${hash}:post`, RATE.tokenWrite.limit, RATE.tokenWrite.windowSeconds))) return reply(origin, TOO_MANY, 429)

      const fn = body.action === 'confirm' ? 'confirm_payment_by_token' : 'dispute_payment_by_token'
      const { data, error } = await admin.rpc(fn, { p_token_hash: hash })
      if (error) {
        console.error('[payment-confirm] rpc failed:', fn)
        return reply(origin, { state: 'invalid' }, 500)
      }
      const r = (data ?? {}) as { result?: string; settlement_id?: string; used_action?: string }
      // Anything other than "this very call confirmed / disputed it" shows the CURRENT truth, exactly as a peek would
      // (retracted, asked again, confirmed elsewhere, expired ...): an old link never regains power.
      if (r.result !== 'confirmed' && r.result !== 'disputed') return reply(origin, await peek(admin, hash))
      const state = mapRpcResult(r.result, r.used_action)

      // The email to the payer, only when this very call did the thing (the RPC result says so),
      // never for a repeat. Fail-soft: the confirmation / the dispute already stands.
      if (r.settlement_id && (r.result === 'confirmed' || r.result === 'disputed')) {
        try {
          const sender = getEmailSender()
          const opts = { settlementId: r.settlement_id, appBaseUrl: APP_BASE_URL }
          if (r.result === 'confirmed') await sendConfirmedNotice(admin, sender, opts)
          else await sendDisputedNotice(admin, sender, opts)
        } catch {
          console.error('[payment-confirm] notice failed:', r.result)
        }
      }
      const payment = r.settlement_id && SHOW_SUMMARY.includes(state) ? await loadSummary(admin, r.settlement_id) : null
      return reply(origin, payment ? { state, payment } : { state })
    }

    // GET (and anything else): the token must never be in a URL.
    return reply(origin, { state: 'invalid' }, 405)
  } catch {
    // Deliberately generic and silent: never echo or log the request.
    console.error('[payment-confirm] unexpected failure')
    return reply(origin, { state: 'invalid' }, 500)
  }
})
