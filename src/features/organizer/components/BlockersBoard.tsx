import { useMemo, useState } from 'react'
import { Badge, Button, Card, Deadline, EmptyState, Skeleton, UserAvatar } from '../../../components/ui'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useSettlements } from '../../../lib/queries/useSettlements'
import { useBookings } from '../../../lib/queries/useBookings'
import { useNotifications } from '../../../lib/queries/useNotifications'
import { computeBlockers, type Blocker } from '../lib/blockers'
import { parseChaseSettings } from '../lib/chaseSettings'
import { NudgeDraftSheet } from './NudgeDraftSheet'
import type { Trip } from '../../../types'

const KIND_BADGE: Record<Blocker['kind'], { icon: string; variant: 'warning' | 'error' | 'info' | 'neutral' }> = {
  pending_rsvp: { icon: '📝', variant: 'warning' },
  due_conditional: { icon: '⏰', variant: 'error' },
  unvoted_poll: { icon: '🗳️', variant: 'info' },
  unfilled_order: { icon: '🎿', variant: 'info' },
  unclaimed_items: { icon: '🧾', variant: 'warning' },
  unconfirmed_settlement: { icon: '💸', variant: 'warning' },
  expiring_waitlist_offer: { icon: '⏳', variant: 'error' },
  booking_cancellation_deadline: { icon: '🚨', variant: 'error' },
  escalation: { icon: '📣', variant: 'error' },
}

export interface BlockersBoardProps {
  trip: Trip
}

/**
 * Organizer blockers board (plan §14): every open loop on the trip grouped
 * by the person who owes the action, each with a one-tap AI "Nudge" that
 * copies WhatsApp-ready text + deep link. Escalations (3+ auto-chase
 * reminders, still stuck) float to the top of each person's list.
 */
export function BlockersBoard({ trip }: BlockersBoardProps) {
  const tripId = trip.id
  const { data: participants, isLoading: loadingParticipants } = useParticipants(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: expensesData } = useExpenses(tripId)
  const { data: settlements } = useSettlements(tripId)
  const { data: bookings } = useBookings(tripId)
  const { data: notifications } = useNotifications(tripId)

  const [nudge, setNudge] = useState<{ userId: string; name: string; blocker: Blocker } | null>(null)

  const board = useMemo(
    () =>
      computeBlockers({
        participants: participants ?? [],
        sections: sections ?? [],
        votes: votes ?? [],
        expenses: expensesData?.expenses ?? [],
        settlements: settlements ?? [],
        bookings: bookings ?? [],
        notifications: notifications ?? [],
        maxReminders: parseChaseSettings(trip.chase_settings).max_reminders,
      }),
    [participants, sections, votes, expensesData, settlements, bookings, notifications, trip.chase_settings]
  )

  if (loadingParticipants) {
    return (
      <div className="space-y-3">
        <Skeleton variant="card" height={90} />
        <Skeleton variant="card" height={90} />
      </div>
    )
  }

  if (board.totalCount === 0) {
    return (
      <EmptyState
        icon="🎉"
        title="No open loops"
        description="Everyone has voted, claimed, confirmed and paid. Enjoy the silence."
      />
    )
  }

  return (
    <div className="space-y-4">
      {board.bookingDeadlines.length > 0 && (
        <Card variant="flat">
          <Card.Content>
            <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">🚨 Cancellation deadlines</h3>
            <ul className="space-y-2">
              {board.bookingDeadlines.map((b) => (
                <li key={`${b.entityId}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-[var(--text-primary)]">{b.label}</span>
                  {b.deadline && <Deadline date={b.deadline} kind="cancellation" compact />}
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      )}

      {board.people.map((person) => {
        const escalated = person.blockers.some((b) => b.kind === 'escalation')
        const sorted = [...person.blockers].sort((a, b) => (a.kind === 'escalation' ? -1 : 0) - (b.kind === 'escalation' ? -1 : 0))
        return (
          <Card key={person.userId}>
            <Card.Content>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <UserAvatar avatarData={{ avatar_url: person.avatarUrl, avatar_data: person.avatarData }} size="md" />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--text-primary)]">{person.name}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {person.blockers.length} open {person.blockers.length === 1 ? 'loop' : 'loops'}
                      {escalated && ' · needs a personal nudge'}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={escalated ? 'primary' : 'secondary'}
                  onClick={() => setNudge({ userId: person.userId, name: person.name, blocker: sorted[0] })}
                >
                  👋 Nudge
                </Button>
              </div>

              <ul className="mt-3 flex flex-wrap gap-2">
                {sorted.map((blocker, i) => {
                  const style = KIND_BADGE[blocker.kind]
                  return (
                    <li key={`${blocker.kind}:${blocker.entityId ?? i}`}>
                      <button
                        type="button"
                        onClick={() => setNudge({ userId: person.userId, name: person.name, blocker })}
                        title={`${blocker.detail ?? blocker.label} — tap to nudge about this`}
                        className="cursor-pointer"
                      >
                        <Badge variant={style.variant} size="md">
                          {style.icon} {blocker.label}
                        </Badge>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card.Content>
          </Card>
        )
      })}

      {nudge && (
        <NudgeDraftSheet
          key={`${nudge.userId}:${nudge.blocker.kind}:${nudge.blocker.entityId ?? ''}`}
          isOpen
          onClose={() => setNudge(null)}
          tripId={tripId}
          targetUserId={nudge.userId}
          targetName={nudge.name}
          blocker={nudge.blocker}
        />
      )}
    </div>
  )
}
