// Request parsing and rate-limit settings for payment-confirm (pure, unit-tested).
import { isPlausibleToken } from '../_shared/paymentToken.ts'

/** 'peek' only READS (it consumes nothing); the other two change state. */
export type ConfirmAction = 'peek' | 'confirm' | 'not_received'

export type ConfirmPost = { ok: true; token: string; action: ConfirmAction } | { ok: false }

export function parseConfirmPost(body: unknown): ConfirmPost {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const b = body as Record<string, unknown>
  if (!isPlausibleToken(b.t)) return { ok: false }
  if (b.action !== 'peek' && b.action !== 'confirm' && b.action !== 'not_received') return { ok: false }
  return { ok: true, token: b.t, action: b.action }
}

/** Fixed windows (payment_confirm_rate_hit). Generous for a human, useless for a script. */
export const RATE = {
  ipRead: { limit: 60, windowSeconds: 600 },
  tokenRead: { limit: 30, windowSeconds: 600 },
  ipWrite: { limit: 20, windowSeconds: 600 },
  tokenWrite: { limit: 10, windowSeconds: 600 },
} as const
