/**
 * Exact-mode money formatter for the payment emails and the confirm page.
 *
 * A tiny mirror of `formatMoneyExact` in src/lib/money/format.ts (always the
 * currency's full minor units: "£105.11", "£50.00", "¥5,000", "CHF 120.00").
 * The full formatter is not mirrored into _shared/money (the drift check
 * mirrors only the exponent and minor-unit files), so this file keeps just the
 * exact path. Golden values in paymentMoney.test.ts are asserted against the
 * src formatter too (src/lib/money/paymentNoticeParity.test.ts), so the two
 * cannot drift silently.
 */
import { getCurrencyExponent } from './money/currencyExponent.ts'
import { fromMinorUnits, toMinorUnits } from './money/minorUnits.ts'

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  CHF: 'CHF ',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
  KRW: '₩',
  CNY: 'CN¥',
  HKD: 'HK$',
  SGD: 'S$',
  NZD: 'NZ$',
  INR: '₹',
  THB: '฿',
}

export function currencySymbol(currencyCode: string | null | undefined): string {
  const code = (currencyCode || '').toUpperCase()
  if (!code) return ''
  return CURRENCY_SYMBOLS[code] ?? `${code} `
}

/** "£1,989.60": the ledger's own rounding, full minor units, en-GB grouping. Non-finite prints as zero. */
export function formatMoneyExact(amount: number, currencyCode: string): string {
  const exponent = getCurrencyExponent(currencyCode)
  const safe = Number.isFinite(amount) ? amount : 0
  const abs = fromMinorUnits(toMinorUnits(Math.abs(safe), currencyCode), currencyCode)
  const body = abs.toLocaleString('en-GB', { minimumFractionDigits: exponent, maximumFractionDigits: exponent })
  const sign = safe < 0 && abs !== 0 ? '-' : ''
  return `${sign}${currencySymbol(currencyCode)}${body}`
}
