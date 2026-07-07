import { formatMoney } from '../lib/formatMoney'

export interface FxBadgeProps {
  currency: string
  baseCurrency: string
  amount: number
  baseCurrencyAmount: number | null
  fxRate: number | null
  rateSource?: string | null
  className?: string
}

/**
 * Small base-currency subline shown under an expense's amount when its
 * currency differs from the trip's base currency (plan point 1: "small
 * base-currency subline only when different" -- deliberately plain text,
 * not a badge/chip, to keep the row's right-aligned amount column light).
 * Still flags manual-rate overrides (rate_source='manual', plan §11) and
 * missing-rate expenses (v1 bug: silently contributed 0 to balances -- v2
 * surfaces it here instead, in the danger tint so it can't be missed).
 */
export function FxBadge({ currency, baseCurrency, amount, baseCurrencyAmount, fxRate, rateSource, className = '' }: FxBadgeProps) {
  if (currency === baseCurrency) return null

  if (fxRate == null || baseCurrencyAmount == null) {
    return <span className={`text-[11px] font-medium text-danger-600 ${className}`.trim()}>⚠️ missing FX rate</span>
  }

  return (
    <span className={`text-[11px] text-[var(--text-muted)] tabular-nums ${className}`.trim()} title={`${amount} ${currency} @ ${fxRate}`}>
      ≈ {formatMoney(baseCurrencyAmount, baseCurrency)}
      {rateSource === 'manual' ? ' · manual rate' : ''}
    </span>
  )
}
