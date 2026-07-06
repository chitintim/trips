/**
 * ISO 4217 currency minor-unit exponents.
 *
 * The "exponent" is the number of decimal digits used for the currency's
 * minor unit (e.g. GBP has 2 = pence, JPY has 0 = no subdivision).
 * This module is the single source of truth for how many decimal places
 * a currency uses when converting between "major" (human-displayed) amounts
 * and "minor" (integer) amounts for exact arithmetic.
 *
 * Defaults to 2 (the overwhelming majority of currencies) when a code is
 * not explicitly listed below.
 */

// Currencies with a non-default number of minor-unit decimal digits.
// Source: ISO 4217 minor unit table.
const EXPONENT_OVERRIDES: Record<string, number> = {
  // Zero decimal places
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,

  // Three decimal places
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,

  // Four decimal places
  CLF: 4,
  UYW: 4,
}

/**
 * Returns the number of minor-unit decimal digits for a given ISO 4217
 * currency code. Unknown/unlisted codes default to 2 (the common case).
 */
export function getCurrencyExponent(currencyCode: string): number {
  const code = currencyCode?.toUpperCase?.() ?? ''
  return EXPONENT_OVERRIDES[code] ?? 2
}

/**
 * Returns 10^exponent, i.e. the number of minor units per major unit.
 * e.g. GBP -> 100, JPY -> 1, BHD -> 1000
 */
export function getMinorUnitScale(currencyCode: string): number {
  return 10 ** getCurrencyExponent(currencyCode)
}
