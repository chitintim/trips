import { useMemo } from 'react'
import { Button, Card } from '../../../components/ui'
import { usePlanItems } from '../../plan'
import { formatMoney } from '../../decisions/lib/costImpact'
import type { Trip } from '../../../types'

export interface DecidedSoFarCardProps {
  trip: Trip
  onNavigate: (spaceId: string) => void
}

/**
 * "Decided so far" mini-summary (planning-stage Today layout): the top
 * decided/booked plan items plus the per-person running cost of everything
 * decided, with a jump into the Plan space.
 */
export function DecidedSoFarCard({ trip, onNavigate }: DecidedSoFarCardProps) {
  const { items } = usePlanItems(trip.id)

  const { decided, perPersonByCurrency } = useMemo(() => {
    const decidedItems = items.filter((i) => i.stage === 'decided' || i.stage === 'booked')
    const totals = new Map<string, number>()
    for (const item of decidedItems) {
      if (item.costImpact?.perPerson != null && item.costImpact.currency) {
        totals.set(item.costImpact.currency, (totals.get(item.costImpact.currency) || 0) + item.costImpact.perPerson)
      }
    }
    return { decided: decidedItems, perPersonByCurrency: totals }
  }, [items])

  if (decided.length === 0) return null

  const runningCost = [...perPersonByCurrency.entries()].map(([currency, amount]) => formatMoney(amount, currency)).join(' + ')

  return (
    <Card>
      <Card.Content className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Decided so far</h3>
          <span className="text-xs text-[var(--text-muted)]">
            {decided.length} {decided.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <ul className="space-y-1">
          {decided.slice(0, 3).map((item) => (
            <li key={item.id} className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
              <span aria-hidden="true">{item.stage === 'booked' ? '🧾' : '✅'}</span>
              <span className="truncate">{item.title}</span>
              {item.date && (
                <span className="text-xs text-[var(--text-muted)] shrink-0">
                  {new Date(item.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {runningCost && (
          <p className="text-sm text-[var(--text-primary)]">
            <span className="font-semibold">{runningCost}</span>
            <span className="text-[var(--text-muted)]"> per person so far</span>
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={() => onNavigate('plan')}>
          See the plan →
        </Button>
      </Card.Content>
    </Card>
  )
}
