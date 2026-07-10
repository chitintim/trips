import { SegmentedControl, Input } from '../../../components/ui'
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { computeReconciliationBar, SERVICE_TAX_PERCENT_QUICK_SELECTS } from '../lib/adjustmentDistribution'
import { formatMoneyMinor } from '../lib/formatMoney'
import type { ItemizedDraft } from './itemizedState'
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
  const itemSubtotalsMinor = draft.lineItems.map((l) => toMinorUnits(parseFloat(l.lineTotal) || 0, draft.currency))
  const printedTotalMinor = toMinorUnits(parseFloat(draft.printedTotal) || 0, draft.currency)

  const reconciliation = computeReconciliationBar(itemSubtotalsMinor, draft.adjustments, printedTotalMinor)

  const updateTax = (patch: Partial<ItemizedDraft['adjustments']['tax']>) =>
    onChange({ ...draft, adjustments: { ...draft.adjustments, tax: { ...draft.adjustments.tax, ...patch } } })

  const updateService = (patch: Partial<ItemizedDraft['adjustments']['service']>) =>
    onChange({ ...draft, adjustments: { ...draft.adjustments, service: { ...draft.adjustments.service, ...patch } } })

  const tipMajor = fromMinorUnits(draft.adjustments.tipMinor, draft.currency)
  const discountMajor = fromMinorUnits(draft.adjustments.discountMinor, draft.currency)

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
        <Input
          label="Tip"
          size="sm"
          inputMode="decimal"
          value={tipMajor === 0 ? '' : String(tipMajor)}
          onChange={(e) => onChange({ ...draft, adjustments: { ...draft.adjustments, tipMinor: toMinorUnits(parseFloat(e.target.value) || 0, draft.currency) } })}
          placeholder="0.00"
        />
        <Input
          label="Discount"
          size="sm"
          inputMode="decimal"
          value={discountMajor === 0 ? '' : String(discountMajor)}
          onChange={(e) => onChange({ ...draft, adjustments: { ...draft.adjustments, discountMinor: toMinorUnits(parseFloat(e.target.value) || 0, draft.currency) } })}
          placeholder="0.00"
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
