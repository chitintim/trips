/**
 * Shared FX-field resolution for every client-side expense INSERT/UPDATE
 * path (wizard, quick capture, chat-proposal apply). Fixes the money-path
 * bug where the auto-fetched rate shown in the ReviewStep preview was never
 * persisted: `fx_rate` stayed null unless the user typed a manual override,
 * so computeBalances excluded every foreign-currency expense from the math.
 *
 * Rules:
 *   - Same currency as the trip base -> all-null fields (balances treats
 *     same-currency as rate 1 without needing a stored rate).
 *   - Manual override -> rate_source 'manual', base_currency_amount derived
 *     from it (fx_rate_date stays null: there's no market date for it).
 *   - Otherwise -> best-effort fetchRate(); on failure everything stays
 *     null (previous behavior: the expense saves, balances flag it as
 *     missing a rate, the UI keeps warning). NEVER throws.
 */
import { fetchRate } from './fetchRate'

export interface ExpenseFxFields {
  fx_rate: number | null
  fx_rate_date: string | null
  base_currency_amount: number | null
  rate_source: string | null
}

const NULL_FX: ExpenseFxFields = { fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null }

export async function resolveExpenseFxFields(params: {
  amountMajor: number
  currency: string
  baseCurrency: string
  /** YYYY-MM-DD */
  paymentDate: string
  /** Parsed manual override rate, if the user entered one. */
  manualRate?: number | null
  /** YYYY-MM-DD, injectable for tests; defaults to today. */
  today?: string
}): Promise<ExpenseFxFields> {
  const { amountMajor, currency, baseCurrency, paymentDate, manualRate } = params
  if (currency === baseCurrency) return { ...NULL_FX }

  if (manualRate != null && manualRate > 0) {
    return {
      fx_rate: manualRate,
      fx_rate_date: null,
      base_currency_amount: amountMajor * manualRate,
      rate_source: 'manual',
    }
  }

  try {
    const today = params.today ?? new Date().toISOString().slice(0, 10)
    const result = await fetchRate(paymentDate, currency, baseCurrency, today)
    if (!result) return { ...NULL_FX }
    return {
      fx_rate: result.rate,
      fx_rate_date: result.date,
      base_currency_amount: amountMajor * result.rate,
      rate_source: result.source,
    }
  } catch {
    // Best-effort only -- a rate-fetch hiccup must never block saving the
    // expense itself (the balances screen surfaces the missing rate).
    return { ...NULL_FX }
  }
}

/** Per-split base_currency_amount for a resolved rate (null when no rate). */
export function splitBaseCurrencyAmount(splitAmountMajor: number, fx: ExpenseFxFields): number | null {
  return fx.fx_rate != null ? splitAmountMajor * fx.fx_rate : null
}
