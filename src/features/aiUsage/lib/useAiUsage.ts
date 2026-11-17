import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { isUsageUnavailable, parseUsageSummary, type UsageSummary } from './usageSummary'

export type AiUsageResult = { status: 'ok'; summary: UsageSummary } | { status: 'unavailable' }

type RpcFn = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>

const defaultRpc: RpcFn = (name, args) => (supabase.rpc as unknown as RpcFn).call(supabase, name, args)

export async function fetchAiUsage(days = 30, rpc: RpcFn = defaultRpc): Promise<AiUsageResult> {
  const { data, error } = await rpc('admin_ai_usage_summary', { p_days: days })
  if (error) {
    if (isUsageUnavailable(error)) return { status: 'unavailable' }
    throw error
  }
  return { status: 'ok', summary: parseUsageSummary(data) }
}

/** `enabled` must be the site-admin check; non-admins never call the RPC. */
export function useAiUsage(enabled: boolean, days = 30) {
  return useQuery({
    queryKey: ['aiUsage', days] as const,
    queryFn: () => fetchAiUsage(days),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}
