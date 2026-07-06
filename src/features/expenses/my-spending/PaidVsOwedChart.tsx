import { formatMoney } from '../lib/formatMoney'
import type { PaidVsOwedEntry } from './personalAnalytics'

export interface PaidVsOwedChartProps {
  entries: PaidVsOwedEntry[]
  currency: string
}

/**
 * Hand-rolled SVG horizontal paired-bar chart: per-person paid vs owed
 * (plan §8/§10). No chart library; small SVG per row, token colors.
 */
export function PaidVsOwedChart({ entries, currency }: PaidVsOwedChartProps) {
  const maxValue = Math.max(1, ...entries.flatMap((e) => [e.paidMajor, e.owedMajor]))

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.userId}>
          <p className="text-xs font-medium text-[var(--text-secondary)] mb-1 truncate">{entry.name}</p>
          <div className="space-y-1">
            <BarRow label="Paid" value={entry.paidMajor} max={maxValue} color="var(--color-success-500, #22c55e)" currency={currency} />
            <BarRow label="Owed" value={entry.owedMajor} max={maxValue} color="var(--color-accent-500, #6366f1)" currency={currency} />
          </div>
        </div>
      ))}
    </div>
  )
}

function BarRow({ label, value, max, color, currency }: { label: string; value: number; max: number; color: string; currency: string }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-[var(--text-muted)] w-9 shrink-0">{label}</span>
      <svg viewBox="0 0 100 8" width="100%" height="10" preserveAspectRatio="none" className="flex-1">
        <rect x="0" y="0" width="100" height="8" rx="2" fill="var(--surface-sunken, #f3f4f6)" />
        <rect x="0" y="0" width={percent} height="8" rx="2" fill={color} />
      </svg>
      <span className="text-xs tabular-nums w-16 text-right shrink-0">{formatMoney(value, currency)}</span>
    </div>
  )
}
