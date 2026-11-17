/**
 * ai_usage logging (plan §13): per-call cost/usage log for the admin spend
 * dashboard + monthly circuit-breaker. Always written through the
 * service-role client -- the table has no user insert policy (see
 * migration 20260706153414_v2_additions.sql), only a "users can read their
 * own" select policy.
 */
import { billedUsageOf, type AnthropicUsage } from './anthropic.ts'
import { estimateCostUsd } from './pricing.ts'
import { serviceClient } from './supabaseClients.ts'

export interface LogUsageParams {
  userId: string | null
  tripId: string | null
  functionName: string
  model: string
  usage: AnthropicUsage
}

export async function logAiUsage(params: LogUsageParams): Promise<void> {
  const admin = serviceClient()
  const cost = estimateCostUsd(params.usage, params.model)
  const { error } = await admin.from('ai_usage').insert({
    user_id: params.userId,
    trip_id: params.tripId,
    function_name: params.functionName,
    model: params.model,
    input_tokens: params.usage.input_tokens ?? null,
    output_tokens: params.usage.output_tokens ?? null,
    cache_read_tokens: params.usage.cache_read_input_tokens ?? null,
    cache_write_tokens: params.usage.cache_creation_input_tokens ?? null,
    estimated_cost_usd: cost,
  })
  if (error) {
    // Never fail the user-facing request because usage logging failed --
    // log and move on.
    console.error('[logAiUsage] insert failed:', error)
  }
}

/**
 * Writes ai_usage for a call that failed AFTER the API charged for it
 * (max_tokens / refusal, a stream that died, an unparseable reply), so the
 * spend dashboard and the monthly circuit-breaker count it. No-op when the
 * error carries no known usage. Never throws and never logs content.
 */
export async function logBilledFailure(params: { userId: string | null; tripId: string | null; functionName: string; error: unknown }): Promise<void> {
  const billed = billedUsageOf(params.error)
  if (!billed) return
  try {
    await logAiUsage({ userId: params.userId, tripId: params.tripId, functionName: params.functionName, model: billed.model, usage: billed.usage })
  } catch {
    console.error('[logBilledFailure] could not record usage')
  }
}
