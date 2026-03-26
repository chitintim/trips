/**
 * Currency conversion utilities using frankfurter.app API
 *
 * Features:
 * - Historical FX rates based on payment date
 * - 3-tier caching: in-memory → Supabase fx_rates table → frankfurter.app API
 * - Close-of-market logic: uses previous day's rate before ECB publishes (~16:00 CET)
 * - Support for major currencies: GBP, EUR, USD, CHF, JPY, AUD, CAD
 */

import { supabase } from './supabase'

export type Currency = 'GBP' | 'EUR' | 'USD' | 'CHF' | 'JPY' | 'AUD' | 'CAD'

export interface FXRate {
  rate: number
  date: string
  from: Currency
  to: Currency
  source: 'api' | 'db' | 'cache' | 'manual'
}

interface FrankfurterResponse {
  amount: number
  base: string
  date: string
  rates: Record<string, number>
}

// Tier 1: In-memory cache (session lifetime)
const rateCache = new Map<string, FXRate>()

/**
 * Generate cache key for FX rate
 */
function getCacheKey(date: string, from: Currency, to: Currency): string {
  return `fx_${date}_${from}_${to}`
}

/**
 * Tier 2: Look up rate in Supabase fx_rates table
 * Uses "on or before" logic to handle weekends/holidays (ECB doesn't publish on non-business days)
 */
async function getDbRate(date: string, from: Currency, to: Currency): Promise<FXRate | null> {
  try {
    const { data, error } = await supabase
      .from('fx_rates')
      .select('rate, rate_date, from_currency, to_currency')
      .eq('from_currency', from)
      .eq('to_currency', to)
      .lte('rate_date', date)
      .order('rate_date', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) return null

    const rate: FXRate = {
      rate: Number(data.rate),
      date: data.rate_date,
      from: data.from_currency as Currency,
      to: data.to_currency as Currency,
      source: 'db'
    }

    // Promote to memory cache (keyed by the actual rate date AND the requested date)
    rateCache.set(getCacheKey(data.rate_date, from, to), rate)
    if (data.rate_date !== date) {
      rateCache.set(getCacheKey(date, from, to), rate)
    }

    return rate
  } catch {
    return null
  }
}

/**
 * Store rate in Supabase fx_rates table (fire-and-forget)
 */
function storeDbRate(rate: FXRate): void {
  supabase
    .from('fx_rates')
    .upsert({
      rate_date: rate.date,
      from_currency: rate.from,
      to_currency: rate.to,
      rate: rate.rate,
      source: rate.source === 'api' ? 'frankfurter' : (rate.source || 'unknown'),
      fetched_at: new Date().toISOString()
    }, {
      onConflict: 'rate_date,from_currency,to_currency'
    })
    .then(({ error }) => {
      if (error) console.error('Failed to store FX rate in DB:', error)
    })
}

/**
 * Determine the effective date for FX rate lookup.
 * - Future dates → use today
 * - Today before 16:00 CET → use yesterday (ECB hasn't published yet)
 */
function getEffectiveDate(date: string): { effectiveDate: string; isProvisional: boolean } {
  const now = new Date()
  const requestDate = new Date(date + 'T00:00:00')
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayStr = now.toISOString().split('T')[0]

  let effectiveDate = date
  let isProvisional = false

  // Future date → use today
  if (requestDate > today) {
    effectiveDate = todayStr
    isProvisional = true
  }

  // Today before ECB publish time (~16:00 CET) → use yesterday's confirmed rate
  if (effectiveDate === todayStr) {
    const cetTimeStr = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false })
    const cetHour = parseInt(cetTimeStr, 10)
    if (cetHour < 16) {
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      effectiveDate = yesterday.toISOString().split('T')[0]
      isProvisional = true
    }
  }

  return { effectiveDate, isProvisional }
}

/**
 * Tier 3: Fetch FX rate from external APIs
 * Primary: frankfurter.app (ECB data)
 * Fallback: fawazahmed0/currency-api (CDN-hosted, very reliable)
 */
async function fetchRateFromAPI(
  date: string,
  from: Currency,
  to: Currency
): Promise<FXRate | null> {
  const { effectiveDate } = getEffectiveDate(date)

  // Try primary API first, then fallback
  const rate = await fetchFromFrankfurter(effectiveDate, from, to)
    ?? await fetchFromCurrencyApi(effectiveDate, from, to)

  if (!rate) return null

  // Cache in memory (both actual date and requested date)
  rateCache.set(getCacheKey(rate.date, from, to), rate)
  if (rate.date !== date) {
    rateCache.set(getCacheKey(date, from, to), rate)
  }

  // Store in Supabase (fire-and-forget)
  storeDbRate(rate)

  return rate
}

/**
 * Primary API: frankfurter.app (ECB rates)
 */
async function fetchFromFrankfurter(
  date: string,
  from: Currency,
  to: Currency
): Promise<FXRate | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const url = `https://api.frankfurter.app/${date}?from=${from}&to=${to}`
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      console.warn(`Frankfurter API error: ${response.status} — trying fallback`)
      return null
    }

    const data: FrankfurterResponse = await response.json()

    if (!data.rates || !data.rates[to]) {
      console.warn('Frankfurter returned no rate for', to)
      return null
    }

    return {
      rate: data.rates[to],
      date: data.date,
      from,
      to,
      source: 'api'
    }
  } catch (error) {
    console.warn('Frankfurter API failed:', (error as Error).message, '— trying fallback')
    return null
  }
}

/**
 * Fallback API: fawazahmed0/currency-api (CDN-hosted, high availability)
 * https://github.com/fawazahmed0/exchange-api
 */
async function fetchFromCurrencyApi(
  date: string,
  from: Currency,
  to: Currency
): Promise<FXRate | null> {
  const fromLower = from.toLowerCase()
  const toLower = to.toLowerCase()

  // Try primary CDN, then fallback CDN
  const urls = [
    `https://${date}.currency-api.pages.dev/v1/currencies/${fromLower}.json`,
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${fromLower}.json`,
  ]

  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!response.ok) continue

      const data = await response.json()
      const rates = data[fromLower]

      if (!rates || !rates[toLower]) continue

      console.log(`Fallback API (currency-api) returned rate for ${from}→${to}: ${rates[toLower]}`)

      return {
        rate: rates[toLower],
        date: data.date || date,
        from,
        to,
        source: 'api'
      }
    } catch {
      continue
    }
  }

  console.error(`All FX APIs failed for ${from}→${to} on ${date}`)
  return null
}

/**
 * Get FX rate for a specific date
 *
 * 3-tier lookup: memory → Supabase fx_rates → frankfurter.app API
 *
 * @param date - Date in YYYY-MM-DD format
 * @param from - Source currency
 * @param to - Target currency (default: GBP)
 * @returns FX rate or null if failed
 */
export async function getFXRate(
  date: string,
  from: Currency,
  to: Currency = 'GBP'
): Promise<FXRate | null> {
  // Same currency = rate 1
  if (from === to) {
    return { rate: 1, date, from, to, source: 'cache' }
  }

  // Tier 1: In-memory cache
  const key = getCacheKey(date, from, to)
  const memoryRate = rateCache.get(key)
  if (memoryRate) return memoryRate

  // Tier 2: Supabase fx_rates table (uses "on or before" for weekends/holidays)
  const dbRate = await getDbRate(date, from, to)
  if (dbRate) return dbRate

  // Tier 3: frankfurter.app API (also stores result in DB)
  return await fetchRateFromAPI(date, from, to)
}

/**
 * Convert amount from one currency to another
 */
export async function convertCurrency(
  amount: number,
  from: Currency,
  date: string,
  to: Currency = 'GBP'
): Promise<{ convertedAmount: number; rate: FXRate } | null> {
  const rate = await getFXRate(date, from, to)
  if (!rate) return null

  return {
    convertedAmount: amount * rate.rate,
    rate
  }
}

/**
 * Check if an expense has a provisional rate (rate date doesn't match payment date)
 */
export function isProvisionalRate(paymentDate: string, fxRateDate: string | null): boolean {
  if (!fxRateDate || !paymentDate) return false
  return fxRateDate < paymentDate
}

/**
 * Check if the confirmed rate for a given date should now be available
 * (i.e., it's past 16:00 CET on that date)
 */
export function isConfirmedRateAvailable(date: string): boolean {
  const { effectiveDate } = getEffectiveDate(date)
  // If the effective date matches the requested date, the confirmed rate is available
  return effectiveDate === date
}

/**
 * Format currency amount with symbol
 */
export function formatCurrency(amount: number, currency: Currency): string {
  const symbols: Record<Currency, string> = {
    GBP: '£',
    EUR: '€',
    USD: '$',
    CHF: 'CHF ',
    JPY: '¥',
    AUD: 'A$',
    CAD: 'C$'
  }

  const symbol = symbols[currency] || currency

  if (currency === 'JPY') {
    return `${symbol}${Math.round(amount).toLocaleString()}`
  }

  return `${symbol}${amount.toFixed(2)}`
}

/**
 * Get all supported currencies
 */
export function getSupportedCurrencies(): Currency[] {
  return ['GBP', 'EUR', 'USD', 'CHF', 'JPY', 'AUD', 'CAD']
}

/**
 * Get currency display name
 */
export function getCurrencyName(currency: Currency): string {
  const names: Record<Currency, string> = {
    GBP: 'British Pound',
    EUR: 'Euro',
    USD: 'US Dollar',
    CHF: 'Swiss Franc',
    JPY: 'Japanese Yen',
    AUD: 'Australian Dollar',
    CAD: 'Canadian Dollar'
  }

  return names[currency] || currency
}

/**
 * Clear in-memory FX rate cache
 */
export function clearFXCache(): void {
  rateCache.clear()
}
