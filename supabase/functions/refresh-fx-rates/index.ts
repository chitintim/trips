// Daily FX Rate Refresh Edge Function
// Fetches ECB closing rates from frankfurter.app, caches in fx_rates table,
// and updates expenses that were using provisional (previous-day) rates.
//
// Schedule: Daily at 16:30 UTC (after ECB ~16:00 CET publish)

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CURRENCIES = ['EUR', 'USD', 'CHF', 'JPY', 'AUD', 'CAD']
const BASE = 'GBP'

/**
 * Fetch rates from frankfurter.app (primary API)
 * Returns { date, rates: { EUR: 1.17, USD: 1.26, ... } } where rates are GBP→X
 */
async function fetchFromFrankfurter(date: string, currencies: string[]): Promise<{ date: string; rates: Record<string, number> } | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const targets = currencies.join(',')
    const url = `https://api.frankfurter.app/${date}?from=${BASE}&to=${targets}`
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      console.warn(`[refresh-fx-rates] Frankfurter API error: ${response.status} — trying fallback`)
      return null
    }

    const data = await response.json()
    return { date: data.date, rates: data.rates }
  } catch (error) {
    console.warn(`[refresh-fx-rates] Frankfurter API failed: ${(error as Error).message} — trying fallback`)
    return null
  }
}

/**
 * Fetch rates from fawazahmed0/currency-api (fallback API)
 * This API returns rates per base currency, so we fetch GBP rates and extract targets
 */
async function fetchFromCurrencyApi(date: string, currencies: string[]): Promise<{ date: string; rates: Record<string, number> } | null> {
  const urls = [
    `https://${date}.currency-api.pages.dev/v1/currencies/gbp.json`,
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/gbp.json`,
  ]

  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)

      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!response.ok) continue

      const data = await response.json()
      const gbpRates = data.gbp
      if (!gbpRates) continue

      // Extract only the currencies we need
      const rates: Record<string, number> = {}
      for (const cur of currencies) {
        const rate = gbpRates[cur.toLowerCase()]
        if (rate) rates[cur] = rate
      }

      if (Object.keys(rates).length === 0) continue

      console.log(`[refresh-fx-rates] Fallback API (currency-api) returned ${Object.keys(rates).length} rates`)
      return { date: data.date || date, rates }
    } catch {
      continue
    }
  }

  console.error(`[refresh-fx-rates] All fallback CDNs failed`)
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]

    console.log(`[refresh-fx-rates] Running for date: ${todayStr}`)

    // Fetch rates: try frankfurter first, fall back to currency-api
    const apiResult = await fetchFromFrankfurter(todayStr, CURRENCIES)
      ?? await fetchFromCurrencyApi(todayStr, CURRENCIES)

    if (!apiResult) {
      throw new Error('All FX rate APIs failed (frankfurter + currency-api fallback)')
    }

    const actualDate = apiResult.date // May differ from todayStr on weekends/holidays

    console.log(`[refresh-fx-rates] API returned rates for: ${actualDate}`)

    // Build upsert rows: store X→GBP rates (what we use for expense conversion)
    const upserts = Object.entries(apiResult.rates).map(([currency, gbpRate]) => ({
      rate_date: actualDate,
      from_currency: currency,
      to_currency: BASE,
      rate: 1 / (gbpRate as number), // API gives GBP→X, we need X→GBP
      source: 'frankfurter',
      fetched_at: new Date().toISOString()
    }))

    const { error: upsertError } = await supabaseAdmin
      .from('fx_rates')
      .upsert(upserts, { onConflict: 'rate_date,from_currency,to_currency' })

    if (upsertError) {
      console.error('[refresh-fx-rates] Upsert error:', upsertError)
      throw upsertError
    }

    console.log(`[refresh-fx-rates] Cached ${upserts.length} rates for ${actualDate}`)

    // Find expenses with provisional rates for this date
    // (payment_date = actualDate but fx_rate_date < actualDate)
    const { data: provisionalExpenses, error: fetchError } = await supabaseAdmin
      .from('expenses')
      .select('id, amount, currency, payment_date')
      .neq('currency', BASE)
      .not('fx_rate', 'is', null)
      .eq('payment_date', actualDate)
      .lt('fx_rate_date', actualDate)

    if (fetchError) {
      console.error('[refresh-fx-rates] Error fetching provisional expenses:', fetchError)
    }

    let expensesUpdated = 0

    if (provisionalExpenses && provisionalExpenses.length > 0) {
      console.log(`[refresh-fx-rates] Found ${provisionalExpenses.length} expenses with provisional rates`)

      for (const exp of provisionalExpenses) {
        const rateRow = upserts.find(u => u.from_currency === exp.currency)
        if (!rateRow) continue

        const baseCurrencyAmount = exp.amount * rateRow.rate

        // Update expense
        const { error: updateError } = await supabaseAdmin
          .from('expenses')
          .update({
            fx_rate: rateRow.rate,
            fx_rate_date: actualDate,
            base_currency_amount: baseCurrencyAmount
          })
          .eq('id', exp.id)

        if (updateError) {
          console.error(`[refresh-fx-rates] Failed to update expense ${exp.id}:`, updateError)
          continue
        }

        // Update splits for this expense
        const { data: splits } = await supabaseAdmin
          .from('expense_splits')
          .select('id, amount')
          .eq('expense_id', exp.id)

        if (splits) {
          for (const split of splits) {
            await supabaseAdmin
              .from('expense_splits')
              .update({ base_currency_amount: split.amount * rateRow.rate })
              .eq('id', split.id)
          }
        }

        expensesUpdated++
      }
    }

    const result = {
      success: true,
      date: actualDate,
      ratesCached: upserts.length,
      expensesUpdated,
    }

    console.log('[refresh-fx-rates] Done:', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('[refresh-fx-rates] Error:', error)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
