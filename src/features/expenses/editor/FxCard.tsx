import { useEffect, useState } from 'react'
import { Card, Input, Badge, Skeleton } from '../../../components/ui'
import { fetchRate } from '../../../lib/fx'
import { todayLocal } from '../../../lib/localDate'
import { formatMoney } from '../lib/formatMoney'
import type { ExpenseWizardDraft } from './wizardState'

export interface FxCardProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  baseCurrency: string
}

/**
 * Inline FX estimate, shown only when the expense currency differs from the
 * trip's: rate at the payment date, plus an optional manual override that
 * writes rate_source='manual'. (Was the FX half of the old Review step.)
 */
export function FxCard({ draft, onChange, baseCurrency }: FxCardProps) {
  const amountMajor = parseFloat(draft.amount) || 0
  const sameCurrency = draft.currency === baseCurrency
  const [autoRate, setAutoRate] = useState<number | null>(sameCurrency ? 1 : null)
  const [loadingRate, setLoadingRate] = useState(!sameCurrency)

  useEffect(() => {
    if (sameCurrency) {
      setAutoRate(1)
      setLoadingRate(false)
      return
    }
    let cancelled = false
    setLoadingRate(true)
    const today = todayLocal()
    fetchRate(draft.paymentDate, draft.currency, baseCurrency, today)
      .then((result) => {
        if (!cancelled) {
          setAutoRate(result?.rate ?? null)
          setLoadingRate(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutoRate(null)
          setLoadingRate(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [draft.currency, draft.paymentDate, baseCurrency, sameCurrency])

  const effectiveRate = draft.fxRateOverride ? parseFloat(draft.fxRateOverride) || null : autoRate
  const baseCurrencyAmount = effectiveRate != null ? amountMajor * effectiveRate : null

  if (sameCurrency) return null

  return (
        <Card noPadding className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--text-primary)]">FX conversion</span>
            {draft.fxRateOverride ? <Badge variant="secondary" size="sm">Manual rate</Badge> : loadingRate ? null : <Badge variant="neutral" size="sm">Auto</Badge>}
          </div>

          {loadingRate ? (
            <Skeleton variant="text" lines={1} />
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">
              1 {draft.currency} ={' '}
              {effectiveRate != null ? effectiveRate.toFixed(4) : '?'} {baseCurrency}
              {baseCurrencyAmount != null && (
                <> — ≈ <span className="font-semibold text-[var(--text-primary)]">{formatMoney(baseCurrencyAmount, baseCurrency)}</span></>
              )}
            </p>
          )}

          {effectiveRate == null && !loadingRate && (
            <p className="text-sm text-danger-600" role="alert">
              Couldn't fetch an FX rate automatically. Enter one manually below (e.g. "my card charged X").
            </p>
          )}

          <Input
            label="Override rate (optional)"
            inputMode="decimal"
            placeholder={autoRate != null ? autoRate.toFixed(4) : 'e.g. 0.0053'}
            value={draft.fxRateOverride ?? ''}
            onChange={(e) => onChange({ fxRateOverride: e.target.value || null })}
            helperText="Use this if your card statement shows a different rate than we found."
          />
        </Card>
      )
}
