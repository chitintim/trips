/**
 * MANUAL MIRROR of src/lib/money/currencyExponent.ts.
 *
 * Deno edge functions can't import across the supabase/functions boundary
 * from src/, and Supabase's function bundler only reliably packages files
 * under supabase/functions/ -- so this is a small, dependency-free,
 * hand-synced copy. Keep in sync with the frontend module; WSH is adding an
 * automated drift-check (see _shared/contracts/index.ts for the same note).
 *
 * ISO 4217 currency minor-unit exponents. Defaults to 2 (the overwhelming
 * majority of currencies) when a code is not explicitly listed below.
 */

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

export function getCurrencyExponent(currencyCode: string): number {
  const code = currencyCode?.toUpperCase?.() ?? ''
  return EXPONENT_OVERRIDES[code] ?? 2
}

export function getMinorUnitScale(currencyCode: string): number {
  return 10 ** getCurrencyExponent(currencyCode)
}
