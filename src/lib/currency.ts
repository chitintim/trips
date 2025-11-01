/**
 * Currency conversion utilities using frankfurter.app API
 *
 * Features:
 * - Historical FX rates based on payment date
 * - Multi-level caching (in-memory + localStorage)
 * - Fallback handling for API failures
 * - Support for major currencies: GBP, EUR, USD, CHF, JPY, AUD, CAD
 */

export type Currency = 'GBP' | 'EUR' | 'USD' | 'CHF' | 'JPY' | 'AUD' | 'CAD'

export interface FXRate {
  rate: number
  date: string
  from: Currency
  to: Currency
  source: 'api' | 'cache' | 'manual'
}

interface FrankfurterResponse {
  amount: number
  base: string
  date: string
  rates: Record<string, number>
}

// In-memory cache for session
const rateCache = new Map<string, FXRate>()

// Cache TTL: 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Generate cache key for FX rate
 */
function getCacheKey(date: string, from: Currency, to: Currency): string {
  return `fx_rate_${date}_${from}_${to}`
}

/**
 * Get rate from localStorage cache
 */
function getCachedRate(date: string, from: Currency, to: Currency): FXRate | null {
  const key = getCacheKey(date, from, to)

  // Check in-memory cache first
  const memoryRate = rateCache.get(key)
  if (memoryRate) {
    return memoryRate
  }

  // Check localStorage cache
  try {
    const cached = localStorage.getItem(key)
    if (cached) {
      const parsed = JSON.parse(cached)
      const cachedAt = new Date(parsed.cachedAt).getTime()
      const now = Date.now()

      // Check if cache is still valid (within 24 hours)
      if (now - cachedAt < CACHE_TTL_MS) {
        const rate: FXRate = {
          rate: parsed.rate,
          date: parsed.date,
          from: parsed.from,
          to: parsed.to,
          source: 'cache'
        }

        // Store in memory cache for faster access
        rateCache.set(key, rate)

        return rate
      } else {
        // Expired - remove from localStorage
        localStorage.removeItem(key)
      }
    }
  } catch (error) {
    console.error('Error reading from localStorage cache:', error)
  }

  return null
}

/**
 * Store rate in cache (both memory and localStorage)
 */
function cacheRate(rate: FXRate): void {
  const key = getCacheKey(rate.date, rate.from, rate.to)

  // Store in memory
  rateCache.set(key, rate)

  // Store in localStorage
  try {
    localStorage.setItem(key, JSON.stringify({
      ...rate,
      cachedAt: new Date().toISOString()
    }))
  } catch (error) {
    console.error('Error writing to localStorage cache:', error)
  }
}

/**
 * Fetch FX rate from frankfurter.app API
 *
 * @param date - Date in YYYY-MM-DD format
 * @param from - Source currency
 * @param to - Target currency
 * @returns FX rate or null if failed
 */
async function fetchRateFromAPI(
  date: string,
  from: Currency,
  to: Currency
): Promise<FXRate | null> {
  try {
    // Check if date is in the future
    const requestDate = new Date(date)
    const today = new Date()
    today.setHours(0, 0, 0, 0) // Reset to start of day for comparison

    let effectiveDate = date

    if (requestDate > today) {
      // Future date - use today's rate instead
      effectiveDate = today.toISOString().split('T')[0]
      console.warn(`Cannot get FX rate for future date ${date}. Using today's rate (${effectiveDate}) instead.`)
    }

    const url = `https://api.frankfurter.app/${effectiveDate}?from=${from}&to=${to}`
    const response = await fetch(url)

    if (!response.ok) {
      console.error(`Frankfurter API error: ${response.status} ${response.statusText}`)
      return null
    }

    const data: FrankfurterResponse = await response.json()

    if (!data.rates || !data.rates[to]) {
      console.error('Frankfurter API returned no rate for', to)
      return null
    }

    const rate: FXRate = {
      rate: data.rates[to],
      date: data.date, // Use the actual date returned by API
      from,
      to,
      source: 'api'
    }

    // Cache the rate using the actual date returned by API
    cacheRate(rate)

    return rate
  } catch (error) {
    console.error('Error fetching FX rate from API:', error)
    return null
  }
}

/**
 * Get FX rate for a specific date
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
  // If converting to same currency, rate is 1
  if (from === to) {
    return {
      rate: 1,
      date,
      from,
      to,
      source: 'cache'
    }
  }

  // Check cache first
  const cached = getCachedRate(date, from, to)
  if (cached) {
    return cached
  }

  // Fetch from API
  const apiRate = await fetchRateFromAPI(date, from, to)

  return apiRate
}

/**
 * Convert amount from one currency to another
 *
 * @param amount - Amount to convert
 * @param from - Source currency
 * @param date - Date for FX rate (YYYY-MM-DD format)
 * @param to - Target currency (default: GBP)
 * @returns Converted amount and rate details, or null if conversion failed
 */
export async function convertCurrency(
  amount: number,
  from: Currency,
  date: string,
  to: Currency = 'GBP'
): Promise<{ convertedAmount: number; rate: FXRate } | null> {
  const rate = await getFXRate(date, from, to)

  if (!rate) {
    return null
  }

  return {
    convertedAmount: amount * rate.rate,
    rate
  }
}

/**
 * Format currency amount with symbol
 *
 * @param amount - Amount to format
 * @param currency - Currency code
 * @returns Formatted string (e.g., "£123.45", "€100.00")
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

  // JPY doesn't use decimal places
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
 * Clear all cached FX rates
 */
export function clearFXCache(): void {
  // Clear in-memory cache
  rateCache.clear()

  // Clear localStorage cache
  try {
    const keys = Object.keys(localStorage)
    keys.forEach(key => {
      if (key.startsWith('fx_rate_')) {
        localStorage.removeItem(key)
      }
    })
  } catch (error) {
    console.error('Error clearing localStorage cache:', error)
  }
}
