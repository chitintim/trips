import { useMemo } from 'react'
import { Badge, Card, EmptyState, Skeleton, SelectionAvatars, UserAvatar } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { useActions, useSectionVoters } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownLabel, groupCompletedUserIds, isActionCompleteForUser, isOverdue } from '../../actions/lib/actionStatus'
import type { SectionVoterIds } from '../../actions/lib/actionStatus'

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
  const sectionVoters = useSectionVoters(tripId)

  const openSorted = useMemo(() => {
    const activeIds = (participants ?? []).filter((p) => p.active !== false).map((p) => p.user_id)
    const open = (actions ?? []).filter((a) => {
      if (a.assigned_to) return !isActionCompleteForUser(a, a.assigned_to, sectionVoters)
      const completedIds = groupCompletedUserIds(a, sectionVoters)
      return !(activeIds.length > 0 && activeIds.every((id) => completedIds.has(id)))
    })
    return [...open].sort((a, b) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    })
  }, [actions, participants, trip, sectionVoters])

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
        <OrganizerActionRow key={action.id} action={action} trip={trip} activeParticipants={participants ?? []} sectionVoters={sectionVoters} />
      ))}
    </ul>
  )
}

function OrganizerActionRow({
  action,
  trip,
  activeParticipants,
  sectionVoters,
}: {
  action: ActionWithCompletions
  trip: { start_date?: string | null } | null | undefined
  activeParticipants: ParticipantWithUser[]
  sectionVoters: SectionVoterIds
}) {
  const overdue = isOverdue(action, trip)
  const isGroupAction = !action.assigned_to
  const activeIds = activeParticipants.filter((p) => p.active !== false).map((p) => p.user_id)
  const completedIds = groupCompletedUserIds(action, sectionVoters)
  const doneCount = activeIds.filter((id) => completedIds.has(id)).length
  const assignee = action.assigned_to ? activeParticipants.find((p) => p.user_id === action.assigned_to) : null

  // The organizer's actual need for a group action isn't "how many are
  // done" -- it's who to go chase. Surface the outstanding (active, not
  // yet completed) participants as an avatar stack.
  const outstandingSelections = activeIds
    .filter((id) => !completedIds.has(id))
    .map((id) => {
      const p = activeParticipants.find((pp) => pp.user_id === id)
      return {
        id,
        user: p?.user
          ? {
              full_name: p.user.full_name ?? undefined,
              email: p.user.email ?? undefined,
              avatar_url: p.user.avatar_url ?? undefined,
              avatar_data: (p.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
            }
          : undefined,
      }
    })

  return (
    <Card variant="flat">
      <Card.Content className="flex items-center justify-between gap-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{action.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
            {isGroupAction ? (
              <>
                <span>
                  👥 {doneCount}/{activeIds.length} done
                </span>
                {outstandingSelections.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Waiting on</span>
                    <SelectionAvatars
                      selections={outstandingSelections}
                      size="sm"
                      maxAvatars={4}
                      entityLabel="hasn't done this yet"
                    />
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Assigned to</span>
                {assignee?.user && <UserAvatar avatarData={assignee.user} size="xs" />}
                {assignee?.user?.full_name || assignee?.user?.email || 'Someone'}
              </>
            )}
          </div>
        </div>
        <Badge variant={overdue ? 'error' : 'neutral'} size="sm">
          {countdownLabel(action, trip)}
        </Badge>
      </Card.Content>
    </Card>
  )
}
