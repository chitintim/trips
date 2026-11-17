/**
 * Per-user DAILY SPEND ceiling for the assistant, on top of the message cap (30/40 a day).
 *
 * The spend is read back from what we recorded ourselves: ai_usage rows (function_name 'trip-chat',
 * estimated_cost_usd from the cache-weighted price table), summed over the last 24 hours across all trips.
 * Checked BEFORE the model is called; a turn that starts under the ceiling may finish over it by at most one
 * turn (bounded by MAX_TURN_COST_USD in loop.ts plus one call), so the daily worst case is ceiling + one turn.
 *
 * Env (Supabase secrets, optional): TRIP_CHAT_DAILY_USD_PARTICIPANT (default 1.50), TRIP_CHAT_DAILY_USD_ORGANISER (default 3).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { RateLimitedError } from '../_shared/errors.ts'

export const DEFAULT_DAILY_USD_PARTICIPANT = 1.5
export const DEFAULT_DAILY_USD_ORGANISER = 3
export const SPEND_LIMIT_MESSAGE = "You've used today's assistant allowance. Try again later."
export const SPEND_LIMIT_CODE = 'spend_limit'
export const DAILY_LIMIT_CODE = 'daily_limit'

export class SpendLimitError extends RateLimitedError {
  readonly code = SPEND_LIMIT_CODE
  constructor() { super(SPEND_LIMIT_MESSAGE) }
}

export function dailyLimitUsd(env: (n: string) => string | undefined, organiser: boolean): number {
  const raw = env(organiser ? 'TRIP_CHAT_DAILY_USD_ORGANISER' : 'TRIP_CHAT_DAILY_USD_PARTICIPANT')
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : organiser ? DEFAULT_DAILY_USD_ORGANISER : DEFAULT_DAILY_USD_PARTICIPANT
}

/** Dollars spent by this user on trip-chat in the last 24 hours, or null if it could not be read. */
export async function spentLast24hUsd(admin: SupabaseClient, userId: string, now: Date): Promise<number | null> {
  try {
    const since = new Date(now.getTime() - 86_400_000).toISOString()
    const { data, error } = await admin.from('ai_usage').select('estimated_cost_usd')
      .eq('user_id', userId).eq('function_name', 'trip-chat').gte('created_at', since).limit(5000)
    if (error || !data) return null
    return (data as Array<{ estimated_cost_usd: number | string | null }>).reduce((a, r) => a + (Number(r.estimated_cost_usd) || 0), 0)
  } catch {
    return null
  }
}

/** Throws SpendLimitError when the user is at or over today's ceiling. A read failure lets the turn through (the message cap still applies). */
export async function enforceDailySpend(admin: SupabaseClient, userId: string, organiser: boolean, env: (n: string) => string | undefined, now: Date): Promise<void> {
  const limit = dailyLimitUsd(env, organiser)
  const spent = await spentLast24hUsd(admin, userId, now)
  if (spent == null) { console.error('[trip-chat] could not read the daily spend'); return }
  if (spent >= limit) throw new SpendLimitError()
}
