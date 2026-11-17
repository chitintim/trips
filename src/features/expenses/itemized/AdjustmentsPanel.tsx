import { useEffect, useState } from 'react'
import { SegmentedControl, Input } from '../../../components/ui'
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { SERVICE_TAX_PERCENT_QUICK_SELECTS } from '../lib/adjustmentDistribution'
import { formatMoneyMinor } from '../lib/formatMoney'
import { computeDraftReconciliation, type ItemizedDraft } from './itemizedState'
import type { AdjustmentMode } from '../lib/adjustmentDistribution'

export interface AdjustmentsPanelProps {
  draft: ItemizedDraft
  onChange: (next: ItemizedDraft) => void
}

const MODE_OPTIONS: Array<{ value: AdjustmentMode; label: string }> = [
  { value: 'included', label: 'Included in prices' },
  { value: 'added_on_top', label: 'Added on top' },
  { value: 'none', label: 'None' },
]

/**
 * Adjustments review panel (plan §10 #3): service charge & tax as
 * segmented choices + percent quick-selects (5/8/10/12.5/15/18/20) + tip +
 * discounts, with a live reconciliation bar showing Σitems ± adjustments
 * vs printed total (green when exact, amber with delta otherwise).
 */
export function AdjustmentsPanel({ draft, onChange }: AdjustmentsPanelProps) {
  const reconciliation = computeDraftReconciliation(draft)

  const updateTax = (patch: Partial<ItemizedDraft['adjustments']['tax']>) =>
    onChange({ ...draft, adjustments: { ...draft.adjustments, tax: { ...draft.adjustments.tax, ...patch } } })

  const updateService = (patch: Partial<ItemizedDraft['adjustments']['service']>) =>
    onChange({ ...draft, adjustments: { ...draft.adjustments, service: { ...draft.adjustments.service, ...patch } } })

  return (
    <div className="space-y-5">
      {/* Tax */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Tax</label>
        <SegmentedControl options={MODE_OPTIONS} value={draft.adjustments.tax.mode} onChange={(mode) => updateTax({ mode })} fullWidth size="sm" />
        {draft.adjustments.tax.mode === 'added_on_top' && (
          <PercentQuickSelects value={draft.adjustments.tax.percent} onChange={(percent) => updateTax({ percent })} />
        )}
      </div>

      {/* Service charge */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Service charge</label>
        <SegmentedControl
          options={MODE_OPTIONS}
          value={draft.adjustments.service.mode}
          onChange={(mode) => updateService({ mode })}
          fullWidth
          size="sm"
        />
        {draft.adjustments.service.mode === 'added_on_top' && (
          <PercentQuickSelects value={draft.adjustments.service.percent} onChange={(percent) => updateService({ percent })} />
        )}
      </div>

      {/* Tip + discount */}
      <div className="grid grid-cols-2 gap-3">
        <FlatMinorInput
          label="Tip"
          currency={draft.currency}
          minor={draft.adjustments.tipMinor}
          onCommit={(tipMinor) => onChange({ ...draft, adjustments: { ...draft.adjustments, tipMinor } })}
        />
        <FlatMinorInput
          label="Discount"
          currency={draft.currency}
          minor={draft.adjustments.discountMinor}
          onCommit={(discountMinor) => onChange({ ...draft, adjustments: { ...draft.adjustments, discountMinor } })}
        />
      </div>

      {/* Flat amounts printed on the receipt (no percent): added on top of the items. */}
      <div className="grid grid-cols-3 gap-3">
        <FlatMinorInput label="Service (amount)" currency={draft.currency} minor={draft.flatServiceMinor ?? 0} onCommit={(m) => onChange({ ...draft, flatServiceMinor: m })} />
        <FlatMinorInput label="Tax (amount)" currency={draft.currency} minor={draft.flatTaxMinor ?? 0} onCommit={(m) => onChange({ ...draft, flatTaxMinor: m })} />
        <FlatMinorInput
          label="Rounding"
          currency={draft.currency}
          minor={draft.roundingMinor ?? 0}
          onCommit={(m) => onChange({ ...draft, roundingMinor: m })}
          allowNegative
          helperText="Can be negative"
        />
      </div>

      <Input
        label="Printed total (from receipt)"
        size="sm"
        inputMode="decimal"
        value={draft.printedTotal}
        onChange={(e) => onChange({ ...draft, printedTotal: e.target.value })}
      />

      {/* Live reconciliation bar */}
      <div
        className={`rounded-[var(--radius-md)] border px-3 py-2.5 text-sm font-medium ${
          reconciliation.isExact
            ? 'bg-success-50 border-success-200 text-success-700 dark:bg-success-900 dark:border-success-800 dark:text-success-300'
            : 'bg-warn-50 border-warn-200 text-warn-700 dark:bg-warn-900 dark:border-warn-800 dark:text-warn-300'
        }`}
        role="status"
      >
        <div className="flex items-center justify-between">
          <span>{reconciliation.isExact ? '✓ Reconciled exactly' : "⚠️ Doesn't reconcile"}</span>
          <span className="tabular-nums">{formatMoneyMinor(reconciliation.computedTotalMinor, draft.currency)}</span>
        </div>
        {!reconciliation.isExact && (
          <p className="mt-1 text-xs opacity-90">
            Off by {formatMoneyMinor(Math.abs(reconciliation.deltaMinor), draft.currency)} vs printed total{' '}
            {formatMoneyMinor(reconciliation.printedTotalMinor, draft.currency)}.
          </p>
        )}
      </div>
    </div>
  )
}

function PercentQuickSelects({ value, onChange }: { value: number; onChange: (percent: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {SERVICE_TAX_PERCENT_QUICK_SELECTS.map((pct) => (
        <button
          key={pct}
          type="button"
          onClick={() => onChange(pct)}
          className={`px-2.5 py-1 rounded-[var(--radius-full)] text-xs font-medium border transition-colors ${
            value === pct
              ? 'bg-accent-600 border-accent-600 text-white'
              : 'bg-[var(--surface-sunken)] border-transparent text-[var(--text-secondary)] hover:bg-[var(--border-subtle)]'
          }`}
        >
          {pct}%
        </button>
      ))}
      <input
        type="text"
        inputMode="decimal"
        value={value === 0 ? '' : String(value)}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        placeholder="Custom %"
        className="w-20 h-7 px-2 rounded-[var(--radius-full)] border border-[var(--border-default)] bg-[var(--surface-raised)] text-xs focus:outline-none focus:ring-2 focus:ring-accent-500"
      />
    </div>
  )
}

/**
 * Money field in minor units with its own text state, so half-typed values
 * ("1.", "-") are not rewritten under the user's fingers. Resets from the
 * outside only when the committed amount changes (e.g. a one-tap fix).
 */
function FlatMinorInput({
  label,
  currency,
  minor,
  onCommit,
  allowNegative,
  helperText,
}: {
  label: string
  currency: string
  minor: number
  onCommit: (minor: number) => void
  allowNegative?: boolean
  helperText?: string
}) {
  const format = (m: number) => (m === 0 ? '' : String(fromMinorUnits(m, currency)))
  const parse = (t: string) => {
    const n = parseFloat(t)
    if (!Number.isFinite(n)) return 0
    return toMinorUnits(allowNegative ? n : Math.abs(n), currency)
  }
  const [text, setText] = useState(() => format(minor))
  useEffect(() => {
    setText((current) => (parse(current) === minor ? current : format(minor)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minor, currency])
  return (
    <Input
      label={label}
      size="sm"
      inputMode={allowNegative ? 'text' : 'decimal'}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onCommit(parse(e.target.value))
      }}
      placeholder="0.00"
      helperText={helperText}
    />
  )
}
