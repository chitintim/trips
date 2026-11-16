import { assertEquals } from 'jsr:@std/assert@1'
import { formatMoneyExact } from './paymentMoney.ts'

// Keep in step with src/lib/money/paymentNoticeParity.test.ts (same list, asserted against the src formatter).
export const GOLDEN: Array<[number, string, string]> = [
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

Deno.test('formatMoneyExact: golden values', () => {
  for (const [amount, currency, expected] of GOLDEN) {
    assertEquals(formatMoneyExact(amount, currency), expected, `${amount} ${currency}`)
  }
})
