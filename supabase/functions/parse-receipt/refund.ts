// Gives the user's daily scan token back after a FAILED parse, but only when no
// model call ran. Once the API may have charged (success or a billed failure, or a
// timeout that hid the usage) the token stays spent, so repeated failures cannot be
// used to burn money for free.

import { modelMayHaveBilled } from '../_shared/anthropic.ts'

/** Minimal shape of the service-role client we need (kept narrow for tests). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string } | null }>
}

export interface RefundTarget {
  feature: string
  capacity: number
}

/** True when the failure happened before / without a completed model call. */
export function shouldRefund(error: unknown): boolean {
  return !modelMayHaveBilled(error)
}

/**
 * Best effort and fail-soft: calls refund_rate_limit(p_user_id, p_feature, p_capacity)
 * (service_role only) and logs only the error code. Returns whether a refund was requested.
 */
export async function refundIfUnbilled(client: RpcClient, userId: string, target: RefundTarget, error: unknown): Promise<boolean> {
  if (!shouldRefund(error)) return false
  try {
    const { error: rpcError } = await client.rpc('refund_rate_limit', {
      p_user_id: userId,
      p_feature: target.feature,
      p_capacity: target.capacity,
    })
    if (rpcError) console.error('[parse-receipt] refund_rate_limit failed:', rpcError.code ?? '')
  } catch {
    console.error('[parse-receipt] refund_rate_limit threw')
  }
  return true
}
