import { useEffect, useState } from 'react'
import { Card, Input, Badge, Skeleton } from '../../../components/ui'
import { fetchRate } from '../../../lib/fx'
import { formatMoney } from '../lib/formatMoney'
import { computeSplits } from './computeSplits'
import type { ExpenseWizardDraft } from './wizardState'

export interface ReviewStepProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  baseCurrency: string
  participantNames: Record<string, string>
}

/**
 * Review step (plan §10 #2): FX preview (rate at payment_date via
 * src/lib/fx), rate override input writing rate_source='manual'.
 */
export function ReviewStep({ draft, onChange, baseCurrency, participantNames }: ReviewStepProps) {
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
    const today = new Date().toISOString().slice(0, 10)
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

  const splits =
    draft.splitMode !== 'itemized'
      ? computeSplits({
          mode: draft.splitMode,
          amountMajor,
          currency: draft.currency,
          participantIds: draft.participantIds,
          entries: draft.splitEntries,
        })
      : []

  return (
    <div className="space-y-4">
      <Card variant="sunken" noPadding className="p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-[var(--text-secondary)]">Amount</span>
          <span className="font-semibold tabular-nums">{formatMoney(amountMajor, draft.currency)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--text-secondary)]">Date</span>
          <span>{draft.paymentDate}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--text-secondary)]">Paid by</span>
          <span>{participantNames[draft.paidBy] ?? '—'}</span>
        </div>
      </Card>

      {!sameCurrency && (
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
      )}

      {splits.length > 0 && (
        <Card noPadding className="p-4 space-y-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)] block mb-1">Split</span>
          {splits.map((s) => (
            <div key={s.userId} className="flex justify-between text-sm">
              <span className="text-[var(--text-secondary)]">{participantNames[s.userId] ?? s.userId}</span>
              <span className="tabular-nums">{formatMoney(s.amountMajor, draft.currency)}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
