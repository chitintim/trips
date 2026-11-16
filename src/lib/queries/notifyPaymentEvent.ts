import { supabase } from '../supabase'

export type PaymentEvent = 'paid' | 'confirmed'

/** Request body for the `payment-notice` edge function. `paid` is the default event, so it sends only the id. */
export function buildPaymentNoticeBody(settlementId: string, event: PaymentEvent): { settlement_id: string; event?: 'confirmed' } {
  return event === 'confirmed' ? { settlement_id: settlementId, event: 'confirmed' } : { settlement_id: settlementId }
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

/**
 * Fire-and-forget: tell the server a payment moved so it can send the
 * transactional email. Never throws and never blocks or fails the mutation
 * that called it; a function that is not deployed is a soft no-op.
 */
export async function notifyPaymentEvent(settlementId: string, event: PaymentEvent): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke('payment-notice', { body: buildPaymentNoticeBody(settlementId, event) })
    if (error) {
      console.warn('[payment-notice] not sent:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[payment-notice] not sent:', err instanceof Error ? err.message : err)
    return false
  }
}
