import { EmptyState } from '../../../components/ui'
import { formatMoney } from '../lib/formatMoney'
import type { DayBreakdownEntry } from './personalAnalytics'

export interface DayByDayBarChartProps {
  entries: DayBreakdownEntry[]
  currency: string
}

/** Short axis tick from the entry label: the day number in the trip, "B"/"A" outside it (the full label stays on aria-label/title). */
function tickFor(label: string): string {
  const day = /^Day (\d+)/.exec(label)
  if (day) return day[1]
  if (label.startsWith('Before')) return 'B'
  if (label.startsWith('After')) return 'A'
  return label
}

/**
 * Hand-rolled SVG bar chart of per-day spend (plan §8/§10: "spend per day
 * bars, trip timeline of burn"). No chart library; small SVG, viewBox
 * scales to the data, token colors.
 */
export function DayByDayBarChart({ entries, currency }: DayByDayBarChartProps) {
  // Audit finding #10: returning null here left the enclosing
  // "Spend per day" Card with a title and no content -- a dead-looking
  // empty card rather than an explained empty state.
  if (entries.length === 0) {
    return <EmptyState compact icon="📊" title="No spending yet" description="Day-by-day spend shows up here once you've added expenses." />
  }

  const maxValue = Math.max(1, ...entries.map((e) => e.myTotalMajor))
  const barWidth = 100 / entries.length
  const chartHeight = 60

  return (
    <div>
      <svg viewBox={`0 0 100 ${chartHeight + 14}`} width="100%" height="120" preserveAspectRatio="none" role="img" aria-label="Spending per day">
        {entries.map((entry, i) => {
          const height = maxValue > 0 ? (entry.myTotalMajor / maxValue) * chartHeight : 0
          const x = i * barWidth + barWidth * 0.15
          const width = barWidth * 0.7
          return (
            <g key={entry.date}>
              <rect
                x={x}
                y={chartHeight - height}
                width={width}
                height={height}
                rx={1}
                fill={entry.myTotalMajor > 0 ? 'var(--color-accent-500, #6366f1)' : 'var(--border-subtle, #e5e7eb)'}
              >
                <title>
                  {entry.label}: {formatMoney(entry.myTotalMajor, currency)}
                </title>
              </rect>
            </g>
          )
        })}
        <line x1="0" y1={chartHeight} x2="100" y2={chartHeight} stroke="var(--border-subtle, #e5e7eb)" strokeWidth="0.5" />
      </svg>
      <div className="flex text-[10px] text-[var(--text-muted)] mt-1">
        {entries.map((entry, i) => (
          <span key={entry.date} style={{ width: `${barWidth}%` }} className="text-center truncate" title={entry.label} aria-label={entry.label}>
            {i === 0 || i === entries.length - 1 || entries.length <= 10 || !entry.label.startsWith('Day') ? tickFor(entry.label) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
