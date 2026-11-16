import { describe, expect, it } from 'vitest'
import { formatMoneyExact } from './format'

/**
 * The payment emails print amounts with a tiny mirror of the exact-mode formatter
 * (supabase/functions/_shared/paymentMoney.ts). Its Deno test asserts this same
 * golden list, so a change to either formatter that alters these figures fails one of the two suites.
 */
const GOLDEN: Array<[number, string, string]> = [
  [105.11, 'GBP', '£105.11'],
  [50, 'GBP', '£50.00'],
  [1989.6, 'GBP', '£1,989.60'],
  [5000, 'JPY', '¥5,000'],
  [120, 'CHF', 'CHF 120.00'],
  [12.5, 'AUD', 'A$12.50'],
  [9.995, 'EUR', '€9.99'],
  [1.005, 'GBP', '£1.00'],
  [-4, 'GBP', '-£4.00'],
  [Number.NaN, 'GBP', '£0.00'],
  [30, 'xyz', 'XYZ 30.00'],
]

describe('payment email money formatting parity', () => {
  it.each(GOLDEN)('%s %s -> %s', (amount, currency, expected) => {
    expect(formatMoneyExact(amount, currency)).toBe(expected)
  })
})
