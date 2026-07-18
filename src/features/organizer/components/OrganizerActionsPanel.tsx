import { useMemo } from 'react'
import { Badge, Card, EmptyState, Skeleton, UserAvatar } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useActions } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownLabel, isOverdue } from '../../actions/lib/actionStatus'

export interface OrganizerActionsPanelProps {
  tripId: string
}

/**
 * Compact organizer view of every OPEN trip action, overdue first — for
 * group actions, a per-person completion count so the organizer can see
 * at a glance who's still holding things up. Sits alongside BlockersBoard
 * in the organizer console (plan §14).
 */
export function OrganizerActionsPanel({ tripId }: OrganizerActionsPanelProps) {
  const { data: trip, isLoading: tripLoading, isError: tripError } = useTrip(tripId)
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)
  const { data: actions, isLoading: actionsLoading, isError: actionsError } = useActions(tripId)

  const openSorted = useMemo(() => {
    const activeIds = (participants ?? []).filter((p) => p.active !== false).map((p) => p.user_id)
    const open = (actions ?? []).filter((a) => {
      if (a.assigned_to) return a.completed_at == null
      const completedIds = new Set((a.trip_action_completions || []).map((c) => c.user_id))
      return !(activeIds.length > 0 && activeIds.every((id) => completedIds.has(id)))
    })
    return [...open].sort((a, b) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    })
  }, [actions, participants, trip])

  if (tripLoading || actionsLoading || participantsLoading) {
    return (
      <div className="space-y-2">
        <Skeleton variant="card" height={64} />
        <Skeleton variant="card" height={64} />
      </div>
    )
  }

  if (tripError || actionsError) {
    return (
      <EmptyState
        icon={<ErrorState className="w-16 h-16 text-danger-500" />}
        title="Couldn't load actions"
        description="Something went wrong fetching this trip's actions."
      />
    )
  }

  if (openSorted.length === 0) {
    return (
      <EmptyState icon="✅" title="Nothing open" description="Every action on this trip is done." />
    )
  }

  return (
    <ul className="space-y-2">
      {openSorted.map((action) => (
        <OrganizerActionRow key={action.id} action={action} trip={trip} activeParticipants={participants ?? []} />
      ))}
    </ul>
  )
}

function OrganizerActionRow({
  action,
  trip,
  activeParticipants,
}: {
  action: ActionWithCompletions
  trip: { start_date?: string | null } | null | undefined
  activeParticipants: { user_id: string; active?: boolean | null; user?: { full_name?: string | null; email?: string | null } }[]
}) {
  const overdue = isOverdue(action, trip)
  const isGroupAction = !action.assigned_to
  const activeIds = activeParticipants.filter((p) => p.active !== false).map((p) => p.user_id)
  const completedIds = new Set((action.trip_action_completions || []).map((c) => c.user_id))
  const doneCount = activeIds.filter((id) => completedIds.has(id)).length
  const assignee = action.assigned_to ? activeParticipants.find((p) => p.user_id === action.assigned_to) : null

  return (
    <Card variant="flat">
      <Card.Content className="flex items-center justify-between gap-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{action.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            {isGroupAction ? (
              <>
                👥 {doneCount}/{activeIds.length} done
              </>
            ) : (
              <>
                {assignee?.user && <UserAvatar avatarData={assignee.user} size="xs" />}
                {assignee?.user?.full_name || assignee?.user?.email || 'Someone'}
              </>
            )}
          </p>
        </div>
        <Badge variant={overdue ? 'error' : 'neutral'} size="sm">
          {countdownLabel(action, trip)}
        </Badge>
      </Card.Content>
    </Card>
  )
}
