// Daily FX Rate Refresh Edge Function v2 (plan §11 -- simplified)
//
// The "provisional rates" complexity is gone: an expense entered today gets
// today's latest available rate immediately (client-side), and this nightly
// job ONLY touches expenses where fx_rate_date < payment_date -- i.e. the
// rate on record predates the payment date (the payment-date rate wasn't
// published yet when the expense was entered). It resolves the correct
// locked rate for each such expense's payment date and updates the expense
// + its splits. Rate lock convention (plan §11): expense (payment) date;
// weekends/holidays resolve to the most recent prior business day
// (frankfurter does this server-side by returning the nearest prior
// published date).
//
// Sources: frankfurter.app (ECB, keyless, historical to 1999) -> fallback
// open.er-api.com (for non-ECB currencies; latest-only). All fetched rates
// are cached in fx_rates so each pair/date hits the API once ever.
//
// Cron contract unchanged: same function name, same daily schedule
// (16:30 UTC, after ECB ~16:00 CET publish), service-role invocation.
//
// Service-role use is sanctioned here (plan §16): fx_rates is one of the
// three tables the service role may write (fx_rates, ai_usage, rate_limits);
// expense fx fields are system-maintained financial plumbing -- matches v1.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Currencies pre-cached daily even if no expense needs them (the frequent
// set; the per-expense refresh below fetches anything else on demand, so
// this list is a warm-cache optimization, not a support boundary --
// plan §11 opens the currency list to any ISO 4217).
const PRECACHE_CURRENCIES = ['EUR', 'USD', 'CHF', 'JPY', 'AUD', 'CAD', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'THB', 'NZD']
const FETCH_TIMEOUT_MS = 8000

interface RateResult {
  /** The date the rate was actually published for (may be earlier than requested on weekends/holidays). */
  date: string
  /** Rate FROM the foreign currency TO the base currency (multiply foreign amount by this). */
  rate: number
  source: 'frankfurter' | 'open_er_api'
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    return response.ok ? response : null
  } catch {
    return null
  }
}

/**
 * Fetch the rate from `fromCurrency` to `toCurrency` for `date` (YYYY-MM-DD).
 * frankfurter resolves weekends/holidays to the most recent prior business
 * day and reports the resolved date. Falls back to open.er-api.com (latest
 * rates only -- used when frankfurter doesn't carry the currency).
 */
async function fetchRate(date: string, fromCurrency: string, toCurrency: string): Promise<RateResult | null> {
  // Primary: frankfurter (historical, ECB).
  const frankfurterResponse = await fetchWithTimeout(
    `https://api.frankfurter.app/${date}?from=${fromCurrency}&to=${toCurrency}`
  )
  if (frankfurterResponse) {
    try {
      const data = await frankfurterResponse.json()
      const rate = data?.rates?.[toCurrency]
      if (typeof rate === 'number' && rate > 0) {
        return { date: data.date ?? date, rate, source: 'frankfurter' }
      }
    } catch { /* fall through */ }
  }

  // Fallback: open.er-api.com (latest only -- acceptable for currencies the
  // ECB doesn't publish; rate_source records the provenance).
  const erApiResponse = await fetchWithTimeout(`https://open.er-api.com/v6/latest/${fromCurrency}`)
  if (erApiResponse) {
    try {
      const data = await erApiResponse.json()
      const rate = data?.rates?.[toCurrency]
      if (typeof rate === 'number' && rate > 0) {
        const resolvedDate = typeof data.time_last_update_utc === 'string'
          ? new Date(data.time_last_update_utc).toISOString().split('T')[0]
          : date
        return { date: resolvedDate, rate, source: 'open_er_api' }
      }
    } catch { /* fall through */ }
  }

  return null
}

/** YYYY-MM-DD date arithmetic without Date-object timezone drift. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().split('T')[0]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Cron-only: require the service-role key as the bearer token, mirroring
    // auto-chase's gate. Without this, any caller holding a valid JWT (e.g.
    // any logged-in app user, since this function has no explicit
    // verify_jwt config block) could invoke a full cross-trip fx-recompute
    // job on demand. This is a service-role batch job with no end-user
    // caller, so no user JWT should ever be accepted here.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token || token !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      return new Response(
        JSON.stringify({ success: false, error: 'refresh-fx-rates is cron/service-role only' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]

    console.log(`[refresh-fx-rates] Running for date: ${todayStr}`)

    // ---- 1. Pre-cache today's rates for the common currency set (X -> GBP) ----
    // Kept from v1 so the client's 3-tier cache (memory -> fx_rates -> API)
    // finds today's entries in the DB.
    let ratesCached = 0
    {
      const targets = PRECACHE_CURRENCIES.join(',')
      const response = await fetchWithTimeout(`https://api.frankfurter.app/${todayStr}?from=GBP&to=${targets}`)
      if (response) {
        try {
          const data = await response.json()
          const actualDate = data.date ?? todayStr
          const upserts = Object.entries(data.rates ?? {}).map(([currency, gbpToX]) => ({
            rate_date: actualDate,
            from_currency: currency,
            to_currency: 'GBP',
            rate: 1 / (gbpToX as number), // API gives GBP->X; we store X->GBP
            source: 'frankfurter',
            fetched_at: new Date().toISOString(),
          }))
          if (upserts.length > 0) {
            const { error } = await supabaseAdmin
              .from('fx_rates')
              .upsert(upserts, { onConflict: 'rate_date,from_currency,to_currency' })
            if (error) console.error('[refresh-fx-rates] precache upsert error:', error)
            else ratesCached = upserts.length
          }
        } catch (e) {
          console.error('[refresh-fx-rates] precache parse error:', e)
        }
      }
    }

    // ---- 2. The one job that matters: fix expenses where fx_rate_date < payment_date ----
    // (The rate on record predates the payment date, meaning the correct
    // payment-date rate wasn't published yet when the expense was entered.)
    // PostgREST can't compare two columns server-side, so fetch candidates
    // with a rate + past-or-today payment_date and filter in code.
    const { data: withRates, error: fetchError } = await supabaseAdmin
      .from('expenses')
      .select('id, trip_id, amount, currency, payment_date, fx_rate_date, rate_source, trips!inner(base_currency)')
      .not('fx_rate', 'is', null)
      .not('fx_rate_date', 'is', null)
      .lte('payment_date', todayStr) // future-dated expenses wait until their date arrives
    if (fetchError) throw fetchError

    const candidates = (withRates ?? []).filter(
      (e) =>
        e.rate_source !== 'manual' && // never clobber a user-overridden rate (plan §11)
        e.fx_rate_date &&
        e.fx_rate_date < e.payment_date
    )

    console.log(`[refresh-fx-rates] ${candidates.length} expenses need a payment-date rate refresh`)

    let expensesUpdated = 0
    const rateCache = new Map<string, RateResult | null>() // key: `${from}:${to}:${date}`

    for (const exp of candidates) {
      // deno-lint-ignore no-explicit-any
      const baseCurrency = ((exp as any).trips?.base_currency as string | undefined) ?? 'GBP'
      if (exp.currency === baseCurrency) continue

      const cacheKey = `${exp.currency}:${baseCurrency}:${exp.payment_date}`
      let rateResult = rateCache.get(cacheKey)
      if (rateResult === undefined) {
        // Check the fx_rates DB cache first (each pair/date hits the API once ever).
        const { data: cached } = await supabaseAdmin
          .from('fx_rates')
          .select('rate, rate_date, source')
          .eq('from_currency', exp.currency)
          .eq('to_currency', baseCurrency)
          .lte('rate_date', exp.payment_date)
          .order('rate_date', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (cached && cached.rate_date >= addDays(exp.payment_date, -5)) {
          // A cached rate within 5 days before the payment date is the
          // resolved prior-business-day rate -- use it, no API call.
          rateResult = { date: cached.rate_date, rate: Number(cached.rate), source: (cached.source as RateResult['source']) ?? 'frankfurter' }
        } else {
          rateResult = await fetchRate(exp.payment_date, exp.currency, baseCurrency)
          if (rateResult) {
            // Cache it (keyed by the RESOLVED publish date).
            await supabaseAdmin.from('fx_rates').upsert(
              [{
                rate_date: rateResult.date,
                from_currency: exp.currency,
                to_currency: baseCurrency,
                rate: rateResult.rate,
                source: rateResult.source,
                fetched_at: new Date().toISOString(),
              }],
              { onConflict: 'rate_date,from_currency,to_currency' }
            )
          }
        }
        rateCache.set(cacheKey, rateResult ?? null)
      }

      if (!rateResult) {
        console.warn(`[refresh-fx-rates] No rate found for ${exp.currency}->${baseCurrency} @ ${exp.payment_date}`)
        continue
      }

      const baseCurrencyAmount = Number(exp.amount) * rateResult.rate

      const { error: updateError } = await supabaseAdmin
        .from('expenses')
        .update({
          fx_rate: rateResult.rate,
          fx_rate_date: rateResult.date,
          base_currency_amount: baseCurrencyAmount,
          rate_source: rateResult.source,
        })
        .eq('id', exp.id)
      if (updateError) {
        console.error(`[refresh-fx-rates] Failed to update expense ${exp.id}:`, updateError)
        continue
      }

      // Update this expense's splits to the new rate.
      const { data: splits } = await supabaseAdmin
        .from('expense_splits')
        .select('id, amount')
        .eq('expense_id', exp.id)
      for (const split of splits ?? []) {
        await supabaseAdmin
          .from('expense_splits')
          .update({ base_currency_amount: Number(split.amount) * rateResult.rate })
          .eq('id', split.id)
      }

      expensesUpdated++
    }

    const result = {
      success: true,
      date: todayStr,
      ratesCached,
      expensesUpdated,
      candidatesScanned: candidates.length,
    }

    console.log('[refresh-fx-rates] Done:', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[refresh-fx-rates] Error:', error)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
