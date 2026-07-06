import { Badge } from '../../../components/ui'
import { formatMoney } from '../lib/formatMoney'

export interface FxBadgeProps {
  currency: string
  baseCurrency: string
  amount: number
  baseCurrencyAmount: number | null
  fxRate: number | null
  rateSource?: string | null
}

/**
 * Small badge shown on expense rows/cards when the expense currency differs
 * from the trip's base currency: shows the base-currency equivalent, and
 * flags manual-rate overrides ("rate_source='manual'", plan §11) plus
 * missing-rate expenses (v1 bug: silently contributed 0 to balances --
 * v2 surfaces it here instead).
 */
export function FxBadge({ currency, baseCurrency, amount, baseCurrencyAmount, fxRate, rateSource }: FxBadgeProps) {
  if (currency === baseCurrency) return null

  if (fxRate == null || baseCurrencyAmount == null) {
    return (
      <Badge variant="warning" size="sm">
        ⚠️ Missing FX rate
      </Badge>
    )
  }

  return (
    <Badge variant="neutral" size="sm" title={`${amount} ${currency} @ ${fxRate}`}>
      ≈ {formatMoney(baseCurrencyAmount, baseCurrency)}
      {rateSource === 'manual' ? ' · manual rate' : ''}
    </Badge>
  )
}
