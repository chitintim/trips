/**
 * Tiny local money formatter for map money-markers. Deliberately not
 * importing src/features/expenses (a concurrent workstream owns that path)
 * — this only needs a quick, correct-enough display string for a marker
 * popup, not the full expenses formatting stack.
 */
import { getCurrencyExponent } from '../../../lib/money'

const SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  JPY: '¥',
  CHF: 'CHF ',
  AUD: 'A$',
  CAD: 'C$',
}

export function formatPlaceMoney(amount: number, currencyCode: string): string {
  const exponent = getCurrencyExponent(currencyCode)
  const symbol = SYMBOLS[currencyCode?.toUpperCase?.()] ?? `${currencyCode} `
  return `${symbol}${amount.toLocaleString(undefined, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })}`
}
