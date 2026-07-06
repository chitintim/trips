/**
 * FX rate fetch-order helper (plan §11): memory -> fx_rates table ->
 * frankfurter (ECB) -> open.er-api.com fallback.
 *
 * This is a v2 refactor of the fetch-order logic in src/lib/currency.ts
 * (left untouched -- this module is additive, existing callers of
 * currency.ts are unaffected). Differences from the old module:
 *   - Uses resolveRateDate() (see resolveRateDate.ts) for the
 *     future/weekend adjustment instead of a CET-cutover heuristic.
 *   - Fallback is open.er-api.com (per plan §11) instead of the old
 *     fawazahmed0 CDN fallback.
 *   - Accepts an injected SupabaseClient-like db accessor so this module
 *     has no hard dependency on the app's singleton client, which keeps
 *     it usable from edge functions too.
 */
import { resolveRateDate } from './resolveRateDate'

export interface FxRate {
  rate: number
  date: string
  from: string
  to: string
  source: 'cache' | 'db' | 'frankfurter' | 'open_er_api' | 'manual'
}

/** Minimal shape of what we need from a Supabase client for DB-tier caching. */
export interface FxRateDb {
  getStoredRate(params: { from: string; to: string; onOrBeforeDate: string }): Promise<
    { rate: number; rate_date: string } | null
  >
  storeRate(params: { from: string; to: string; date: string; rate: number; source: string }): Promise<void>
}

const memoryCache = new Map<string, FxRate>()

function cacheKey(date: string, from: string, to: string): string {
  return `${date}_${from}_${to}`
}

export function clearFxMemoryCache(): void {
  memoryCache.clear()
}

async function fetchFromFrankfurter(date: string, from: string, to: string): Promise<FxRate | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`https://api.frankfurter.app/${date}?from=${from}&to=${to}`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = (await res.json()) as { date: string; rates: Record<string, number> }
    if (!data.rates?.[to]) return null
    return { rate: data.rates[to], date: data.date, from, to, source: 'frankfurter' }
  } catch {
    return null
  }
}

async function fetchFromOpenErApi(date: string, from: string, to: string): Promise<FxRate | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    // open.er-api.com only serves latest rates (no historical endpoint on
    // the free tier); used purely as a same-day fallback for currency pairs
    // frankfurter doesn't cover.
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = (await res.json()) as { result: string; rates?: Record<string, number> }
    if (data.result !== 'success' || !data.rates?.[to]) return null
    return { rate: data.rates[to], date, from, to, source: 'open_er_api' }
  } catch {
    return null
  }
}

/**
 * Get an FX rate for `from` -> `to` on `paymentDate`, given `today` (both
 * YYYY-MM-DD). Applies resolveRateDate() first, then tries memory -> db ->
 * frankfurter -> open.er-api, in that order, caching successful lookups
 * back into memory and (if a db accessor is supplied) the fx_rates table.
 */
export async function fetchRate(
  paymentDate: string,
  from: string,
  to: string,
  today: string,
  db?: FxRateDb
): Promise<FxRate | null> {
  if (from === to) {
    return { rate: 1, date: paymentDate, from, to, source: 'cache' }
  }

  const { resolvedDate } = resolveRateDate(paymentDate, today)

  const memHit = memoryCache.get(cacheKey(resolvedDate, from, to))
  if (memHit) return memHit

  if (db) {
    const dbHit = await db.getStoredRate({ from, to, onOrBeforeDate: resolvedDate })
    if (dbHit) {
      const rate: FxRate = { rate: dbHit.rate, date: dbHit.rate_date, from, to, source: 'db' }
      memoryCache.set(cacheKey(resolvedDate, from, to), rate)
      return rate
    }
  }

  const fetched = (await fetchFromFrankfurter(resolvedDate, from, to)) ?? (await fetchFromOpenErApi(resolvedDate, from, to))
  if (!fetched) return null

  memoryCache.set(cacheKey(fetched.date, from, to), fetched)
  if (fetched.date !== resolvedDate) {
    memoryCache.set(cacheKey(resolvedDate, from, to), fetched)
  }

  if (db) {
    await db.storeRate({ from, to, date: fetched.date, rate: fetched.rate, source: fetched.source })
  }

  return fetched
}
