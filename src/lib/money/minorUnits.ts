/**
 * Integer minor-units arithmetic.
 *
 * All money math in the app should happen in integer minor units (e.g. pence,
 * cents, or whole yen) to avoid floating-point drift. These helpers convert
 * between the "major" decimal amount (as stored in `numeric` DB columns and
 * shown to users, e.g. 12.34 GBP) and an integer minor-unit amount (1234)
 * suitable for exact addition/subtraction/distribution.
 *
 * Never do float arithmetic on money elsewhere — convert to minor units,
 * compute, convert back once at the boundary.
 */

import { getCurrencyExponent } from './currencyExponent'

/**
 * Convert a decimal major-unit amount (e.g. 12.34) to an integer minor-unit
 * amount (e.g. 1234) for the given currency. Rounds to the nearest minor
 * unit using standard "round half away from zero" semantics to avoid
 * banker's rounding surprises on money.
 */
export function toMinorUnits(amount: number, currencyCode: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`toMinorUnits: amount must be finite, got ${amount}`)
  }
  const scale = 10 ** getCurrencyExponent(currencyCode)
  const scaled = amount * scale
  return roundHalfAwayFromZero(scaled)
}

/**
 * Convert an integer minor-unit amount (e.g. 1234) back to a decimal
 * major-unit amount (e.g. 12.34) for the given currency.
 */
export function fromMinorUnits(minorAmount: number, currencyCode: string): number {
  if (!Number.isInteger(minorAmount)) {
    throw new Error(`fromMinorUnits: minorAmount must be an integer, got ${minorAmount}`)
  }
  const scale = 10 ** getCurrencyExponent(currencyCode)
  return minorAmount / scale
}

/**
 * Round-half-away-from-zero: 0.5 -> 1, -0.5 -> -1, 2.5 -> 3.
 * Avoids the negative-number pitfall of Math.round (which rounds -0.5 to -0)
 * and avoids IEEE round-half-to-even surprises.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value)
}

/**
 * Sum an array of integer minor-unit amounts exactly (no float drift).
 */
export function sumMinorUnits(amounts: number[]): number {
  return amounts.reduce((total, amount) => {
    if (!Number.isInteger(amount)) {
      throw new Error(`sumMinorUnits: all amounts must be integers, got ${amount}`)
    }
    return total + amount
  }, 0)
}
