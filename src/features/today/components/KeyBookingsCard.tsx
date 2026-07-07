import { Card, Badge, Deadline } from '../../../components/ui'
import { useBookings } from '../../../lib/queries/useBookings'

/**
 * Key bookings summary (awaiting-departure Today layout): confirmed/pending
 * bookings with approaching cancellation deadlines flagged as Deadline chips.
 */
export function KeyBookingsCard({ tripId }: { tripId: string }) {
  const { data: bookings = [] } = useBookings(tripId)
  const active = bookings.filter((b) => b.status !== 'cancelled')
  if (active.length === 0) return null

  return (
    <Card>
      <Card.Content className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Key bookings</h3>
        <ul className="space-y-1.5">
          {active.slice(0, 5).map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-sm">
              <span aria-hidden="true">🧾</span>
              <span className="truncate text-[var(--text-primary)]">{b.title}</span>
              <Badge variant={b.status === 'confirmed' ? 'success' : 'neutral'} size="sm">
                {b.status}
              </Badge>
              {b.cancellation_deadline && new Date(b.cancellation_deadline).getTime() > Date.now() && (
                <span className="ml-auto shrink-0">
                  <Deadline date={b.cancellation_deadline} kind="deadline" size="sm" />
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  )
}
