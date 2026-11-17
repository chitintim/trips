// receipt-claim: the PUBLIC half of "claim your items from the email".
//
// verify_jwt = false: the personal token in the link IS the credential. Safe by construction (same discipline as payment-confirm):
//   * POST ONLY. The raw token travels in the JSON body, never in a URL, so it cannot land in the gateway / function request logs
//     (GET returns 405). In the email it sits in the URL fragment (`/receipt#t=<token>`), which browsers never send to any server; the
//     app page reads it and clears the address bar.
//   * POST { t, action: 'peek' } only READS (receipt_claim_peek); nothing a mail scanner or preview does can change anything.
//   * POST { t, action: 'done' | 'not_there' | 'undo_done' | 'toggle' } goes through the service-role-only receipt_claim_act, which
//     re-validates everything atomically (token live, deadline not passed, receipt not closed, trip not frozen, person on the receipt)
//     and only ever touches THAT person's own claims.
//   * No email is sent from here: the payer sees progress in the app.
//   * CORS is limited to the app's own origin (APP_BASE_URL plus RECEIPT_CLAIM_ALLOWED_ORIGINS); other origins get 403 and no data.
//   * Rate limited by IP and by token (receipt_claim_rate_hit, fixed windows). Fails closed if the counter is unreachable.
//   * Answers for an unknown or malformed token are identical ({ state: 'invalid' }); no token, hash or address is ever logged.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { serviceClient } from '../_shared/supabaseClients.ts'
import { hashToken, sha256Hex } from '../_shared/paymentToken.ts'
import { allowedOrigins, clientIp, isAllowedOrigin } from '../_shared/paymentNoticeCore.ts'
import { isMissingFunction, mapActResult, mapPeekResult, rateKey } from '../_shared/receiptNoticeCore.ts'
import { parseClaimPost, RATE } from './request.ts'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai').replace(/\/$/, '')
const ORIGINS = allowedOrigins(APP_BASE_URL, Deno.env.get('RECEIPT_CLAIM_ALLOWED_ORIGINS'))

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

const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' }

/** One rate-limit hit; false = over the limit. Fails closed if the counter is unreachable. */
async function allow(admin: SupabaseClient, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc('receipt_claim_rate_hit', { p_key: await sha256Hex(key), p_limit: limit, p_window_seconds: windowSeconds })
  if (error) {
    console.error('[receipt-claim] rate limit check failed')
    return false
  }
  return data === true
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (!isAllowedOrigin(origin, ORIGINS)) {
    // Not our app: no CORS headers, no data. (Also covers scanners and curl without an Origin.)
    return new Response(JSON.stringify({ state: 'invalid' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersFor(origin) })

  try {
    if (req.method !== 'POST') return reply(origin, { state: 'invalid' }, 405) // the token must never be in a URL

    const body = parseClaimPost(await req.json().catch(() => null))
    if (!body.ok) return reply(origin, { state: 'invalid' }, 400)

    const admin = serviceClient()
    const write = body.action !== 'peek'
    const ipRate = write ? RATE.ipWrite : RATE.ipRead
    const tokRate = write ? RATE.tokenWrite : RATE.tokenRead
    if (!(await allow(admin, rateKey('ip', clientIp(req.headers), write), ipRate.limit, ipRate.windowSeconds))) return reply(origin, TOO_MANY, 429)
    const hash = await hashToken(body.token)
    if (!(await allow(admin, rateKey('tok', hash, write), tokRate.limit, tokRate.windowSeconds))) return reply(origin, TOO_MANY, 429)

    if (body.action === 'peek') {
      const { data, error } = await admin.rpc('receipt_claim_peek', { p_token_hash: hash })
      if (error) {
        console.error('[receipt-claim] peek failed')
        return isMissingFunction(error) ? reply(origin, { state: 'unavailable' }, 503) : reply(origin, { state: 'invalid' }, 500)
      }
      const m = mapPeekResult(data)
      return reply(origin, m.body, m.status)
    }

    const payload = body.action === 'toggle' ? { line_item_id: body.lineItemId, ...(body.on === null ? {} : { on: body.on }) } : null
    const { data, error } = await admin.rpc('receipt_claim_act', { p_token_hash: hash, p_action: body.action, p_payload: payload })
    if (error) {
      console.error('[receipt-claim] act failed:', body.action)
      return isMissingFunction(error) ? reply(origin, { state: 'unavailable' }, 503) : reply(origin, { state: 'invalid' }, 500)
    }
    const m = mapActResult(data, body.action)
    return reply(origin, m.body, m.status)
  } catch {
    // Deliberately generic and silent: never echo or log the request.
    console.error('[receipt-claim] unexpected failure')
    return reply(origin, { state: 'invalid' }, 500)
  }
})
