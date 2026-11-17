/**
 * Pure helpers for the admin "AI usage" tab. Shape comes from the RPC
 * `admin_ai_usage_summary(p_days)` (site admins only; migration
 * 20261129110000_admin_ai_usage.sql).
 */

/**
 * USD per million tokens, for the fallback estimate only (the RPC normally
 * returns cost_usd). Source: Anthropic public pricing as mirrored in
 * supabase/functions/_shared/pricing.ts, checked 2026-11-17. Estimates, not a
 * billing source of truth.
 */
export const PRICE_TABLE: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

export interface UsageRow {
  day: string
  function_name: string
  model: string
  calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
}

export interface ActionRow {
  kind: string
  proposed: number
  started: number
  done: number
  failed: number
  dismissed: number
  expired: number
  edited: number
}

export interface UsageSummary {
  days: number
  usage: UsageRow[]
  actions: ActionRow[]
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

export function estimateRowCostUsd(
  r: Pick<UsageRow, 'model' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>,
): number {
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => r.model === k || r.model.startsWith(k + '-'))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) return 0
  const p = PRICE_TABLE[key]
  return (r.input_tokens * p.input + r.output_tokens * p.output + r.cache_read_tokens * p.cacheRead + r.cache_write_tokens * p.cacheWrite) / 1e6
}

/** Defensive parse: unknown shapes become an empty summary rather than a crash. */
export function parseUsageSummary(raw: unknown): UsageSummary {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const usage = (Array.isArray(o.usage) ? o.usage : []).map((u): UsageRow => {
    const r = (u ?? {}) as Record<string, unknown>
    const row = {
      day: s(r.day).slice(0, 10),
      function_name: s(r.function_name) || 'unknown',
      model: s(r.model) || 'unknown',
      calls: n(r.calls),
      input_tokens: n(r.input_tokens),
      output_tokens: n(r.output_tokens),
      cache_read_tokens: n(r.cache_read_tokens),
      cache_write_tokens: n(r.cache_write_tokens),
      cost_usd: 0,
    }
    row.cost_usd = r.cost_usd == null ? estimateRowCostUsd(row) : n(r.cost_usd)
    return row
  })
  const actions = (Array.isArray(o.actions) ? o.actions : []).map((a): ActionRow => {
    const r = (a ?? {}) as Record<string, unknown>
    return {
      kind: s(r.kind) || 'unknown',
      proposed: n(r.proposed),
      started: n(r.started),
      done: n(r.done),
      failed: n(r.failed),
      dismissed: n(r.dismissed),
      expired: n(r.expired),
      edited: n(r.edited),
    }
  })
  return { days: n(o.days) || 30, usage, actions }
}

export interface Totals {
  calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
}

const empty = (): Totals => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 })
const add = (t: Totals, r: UsageRow) => {
  t.calls += r.calls
  t.input_tokens += r.input_tokens
  t.output_tokens += r.output_tokens
  t.cache_read_tokens += r.cache_read_tokens
  t.cache_write_tokens += r.cache_write_tokens
  t.cost_usd += r.cost_usd
}

export function totalsOf(rows: UsageRow[]): Totals {
  const t = empty()
  rows.forEach((r) => add(t, r))
  return t
}

/** Per function + model, biggest spender first. */
export function groupByFunction(rows: UsageRow[]): Array<Totals & { function_name: string; model: string }> {
  const m = new Map<string, Totals & { function_name: string; model: string }>()
  for (const r of rows) {
    const k = `${r.function_name}\u0000${r.model}`
    let t = m.get(k)
    if (!t) m.set(k, (t = { ...empty(), function_name: r.function_name, model: r.model }))
    add(t, r)
  }
  return [...m.values()].sort((a, b) => b.cost_usd - a.cost_usd)
}

/** Per day, newest first. */
export function groupByDay(rows: UsageRow[]): Array<Totals & { day: string }> {
  const m = new Map<string, Totals & { day: string }>()
  for (const r of rows) {
    let t = m.get(r.day)
    if (!t) m.set(r.day, (t = { ...empty(), day: r.day }))
    add(t, r)
  }
  return [...m.values()].sort((a, b) => b.day.localeCompare(a.day))
}

/** Share of prompt tokens served from cache (0 when there are none). */
export function cacheShare(t: Pick<Totals, 'input_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): number {
  const d = t.input_tokens + t.cache_read_tokens + t.cache_write_tokens
  return d === 0 ? 0 : t.cache_read_tokens / d
}

export const formatUsd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`

/** PostgREST "function not found": the migration has not been applied yet. */
export function isUsageUnavailable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message ?? '')
}
