import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Card } from '../../../components/ui'
import { useYourCostModel } from '../../../lib/queries/useYourCostModel'
import { buildYourCostView, type YourCostRowView } from '../lib/yourCostView'
import type { Trip } from '../../../types'

const CHIP_VARIANT: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  'est.': 'neutral',
  decided: 'info',
  booked: 'success',
  paid: 'success',
}

function Row({ row, onOpen }: { row: YourCostRowView; onOpen: (search: string) => void }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)] truncate">{row.label}</p>
        {row.detail && <p className="text-xs text-[var(--text-muted)] mt-0.5">{row.detail}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{row.amount}</p>
        <Badge variant={CHIP_VARIANT[row.chip] ?? 'neutral'} size="sm" className="mt-0.5">
          {row.chip}
        </Badge>
      </div>
    </>
  )
  return (
    <li>
      {row.link ? (
        <button
          type="button"
          onClick={() => onOpen(row.link as string)}
          className="w-full flex items-start justify-between gap-3 py-2.5 text-left press-scale"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start justify-between gap-3 py-2.5">{body}</div>
      )}
    </li>
  )
}

/**
 * Today's "Your cost" card (proposal 4.5): one running answer to "what does
 * this trip cost ME?". All wording comes from `buildYourCostView`; this is
 * only layout. Replaces the old estimated-cost stat and "Decided so far".
 */
export function YourCostCard({ trip }: { trip: Trip }) {
  const navigate = useNavigate()
  const { model, isLoading } = useYourCostModel(trip)
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)

  if (isLoading || !model) return null
  const view = buildYourCostView(model)
  const showRows = openOverride ?? view.defaultOpen
  const hasDetail = view.rows.length > 0

  return (
    <Card>
      <Card.Content className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Your cost</p>

        {view.empty ? (
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{view.empty.title}</p>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">{view.empty.body}</p>
          </div>
        ) : (
          <div>
            <p className="text-lg font-semibold text-[var(--text-primary)] tabular-nums">{view.headline}</p>
            {view.subline && <p className="text-xs text-[var(--text-muted)] mt-0.5">{view.subline}</p>}
            {view.comparison && <p className="text-xs text-[var(--text-muted)] mt-1 opacity-70">{view.comparison}</p>}
          </div>
        )}

        {view.basis && <p className="text-xs text-[var(--text-secondary)]">{view.basis}</p>}

        {hasDetail && (
          <>
            <button
              type="button"
              onClick={() => setOpenOverride(!showRows)}
              aria-expanded={showRows}
              className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale"
            >
              {showRows ? 'Hide' : 'Show'} what's in it ({view.rows.length}) {showRows ? '▲' : '▼'}
            </button>
            {showRows && (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {view.rows.map((row) => (
                  <Row key={row.id} row={row} onOpen={(search) => navigate({ search })} />
                ))}
              </ul>
            )}
          </>
        )}

        {view.spent && <p className="text-sm text-[var(--text-primary)] pt-1 border-t border-[var(--border-subtle)]">{view.spent}</p>}
        {view.optionalNote && <p className="text-xs text-[var(--text-muted)]">{view.optionalNote}</p>}
        {view.notIncluded && !view.empty && view.mode === 'estimate' && <p className="text-xs text-[var(--text-muted)]">{view.notIncluded}</p>}
        {view.warnings.map((w) => (
          <p key={w} className="text-xs text-warning-700 dark:text-warning-400">
            {w}
          </p>
        ))}
        {trip.full_cost_link && (
          <a href={trip.full_cost_link} target="_blank" rel="noreferrer" className="inline-block text-sm text-accent-700 hover:underline">
            See full cost breakdown →
          </a>
        )}
      </Card.Content>
    </Card>
  )
}
