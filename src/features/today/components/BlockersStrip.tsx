import { useMemo } from 'react'
import { Button, Card, Badge } from '../../../components/ui'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useSettlements } from '../../../lib/queries/useSettlements'
import { useBookings } from '../../../lib/queries/useBookings'
import { useNotifications } from '../../../lib/queries/useNotifications'
import { computeBlockers, parseChaseSettings } from '../../organizer'
import type { Blocker } from '../../organizer'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import type { Trip } from '../../../types'

export interface BlockersStripProps {
  trip: Trip
  onOpenConsole: () => void
}

/**
 * Organizer action strip (UX_REDESIGN §1 Today): the top 3 blockers across
 * the whole board, compact, with one tap into the full Console (which is a
 * launched screen now, not a tab).
 */
export function BlockersStrip({ trip, onOpenConsole }: BlockersStripProps) {
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: sections = [] } = useSections(trip.id)
  const { data: votes = [] } = useVotes(trip.id)
  const { data: expensesData } = useExpenses(trip.id)
  const { data: settlements = [] } = useSettlements(trip.id)
  const { data: bookings = [] } = useBookings(trip.id)
  const { data: notifications = [] } = useNotifications(trip.id)

  const { top, totalCount } = useMemo(() => {
    const board = computeBlockers({
      participants,
      sections,
      votes,
      expenses: expensesData?.expenses ?? [],
      settlements,
      bookings,
      notifications,
      maxReminders: parseChaseSettings(trip.chase_settings).max_reminders,
      confirmationEnabled: isConfirmationEnabled(trip),
    })
    // Flatten person blockers (already sorted most-blocked first) with the
    // person's name attached, deadline-carrying booking warnings first.
    const flattened: Array<{ name: string | null; blocker: Blocker }> = [
      ...board.bookingDeadlines.map((b) => ({ name: null, blocker: b })),
      ...board.people.flatMap((p) => p.blockers.map((b) => ({ name: p.name, blocker: b }))),
    ]
    return { top: flattened.slice(0, 3), totalCount: board.totalCount }
  }, [participants, sections, votes, expensesData, settlements, bookings, notifications, trip.chase_settings, trip.confirmation_enabled])

  if (totalCount === 0) return null

  return (
    <Card variant="flat">
      <Card.Content className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Blockers</h3>
            <Badge variant="warning" size="sm">
              {totalCount}
            </Badge>
          </div>
          <Button size="sm" variant="secondary" onClick={onOpenConsole}>
            Open console
          </Button>
        </div>
        <ul className="space-y-1">
          {top.map(({ name, blocker }, idx) => (
            <li key={`${blocker.kind}-${blocker.userId}-${idx}`} className="text-sm text-[var(--text-secondary)] truncate">
              {name ? <span className="font-medium text-[var(--text-primary)]">{name}: </span> : null}
              {blocker.label}
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  )
}
