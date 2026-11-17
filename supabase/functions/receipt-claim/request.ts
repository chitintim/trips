// Request parsing and rate-limit settings for receipt-claim (pure, unit-tested).
import { isPlausibleToken } from '../_shared/paymentToken.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 'peek' only READS; the others change state through receipt_claim_act. */
export type ClaimPostAction = 'peek' | 'done' | 'not_there' | 'undo_done' | 'toggle'
const ACTIONS: readonly string[] = ['peek', 'done', 'not_there', 'undo_done', 'toggle']

export type ClaimPost =
  | { ok: true; token: string; action: 'peek' }
  | { ok: true; token: string; action: 'done' | 'not_there' | 'undo_done' }
  | { ok: true; token: string; action: 'toggle'; lineItemId: string; on: boolean | null }
  | { ok: false }

export function parseClaimPost(body: unknown): ClaimPost {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const b = body as Record<string, unknown>
  if (!isPlausibleToken(b.t)) return { ok: false }
  if (typeof b.action !== 'string' || !ACTIONS.includes(b.action)) return { ok: false }
  if (b.action === 'toggle') {
    if (typeof b.line_item_id !== 'string' || !UUID_RE.test(b.line_item_id)) return { ok: false }
    if (b.on !== undefined && b.on !== null && typeof b.on !== 'boolean') return { ok: false }
    return { ok: true, token: b.t, action: 'toggle', lineItemId: b.line_item_id.toLowerCase(), on: typeof b.on === 'boolean' ? b.on : null }
  }
  return { ok: true, token: b.t, action: b.action as 'peek' | 'done' | 'not_there' | 'undo_done' }
}

/** Fixed windows (receipt_claim_rate_hit). Generous for a human (several taps per receipt), useless for a script. */
export const RATE = {
  ipRead: { limit: 60, windowSeconds: 600 },
  tokenRead: { limit: 30, windowSeconds: 600 },
  ipWrite: { limit: 60, windowSeconds: 600 },
  tokenWrite: { limit: 40, windowSeconds: 600 },
} as const
