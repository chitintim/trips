import { EmptyState } from '../../../components/ui'
import { CATEGORY_HEX, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import { formatMoney } from '../lib/formatMoney'
import type { CategoryBreakdownEntry } from './personalAnalytics'

export interface CategoryDonutChartProps {
  entries: CategoryBreakdownEntry[]
  currency: string
  size?: number
}

/**
 * Hand-rolled SVG donut chart of category spend (plan §7/§10: "no heavy
 * chart lib — small hand-rolled SVG"). No dependency, small viewBox, token
 * colors from categoryStyle.ts.
 */
export function CategoryDonutChart({ entries, currency, size = 160 }: CategoryDonutChartProps) {
  const total = entries.reduce((sum, e) => sum + e.myTotalMajor, 0)
  if (total <= 0 || entries.length === 0) {
    return <EmptyState compact icon="🥧" title="No spending yet" description="A breakdown by category shows up here once you've added expenses." />
  }

  const radius = 45
  const circumference = 2 * Math.PI * radius
  let cumulativePercent = 0

  const arcs = entries.map((entry) => {
    const percent = entry.myTotalMajor / total
    const dashArray = `${circumference * percent} ${circumference * (1 - percent)}`
    const dashOffset = -cumulativePercent * circumference
    cumulativePercent += percent
    return { entry, percent, dashArray, dashOffset }
  })

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Spending by category">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border-subtle, #e5e7eb)" strokeWidth="10" />
        {arcs.map(({ entry, dashArray, dashOffset }) => (
          <circle
            key={entry.category}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={CATEGORY_HEX[entry.category]}
            strokeWidth="10"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 50 50)"
          />
        ))}
        <text x="50" y="47" textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-primary, #111827)">
          {formatMoney(total, currency)}
        </text>
        <text x="50" y="58" textAnchor="middle" fontSize="6" fill="var(--text-muted, #6b7280)">
          total
        </text>
      </svg>

      <div className="space-y-1.5 flex-1 min-w-0">
        {entries.map((entry) => (
          <div key={entry.category} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_HEX[entry.category] }} />
            <span className="truncate flex-1">
              {categoryIcon(entry.category)} {categoryLabel(entry.category)}
            </span>
            <span className="font-medium tabular-nums">{Math.round(entry.percentOfMyTotal)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}
