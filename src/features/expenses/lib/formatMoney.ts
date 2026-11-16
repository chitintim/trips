/**
 * Compatibility shim. The one money formatter lives in `src/lib/money/format.ts`
 * (redesign proposal 4.1); this file keeps the old expenses import path alive.
 * Expense and payment amounts are ledger figures, so `formatMoney` here is
 * the 'exact' mode (full minor units, "£50.00"). New code should import from
 * `src/lib/money` directly and pick a mode.
 */
import { formatMoney as formatMoneyOne, formatMoneyMinor as formatMoneyMinorOne } from '../../../lib/money/format'

export { FREQUENT_CURRENCIES, currencySymbol } from '../../../lib/money/format'

/** Ledger format: always the currency's full minor units; negatives print "-£4.00". */
export function formatMoney(amount: number, currencyCode: string): string {
  return formatMoneyOne(amount, currencyCode, { mode: 'exact' })
}

/** Ledger format for an integer minor-unit amount. */
export function formatMoneyMinor(amountMinor: number, currencyCode: string): string {
  return formatMoneyMinorOne(amountMinor, currencyCode)
}
