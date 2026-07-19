import { Badge, Button, SelectionAvatars, UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownLabel, isActionCompleteForUser, isGroupComplete, isOverdue } from '../lib/actionStatus'
import type { TripForActionStatus } from '../lib/actionStatus'

export interface ActionRowProps {
  action: ActionWithCompletions
  trip: TripForActionStatus | null | undefined
  participants: ParticipantWithUser[]
  currentUserId: string | undefined
  /** Trip creator/organizer — gates the delete affordance alongside the action's own creator. */
  isOrganizer: boolean
  onToggle: (done: boolean) => void
  onEdit: () => void
  onDelete: () => void
}

/**
 * One action row (Actions segment of ActionsSheet): title, assignee,
 * countdown/overdue badge, and the done control — a plain checkbox for an
 * individual action, or a "Mark yours done" toggle + per-member
 * confirmation avatars for a whole-group action.
 */
export function ActionRow({ action, trip, participants, currentUserId, isOrganizer, onToggle, onEdit, onDelete }: ActionRowProps) {
  const isGroupAction = !action.assigned_to
  const assignee = action.assigned_to ? participants.find((p) => p.user_id === action.assigned_to) : null
  const assigneeName = isGroupAction ? 'Everyone' : assignee?.user?.full_name || assignee?.user?.email || 'Someone'

  const overdue = isOverdue(action, trip)
  const myDone = currentUserId ? isActionCompleteForUser(action, currentUserId) : false
  const groupDone = isGroupAction ? isGroupComplete(action, participants.map((p) => p.user_id)) : false
  const done = isGroupAction ? groupDone : myDone

  const canDelete = isOrganizer || action.created_by === currentUserId

  const completionSelections = (action.trip_action_completions || []).map((c) => {
    const p = participants.find((pp) => pp.user_id === c.user_id)
    return {
      id: c.user_id,
      selected_at: c.completed_at,
      user: p?.user
        ? {
            full_name: p.user.full_name ?? undefined,
            email: p.user.email ?? undefined,
            avatar_url: p.user.avatar_url ?? null,
            avatar_data: undefined,
          }
        : undefined,
    }
  })

  return (
    <li className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5">
      {!isGroupAction ? (
        <input
          type="checkbox"
          checked={done}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-accent-600 cursor-pointer"
          aria-label={`Mark "${action.title}" ${done ? 'not done' : 'done'}`}
        />
      ) : (
        <button
          type="button"
          onClick={() => onToggle(!myDone)}
          className={`mt-0.5 shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            myDone
              ? 'bg-success-100 text-success-800 dark:bg-success-900 dark:text-success-300'
              : 'bg-accent-600 text-white hover:bg-accent-700'
          }`}
        >
          {myDone ? '✓ Done' : 'Mark yours done'}
        </button>
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}>
            {action.title}
          </span>
          {overdue ? (
            <Badge variant="error" size="sm">
              {countdownLabel(action, trip)}
            </Badge>
          ) : (
            <Badge variant="neutral" size="sm">
              {countdownLabel(action, trip)}
            </Badge>
          )}
        </div>
        {action.notes && <p className="text-xs text-[var(--text-secondary)]">{action.notes}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          {isGroupAction ? (
            <span className="flex items-center gap-1.5">
              👥 Everyone
              {completionSelections.length > 0 && <SelectionAvatars selections={completionSelections} size="sm" maxAvatars={4} />}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              {assignee?.user && <UserAvatar avatarData={assignee.user} size="xs" />}
              {assigneeName}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit "${action.title}"`}>
          Edit
        </Button>
        {canDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete "${action.title}"`} className="text-danger-600 hover:text-danger-700">
            ✕
          </Button>
        )}
      </div>
    </li>
  )
}
