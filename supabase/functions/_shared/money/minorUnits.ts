/**
 * MANUAL MIRROR of src/lib/money/minorUnits.ts -- see currencyExponent.ts
 * header comment for why this is a copy rather than a cross-boundary import.
 *
 * Integer minor-units arithmetic. All money math in edge functions should
 * happen in integer minor units (pence, cents, whole yen) to avoid
 * floating-point drift.
 */
import { getCurrencyExponent } from './currencyExponent.ts'

export function toMinorUnits(amount: number, currencyCode: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`toMinorUnits: amount must be finite, got ${amount}`)
  }
  const scale = 10 ** getCurrencyExponent(currencyCode)
  const scaled = amount * scale
  return roundHalfAwayFromZero(scaled)
}

export function fromMinorUnits(minorAmount: number, currencyCode: string): number {
  if (!Number.isInteger(minorAmount)) {
    throw new Error(`fromMinorUnits: minorAmount must be an integer, got ${minorAmount}`)
  }
  const scale = 10 ** getCurrencyExponent(currencyCode)
  return minorAmount / scale
}

export function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value)
}

export function sumMinorUnits(amounts: number[]): number {
  return amounts.reduce((total, amount) => {
    if (!Number.isInteger(amount)) {
      throw new Error(`sumMinorUnits: all amounts must be integers, got ${amount}`)
    }
    return total + amount
  }, 0)
}
