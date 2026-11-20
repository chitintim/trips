import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { daysUntil } from '../../../lib/dates'
import { DEEP_LINKS } from '../../../lib/todos/copy'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { buildTravelCard } from '../lib/travelCardItems'
import type { Trip, TripStatus } from '../../../types'

/** Local calendar date, the same way the "Today's plan" list derives it. */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The viewer's own travel around the trip, or (for someone who is coming and has
 * not added any) the way in to the travel sheet. Reads the already-mounted timeline query.
 */
export function YourTravelCard({
  trip,
  effectiveStage,
  isComing,
}: {
  trip: Trip
  effectiveStage: TripStatus
  isComing: boolean
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { data: events = [] } = useTimeline(trip.id)

  const model = useMemo(
    () =>
      buildTravelCard({
        events,
        userId: user?.id,
        tripStart: trip.start_date,
        tripEnd: trip.end_date,
        today: localToday(),
        effectiveStage,
        isComing,
        daysToStart: daysUntil(trip.start_date),
      }),
    [events, user?.id, trip.start_date, trip.end_date, effectiveStage, isComing],
  )

  if (model.kind === 'none') return null
  const openTravel = () => navigate({ search: DEEP_LINKS.travelDetails() })

  if (model.kind === 'empty') {
    return (
      <Card>
        <Card.Content className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Your travel</h3>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              Add your travel so the group knows when you arrive and leave.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={openTravel} className="shrink-0">
            Add your travel
          </Button>
        </Card.Content>
      </Card>
    )
  }

  return (
    <Card>
      <Card.Content className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Your travel</h3>
          <Button size="sm" variant="secondary" onClick={openTravel}>
            Edit travel
          </Button>
        </div>
        <ul className="space-y-1">
          {model.rows.map((row) => (
            <li key={row.id} className="text-sm text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">{row.dateLabel}</span>
              {row.detail && <span> · {row.detail}</span>}
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  )
}
