/**
 * Currency display formatting for the expenses feature. Kept local to this
 * feature (src/lib/money/ is the foundation-owned minor-units/distribution
 * module and intentionally has no display formatting) so this can evolve
 * with expense-specific display needs (FX badges, signed amounts for
 * refunds, etc.) without touching foundation code.
 */
import { getCurrencyExponent } from '../../../lib/money'

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  CHF: 'CHF ',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
  KRW: '₩',
  CNY: '¥',
  HKD: 'HK$',
  SGD: 'S$',
  NZD: 'NZ$',
  INR: '₹',
  THB: '฿',
}

/** Frequent/pinned currencies shown before the full searchable ISO 4217 list (plan §10 details step). */
export const FREQUENT_CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'] as const

export function currencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode?.toUpperCase?.()] ?? `${currencyCode} `
}

/**
 * Formats a major-unit decimal amount for display with the currency's
 * correct number of decimal places (e.g. JPY has none, BHD has three).
 * Negative amounts (refunds) render with a leading minus before the symbol.
 */
export function formatMoney(amount: number, currencyCode: string): string {
  const exponent = getCurrencyExponent(currencyCode)
  const symbol = currencySymbol(currencyCode)
  const abs = Math.abs(amount)
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })
  return amount < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`
}

/** Formats an integer minor-unit amount directly (avoids a redundant fromMinorUnits round-trip at call sites that already have minor units). */
export function formatMoneyMinor(amountMinor: number, currencyCode: string): string {
  const exponent = getCurrencyExponent(currencyCode)
  const scale = 10 ** exponent
  return formatMoney(amountMinor / scale, currencyCode)
}
