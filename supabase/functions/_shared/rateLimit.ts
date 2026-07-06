/**
 * Rate limiting via the consume_rate_limit(p_feature, p_capacity,
 * p_refill_per_day) Postgres RPC (plan §13). The RPC is SECURITY DEFINER and
 * keys the bucket on auth.uid(), so it must be called through a client
 * carrying the CALLER's JWT (not the service role -- auth.uid() would be
 * null there). See migration 20260706153414_v2_additions.sql for the RPC
 * body (atomic token-bucket check-and-decrement).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { RateLimitedError } from './errors.ts'

export interface RateLimitConfig {
  feature: string
  capacity: number
  refillPerDay: number
}

/**
 * Consumes one token from the caller's bucket for `feature`. Throws
 * RateLimitedError if the bucket is empty. `client` must be a
 * caller-scoped client (see supabaseClients.ts callerClient) so that
 * auth.uid() resolves inside the RPC.
 */
export async function consumeRateLimit(client: SupabaseClient, config: RateLimitConfig): Promise<void> {
  const { data: allowed, error } = await client.rpc('consume_rate_limit', {
    p_feature: config.feature,
    p_capacity: config.capacity,
    p_refill_per_day: config.refillPerDay,
  })
  if (error) {
    console.error('[consumeRateLimit] RPC error:', error)
    throw new Error('Rate limit check failed')
  }
  if (!allowed) {
    throw new RateLimitedError(
      `You've reached your daily limit for this feature (${config.capacity}/day). Try again later.`
    )
  }
}

/** Per-feature rate limit presets (plan §10/§13/§14/§9). */
export const RATE_LIMITS = {
  /** parse-receipt: 20 parses/day/user (plan §10). */
  parseReceipt: { feature: 'parse_receipt', capacity: 20, refillPerDay: 20 },
  /** trip-chat: organizers 40/day, participants 15/day (plan §13). */
  chatOrganizer: { feature: 'trip_chat', capacity: 40, refillPerDay: 40 },
  chatParticipant: { feature: 'trip_chat', capacity: 15, refillPerDay: 15 },
  /** ingest: 10/day (plan §9). */
  ingest: { feature: 'ingest', capacity: 10, refillPerDay: 10 },
  /** nudge-draft: 20/day (plan §14). */
  nudgeDraft: { feature: 'nudge_draft', capacity: 20, refillPerDay: 20 },
} as const satisfies Record<string, RateLimitConfig>
