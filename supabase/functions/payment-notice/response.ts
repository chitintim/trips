// Turns what a notice sender did into an HTTP answer (pure, unit-tested).
//
//   200 { success: true }                      the thing happened, or there was nothing to do and nobody needs to know.
//                                              This includes every reason that would reveal the RECIPIENT's email
//                                              settings (opted out, no address, no provider): to the caller those are a
//                                              silent success, as designed. It also covers repeats (already sent).
//   409 { success: false, reason }             the request is refused; `reason` is machine-readable:
//                                                reask_limit  the payer already asked twice
//                                                not_disputed the receiver has not said "not received" (or already answered)
//                                                wrong_state  the payment is not in the state this event needs
//                                                capped       a sending cap was reached (daily / per payment)
//   502 { success: false, reason }             our side failed: send_failed, token_failed, clear_failed, state_failed.
//                                              Nothing is left half-done: a failed re-ask restores the flag.
// 403 (not your payment / not allowed to ask) and 429 (rate limit) come from the checks before the sender runs.
import type { NoticeEvent } from './request.ts'

export interface SenderOutcome {
  sent: boolean
  reason: string | null
}

export type NoticeRefusal = 'reask_limit' | 'not_disputed' | 'wrong_state' | 'capped'
export type NoticeFailure = 'send_failed' | 'token_failed' | 'clear_failed' | 'state_failed'

/** Reasons that are a success from the caller's side: they would reveal the recipient's settings, or are idempotent repeats. */
const SILENT_OK = new Set(['opt_out', 'no_email', 'no_channel', 'same_person', 'self_recorded', 'already_sent'])
const WRONG_STATE = new Set(['not_marked_paid', 'not_confirmed', 'not_suggested', 'never_notified', 'not_retracted', 'retract_stale', 'not_found'])
const FAILURES = new Set<string>(['send_failed', 'token_failed', 'clear_failed', 'state_failed'])

export function noticeResponse(event: NoticeEvent, r: SenderOutcome): { status: number; body: Record<string, unknown> } {
  if (r.sent) return { status: 200, body: { success: true } }
  const reason = r.reason ?? 'wrong_state'
  // A re-ask that lost a race (another re-ask got the notice slot first) did not happen: say so.
  if (event === 're_ask' && reason === 'already_sent') return { status: 409, body: { success: false, reason: 'wrong_state' } }
  if (SILENT_OK.has(reason)) return { status: 200, body: { success: true } }
  if (FAILURES.has(reason)) return { status: 502, body: { success: false, reason } }
  if (reason === 'reask_limit' || reason === 'not_disputed' || reason === 'capped') return { status: 409, body: { success: false, reason } }
  if (WRONG_STATE.has(reason)) return { status: 409, body: { success: false, reason: 'wrong_state' } }
  return { status: 409, body: { success: false, reason: 'wrong_state' } }
}
