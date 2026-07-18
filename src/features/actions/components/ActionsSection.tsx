import { useMemo } from 'react'
import { Badge, Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTrip } from '../../../lib/queries/useTrip'
import { useActions } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownLabel, isActionCompleteForUser, isOverdue } from '../lib/actionStatus'

export interface ActionsSectionProps {
  tripId: string
  isOrganizer: boolean
  onOpenActions: () => void
}

/**
 * Today-tab card: up to 3 most-urgent OPEN actions relevant to the current
 * user — assigned to them directly, or a whole-group action they haven't
 * confirmed yet — overdue first. Mirrors YourTurnStack's card idiom.
 * Renders nothing when there's nothing relevant and the user isn't an
 * organizer (no reason to show an empty actions card to a participant);
 * an organizer instead gets a slim "Add an action" affordance so the
 * feature stays discoverable even before anything's been created.
 */
export function ActionsSection({ tripId, isOrganizer, onOpenActions }: ActionsSectionProps) {
  const { user } = useAuth()
  const { data: trip } = useTrip(tripId)
  const { data: actions } = useActions(tripId)

  const relevant = useMemo(() => {
    if (!user) return []
    const mine = (actions || []).filter((a) => {
      if (a.completed_at != null && a.assigned_to) return false // individual, already done
      if (a.assigned_to) return a.assigned_to === user.id
      // Group action: relevant while the current user hasn't confirmed it.
      return !isActionCompleteForUser(a, user.id)
    })
    return [...mine].sort((a, b) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    })
  }, [actions, user, trip])

  const topThree = relevant.slice(0, 3)

  if (topThree.length === 0) {
    if (!isOrganizer) return null
    return (
      <button
        onClick={onOpenActions}
        className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
      >
        <span className="text-sm text-[var(--text-primary)]">✅ Add an action</span>
        <span className="text-sm text-[var(--text-muted)]">Actions →</span>
      </button>
    )
  }

  return (
    <section aria-label="Actions" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide">Actions</h2>
        <Button variant="ghost" size="sm" onClick={onOpenActions}>
          View all
        </Button>
      </div>
      <Card>
        <Card.Content className="space-y-2 py-3">
          {topThree.map((action) => (
            <ActionSectionRow key={action.id} action={action} trip={trip} onOpenActions={onOpenActions} />
          ))}
        </Card.Content>
      </Card>
    </section>
  )
}

function ActionSectionRow({
  action,
  trip,
  onOpenActions,
}: {
  action: ActionWithCompletions
  trip: { start_date?: string | null } | null | undefined
  onOpenActions: () => void
}) {
  const overdue = isOverdue(action, trip)
  return (
    <button
      onClick={onOpenActions}
      className="w-full flex items-center justify-between gap-3 text-left rounded-[var(--radius-md)] hover:bg-[var(--surface-sunken)] px-1 py-1 -mx-1 transition-colors"
    >
      <span className="text-sm text-[var(--text-primary)] truncate">{action.title}</span>
      <Badge variant={overdue ? 'error' : 'neutral'} size="sm">
        {countdownLabel(action, trip)}
      </Badge>
    </button>
  )
}
