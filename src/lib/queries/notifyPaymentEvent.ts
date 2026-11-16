import type { QueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'

export type PaymentEvent = 'paid' | 'confirmed' | 're_ask' | 'retracted' | 'disputed'

/** Request body for the `payment-notice` edge function. `paid` is the default event, so it sends only the id. */
export function buildPaymentNoticeBody(settlementId: string, event: PaymentEvent): { settlement_id: string; event?: Exclude<PaymentEvent, 'paid'> } {
  return event === 'paid' ? { settlement_id: settlementId } : { settlement_id: settlementId, event }
}

/**
 * The notice function writes activity rows ("Receipt request emailed to ...") and re-ask / dispute
 * state shortly after the status change, so refresh them once it has answered (success or not).
 */
export function refreshAfterPaymentNotice(queryClient: QueryClient, tripId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.activityFeed(tripId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.settlements(tripId) })
}

/** notifyPaymentEvent, then refresh what the function may have written. Never throws. */
export async function notifyPaymentEventAndRefresh(queryClient: QueryClient, tripId: string, settlementId: string, event: PaymentEvent): Promise<boolean> {
  const ok = await notifyPaymentEvent(settlementId, event)
  refreshAfterPaymentNotice(queryClient, tripId)
  return ok
}

/**
 * Whether a status change should trigger an email to the other party.
 * - paid: the row landed on marked_paid (receiver is asked to confirm).
 * - confirmed: the row landed on confirmed AND the receiver confirmed it themselves
 *   (an organizer confirming on their behalf, or a batch, sends nothing).
 */
export function shouldNotifyPaymentEvent(opts: { newStatus: string; actorId: string | null | undefined; receiverId: string }): PaymentEvent | null {
  if (opts.newStatus === 'marked_paid') return 'paid'
  if (opts.newStatus === 'confirmed' && !!opts.actorId && opts.actorId === opts.receiverId) return 'confirmed'
  return null
}

/** What payment-notice answered: ok = HTTP 200 (the thing happened, or nothing needed saying). */
export type PaymentNoticeOutcome = { ok: true } | { ok: false; status: number | null; reason: string | null }

/** Reads the machine-readable `reason` of a 409 / 502 answer, if there is one. */
async function readReason(error: unknown): Promise<{ status: number | null; reason: string | null }> {
  const ctx = (error as { context?: unknown } | null)?.context as Response | undefined
  const status = typeof ctx?.status === 'number' ? ctx.status : null
  try {
    const body = (await ctx?.clone?.().json?.()) as { reason?: unknown } | undefined
    return { status, reason: typeof body?.reason === 'string' ? body.reason : null }
  } catch {
    return { status, reason: null }
  }
}

/**
 * Call payment-notice and say exactly what happened. Never throws. 200 = ok; 409 carries `reason`
 * (reask_limit, not_disputed, wrong_state, capped); 502 = our side failed (send_failed, token_failed, ...).
 */
export async function invokePaymentNotice(settlementId: string, event: PaymentEvent): Promise<PaymentNoticeOutcome> {
  try {
    const { error } = await supabase.functions.invoke('payment-notice', { body: buildPaymentNoticeBody(settlementId, event) })
    if (!error) return { ok: true }
    console.warn('[payment-notice] not sent:', error.message)
    return { ok: false, ...(await readReason(error)) }
  } catch (err) {
    console.warn('[payment-notice] not sent:', err instanceof Error ? err.message : err)
    return { ok: false, status: null, reason: null }
  }
}

/**
 * Fire-and-forget: tell the server a payment moved so it can send the
 * transactional email. Never throws and never blocks or fails the mutation
 * that called it; a function that is not deployed is a soft no-op.
 */
export async function notifyPaymentEvent(settlementId: string, event: PaymentEvent): Promise<boolean> {
  return (await invokePaymentNotice(settlementId, event)).ok
}
