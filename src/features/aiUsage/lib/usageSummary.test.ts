import { describe, it, expect, vi } from 'vitest'
import { cacheShare, estimateRowCostUsd, groupByDay, groupByFunction, isUsageUnavailable, parseUsageSummary, totalsOf } from './usageSummary'
import { fetchAiUsage } from './useAiUsage'

vi.mock('@tanstack/react-query', () => ({ useQuery: (opts: unknown) => opts }))
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

const raw = {
  days: 30,
  usage: [
    { day: '2026-11-16', function_name: 'trip-chat', model: 'claude-sonnet-5-5', calls: 2, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 3000, cache_write_tokens: 1000, cost_usd: 0.5 },
    { day: '2026-11-15', function_name: 'trip-chat', model: 'claude-sonnet-5-5', calls: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.25 },
    { day: '2026-11-16', function_name: 'ingest', model: 'claude-haiku-5-5', calls: 4, input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
  ],
  actions: [{ kind: 'todo_add', proposed: 3, started: 2, done: 1, failed: 1, dismissed: 1, expired: 0, edited: 0 }],
}

describe('usage summary', () => {
  it('parses, totals and groups', () => {
    const s = parseUsageSummary(raw)
    expect(totalsOf(s.usage).calls).toBe(7)
    expect(groupByFunction(s.usage)[0].function_name).toBe('trip-chat')
    expect(groupByDay(s.usage).map((d) => d.day)).toEqual(['2026-11-16', '2026-11-15'])
    expect(s.actions[0].failed).toBe(1)
  })
  it('falls back to the price table when cost_usd is missing', () => {
    const s = parseUsageSummary(raw)
    expect(s.usage[2].cost_usd).toBeCloseTo((10 * 0.1 + 10 * 0.5) / 1e6)
    expect(estimateRowCostUsd({ model: 'mystery', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(0)
  })
  it('survives garbage', () => {
    expect(parseUsageSummary(null)).toEqual({ days: 30, usage: [], actions: [] })
  })
  it('cache share', () => {
    expect(cacheShare({ input_tokens: 1000, cache_read_tokens: 3000, cache_write_tokens: 1000 })).toBeCloseTo(0.6)
    expect(cacheShare({ input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(0)
  })
})

describe('fail-soft', () => {
  it('recognises a missing function', () => {
    expect(isUsageUnavailable({ code: 'PGRST202' })).toBe(true)
    expect(isUsageUnavailable({ message: 'Could not find the function public.admin_ai_usage_summary' })).toBe(true)
    expect(isUsageUnavailable({ code: '42501' })).toBe(false)
  })
  it('maps PGRST202 to unavailable and rethrows other errors', async () => {
    expect(await fetchAiUsage(30, async () => ({ data: null, error: { code: 'PGRST202' } }))).toEqual({ status: 'unavailable' })
    await expect(fetchAiUsage(30, async () => ({ data: null, error: { code: '42501' } }))).rejects.toBeTruthy()
    const ok = await fetchAiUsage(7, async (name, args) => {
      expect(name).toBe('admin_ai_usage_summary')
      expect(args).toEqual({ p_days: 7 })
      return { data: raw, error: null }
    })
    expect(ok.status).toBe('ok')
  })
})
