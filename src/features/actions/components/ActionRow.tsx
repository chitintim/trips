import { Badge, Button, LinkifiedText, SelectionAvatars, UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownBadgeVariant, countdownLabel, isActionCompleteForUser, isGroupComplete } from '../lib/actionStatus'
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
 * countdown/overdue badge (red ≤2 days or overdue, amber ≤7 days), and the
 * done control — an obvious tappable circle checkbox (44px touch target).
 * For an individual action it reflects the action's completion; for a
 * whole-group action it reflects the current user's own confirmation, with
 * per-member avatars showing the rest of the group's progress.
 */
export function ActionRow({ action, trip, participants, currentUserId, isOrganizer, onToggle, onEdit, onDelete }: ActionRowProps) {
  const isGroupAction = !action.assigned_to
  const assignee = action.assigned_to ? participants.find((p) => p.user_id === action.assigned_to) : null
  const assigneeName = isGroupAction ? 'Everyone' : assignee?.user?.full_name || assignee?.user?.email || 'Someone'

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
      <DoneCircle
        checked={isGroupAction ? myDone : done}
        onToggle={(next) => onToggle(next)}
        label={
          isGroupAction
            ? `Mark yours ${myDone ? 'not done' : 'done'} for "${action.title}"`
            : `Mark "${action.title}" ${done ? 'not done' : 'done'}`
        }
      />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}>
            {action.title}
          </span>
          <Badge variant={countdownBadgeVariant(action, trip)} size="sm">
            {countdownLabel(action, trip)}
          </Badge>
        </div>
        {action.notes && (
          <LinkifiedText as="p" text={action.notes} className="min-w-0 break-words text-xs text-[var(--text-secondary)]" />
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          {isGroupAction ? (
            <span className="flex items-center gap-1.5">
              👥 Everyone
              {myDone && !groupDone && <span className="text-success-600 dark:text-success-400">· yours done</span>}
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

/**
 * Obvious tappable done-toggle: a 24px circle that fills green with a
 * check when done, inside a 44px hit area (negative margins keep the row
 * visually tight while the touch target stays accessible).
 */
function DoneCircle({ checked, onToggle, label }: { checked: boolean; onToggle: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onToggle(!checked)}
      className="group/done relative -my-2 -ml-2 -mr-1 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
    >
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition-all duration-150 ${
          checked
            ? 'border-success-500 bg-success-500 text-white'
            : 'border-[var(--border-default)] bg-[var(--surface-raised)] group-hover/done:border-success-500'
        }`}
      >
        <svg
          viewBox="0 0 12 12"
          className={`h-3.5 w-3.5 transition-all duration-150 ${checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 6.5 4.7 9 10 3.5" />
        </svg>
      </span>
    </button>
  )
}
