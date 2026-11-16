/**
 * THE one money formatter (redesign proposal 4.1). Every amount the app
 * prints goes through `formatMoney`; the older helpers (decisions/costImpact,
 * expenses/formatMoney, lib/currency) are thin re-export shims over this
 * file (places/formatPlaceMoney was deleted; its callers import this).
 *
 * Rounding matches the ledger: the digits printed are exactly what
 * `toMinorUnits` would store (so 1.005 prints "£1.00" and 9.995 prints
 * "£9.99", never a different figure from the one in the database).
 *
 * Pure display: it never changes an amount, only how it is printed. Locale is
 * fixed to en-GB so output is identical on every device (grouping commas,
 * "." decimal point).
 *
 * Modes (explicit, pick one):
 *   - 'headline' (default): figures people read at a glance. Whole amounts
 *     drop the decimals ("£50", "¥5,000"); fractional ones keep full minor
 *     units ("£54.50"). Never rounds the value.
 *   - 'exact': ledgers, expenses, payments. Always the currency's full minor
 *     units ("£50.00", "£1,989.60", "¥5,000").
 *   - 'estimate' (or `{ estimate: true }`): an approximate figure. Rounds to
 *     whole units once the amount is >= 10 ("≈£222"), keeps minor units below
 *     that ("≈£7.50"), and prefixes "≈".
 *
 * "≈" is added when `estimate` is set or `converted` is set (the amount was
 * converted from another currency at a rate). `converted` alone does not
 * round: it only prefixes "≈".
 *
 * Symbols: "£50", "€30", "¥5,000", "$12", and a spaced code for currencies
 * without a short symbol ("CHF 120", "A$12" for AUD).
 */
import { getCurrencyExponent } from './currencyExponent'
import { fromMinorUnits, toMinorUnits } from './minorUnits'

export type MoneyMode = 'headline' | 'exact' | 'estimate'

export interface FormatMoneyOptions {
  /** Default 'headline'. */
  mode?: MoneyMode
  /** Shorthand for mode 'estimate': rounds to whole units (>= 10) and prefixes "≈". */
  estimate?: boolean
  /** The amount was converted from another currency: prefix "≈" (does not change rounding). */
  converted?: boolean
  /** Compact notation: "£1.2k", "£3.4m". Whole numbers stay whole ("£1k"). Under 1,000 it behaves like the chosen mode. */
  compact?: boolean
  /** Print an explicit "+" for positive amounts ("+£54"). Zero never gets a sign. */
  signed?: boolean
  /** Omit the currency symbol and print only the number ("1,989.60"). */
  hideSymbol?: boolean
}

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

/** Frequent/pinned currencies shown before the full searchable ISO 4217 list. */
export const FREQUENT_CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'] as const

/** The prefix printed before the number: "£", "CHF " (with its space), or "XYZ " for unknown codes. */
export function currencySymbol(currencyCode: string | null | undefined): string {
  const code = (currencyCode || '').toUpperCase()
  if (!code) return ''
  return CURRENCY_SYMBOLS[code] ?? `${code} `
}

const GROUPING = new Intl.NumberFormat('en-GB', { useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 0 })

function groupedNumber(value: number, decimals: number): string {
  if (decimals === 0) return GROUPING.format(value)
  return value.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Round to the currency's minor unit with the ledger's own rule, so the digits printed are what is stored. */
function roundToMinor(abs: number, currencyCode: string): number {
  return fromMinorUnits(toMinorUnits(abs, currencyCode), currencyCode)
}

/** "1k", "1.2k", "1.2m". The suffix is chosen AFTER rounding to one decimal, so 999,950 is "1m", never "1000k". */
function compactBody(abs: number): string | null {
  if (abs < 1_000) return null
  const fmt = (v: number): string => {
    const r = Math.round(v * 10) / 10
    return r === Math.round(r) ? String(Math.round(r)) : r.toFixed(1)
  }
  if (abs >= 1_000_000) return `${fmt(abs / 1_000_000)}m`
  const thousands = Math.round((abs / 1_000) * 10) / 10
  if (thousands >= 1_000) return `${fmt(abs / 1_000_000)}m`
  return `${fmt(abs / 1_000)}k`
}

/**
 * Formats a major-unit amount. Negative amounts print "-£4.00" (leading
 * ASCII minus before the symbol, as the ledger always has). Non-finite input
 * prints as zero rather than "NaN".
 */
export function formatMoney(amount: number, currencyCode: string, options: FormatMoneyOptions = {}): string {
  const mode: MoneyMode = options.estimate ? 'estimate' : options.mode ?? 'headline'
  const approx = mode === 'estimate' || !!options.converted
  const exponent = getCurrencyExponent(currencyCode)
  const symbol = options.hideSymbol ? '' : currencySymbol(currencyCode)

  const safe = Number.isFinite(amount) ? amount : 0
  let abs = roundToMinor(Math.abs(safe), currencyCode)

  if (mode === 'estimate' && abs >= 10) abs = Math.round(abs)

  const isWhole = abs === Math.round(abs)
  let decimals = exponent
  if (mode !== 'exact' && isWhole) decimals = 0

  const compact = options.compact ? compactBody(abs) : null
  // One decimal of precision at most; a whole thousand prints "£2k", 2,400 prints "£2.4k".
  const body = compact ?? groupedNumber(abs, decimals)

  const negative = safe < 0 && abs !== 0
  const sign = negative ? '-' : options.signed && abs !== 0 ? '+' : ''
  return `${approx ? '≈' : ''}${sign}${symbol}${body}`
}

/** Formats an integer minor-unit amount (avoids a redundant fromMinorUnits round-trip). Same options as `formatMoney`; default mode is 'exact' because minor units imply a ledger. */
export function formatMoneyMinor(amountMinor: number, currencyCode: string, options: FormatMoneyOptions = {}): string {
  const scale = 10 ** getCurrencyExponent(currencyCode)
  return formatMoney(amountMinor / scale, currencyCode, { mode: 'exact', ...options })
}

/** Ledger convenience: always full minor units. */
export function formatMoneyExact(amount: number, currencyCode: string, options: Omit<FormatMoneyOptions, 'mode' | 'estimate'> = {}): string {
  return formatMoney(amount, currencyCode, { ...options, mode: 'exact' })
}

/** Approximate-figure convenience: "≈£222". */
export function formatMoneyEstimate(amount: number, currencyCode: string, options: Omit<FormatMoneyOptions, 'mode' | 'estimate'> = {}): string {
  return formatMoney(amount, currencyCode, { ...options, mode: 'estimate' })
}

/**
 * A range: "£60 – £140", "≈£1,150 – £1,310" (the "≈" leads the whole range
 * once). Collapses to a single figure when both ends print the same.
 */
export function formatMoneyRange(low: number, high: number, currencyCode: string, options: FormatMoneyOptions = {}): string {
  const first = formatMoney(low, currencyCode, options)
  const second = formatMoney(high, currencyCode, options).replace('≈', '')
  if (first.replace('≈', '') === second) return first
  return `${first} – ${second}`
}
