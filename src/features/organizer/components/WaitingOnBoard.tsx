import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Badge, Button, Card, Deadline, EmptyState, SegmentedControl, Skeleton, UserAvatar } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useBookings } from '../../../lib/queries/useBookings'
import { useNotifications } from '../../../lib/queries/useNotifications'
import { useWaitingOn } from '../../../lib/queries/useTodos'
import { isTripFinished } from '../../../lib/answers/answers'
import { WAITING_ON_EMPTY, anyOrganizerLabel, todoCountLabel, formatDayMonth } from '../../../lib/todos/copy'
import type { Todo, WaitingOnItem } from '../../../lib/todos/types'
import { ActionsSheet } from '../../actions/components/ActionsSheet'
import { NEW_TODO_LABEL, doneCountLabel } from '../../actions/lib/todoLabels'
import {
  escalatedUserIds,
  isOrganiserOwn,
  lastRemindedByUser,
  showLastReminded,
  todoToBlocker,
  upcomingCancellationDeadlines,
  type Blocker,
} from '../lib/blockers'
import { parseChaseSettings } from '../lib/chaseSettings'
import { NudgeDraftSheet } from './NudgeDraftSheet'
import type { Trip } from '../../../types'

type WaitingView = 'person' | 'item'

const KIND_ICON: Record<Todo['kind'], string> = {
  rsvp: '📝',
  answer: '❓',
  task: '✅',
  pay: '💸',
  confirm_payment: '🤝',
  claim: '🧾',
  travel: '✈️',
  waitlist_offer: '⏳',
  org_decide: '⚖️',
  org_tie: '⚖️',
  org_book: '📌',
  org_setup: '🚀',
}

export interface WaitingOnBoardProps {
  trip: Trip
}

interface NudgeTarget {
  userId: string
  name: string
  blocker: Blocker
}

/**
 * The organiser's mirror of everyone's to-dos (UX redesign 3.6): the same
 * engine as "Your to-dos", run for every person, shown By person or By item.
 * Each person's row is exactly their own to-do list, so this board and the
 * participant's screen cannot disagree. Tasks (formerly the Actions panel)
 * appear as items; "New to-do" opens the To-dos sheet to create or edit one.
 */
export function WaitingOnBoard({ trip }: WaitingOnBoardProps) {
  const tripId = trip.id
  const { user } = useAuth()
  const { canManageTrip } = useTripPermissions(trip)
  const { waitingOn, isLoading } = useWaitingOn(tripId)
  const { data: participants } = useParticipants(tripId)
  const { refetch: refetchTrip } = useTrip(tripId)
  const { refetch: refetchParticipants } = useParticipants(tripId)
  const { data: notifications } = useNotifications(tripId)
  const { data: bookings } = useBookings(tripId)

  const [view, setView] = useState<WaitingView>('person')
  const [nudge, setNudge] = useState<NudgeTarget | null>(null)
  const [todosOpen, setTodosOpen] = useState(false)

  const people = useMemo(() => {
    const map = new Map<string, { name: string; avatarUrl: unknown; avatarData: unknown }>()
    for (const p of participants ?? []) {
      map.set(p.user_id, {
        name: p.user?.full_name || p.user?.email || 'Someone',
        avatarUrl: p.user?.avatar_url ?? null,
        avatarData: p.user?.avatar_data ?? null,
      })
    }
    return map
  }, [participants])

  const lastReminded = useMemo(() => lastRemindedByUser(notifications ?? []), [notifications])
  const escalated = useMemo(
    () => escalatedUserIds(notifications ?? [], parseChaseSettings(trip.chase_settings).max_reminders),
    [notifications, trip.chase_settings]
  )
  const deadlines = useMemo(() => upcomingCancellationDeadlines(bookings ?? []), [bookings])

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton variant="card" height={90} />
        <Skeleton variant="card" height={90} />
      </div>
    )
  }

  if (!waitingOn) {
    return (
      <EmptyState
        icon={<ErrorState className="w-20 h-20 text-danger-500" />}
        title="Couldn't load what people owe"
        description="Something went wrong fetching this trip. Check your connection and try again."
        action={
          <Button
            variant="primary"
            onClick={() => {
              refetchTrip()
              refetchParticipants()
            }}
          >
            Try again
          </Button>
        }
      />
    )
  }

  const nameOf = (userId: string) => people.get(userId)?.name ?? waitingOn.byPerson.find((p) => p.userId === userId)?.name ?? 'Someone'
  const startNudge = (userId: string, todo: Todo) => setNudge({ userId, name: nameOf(userId), blocker: todoToBlocker(todo) })
  const canNudge = (userId: string, todo: Todo) => canManageTrip && !isOrganiserOwn(todo) && userId !== user?.id
  const nothing = waitingOn.byPerson.length === 0
  const tripFinished = isTripFinished(trip)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SegmentedControl
          size="sm"
          value={view}
          onChange={(v) => setView(v as WaitingView)}
          options={[
            { value: 'person', label: 'By person' },
            { value: 'item', label: 'By item' },
          ]}
        />
        {canManageTrip && !tripFinished && (
          <Button size="sm" variant="secondary" onClick={() => setTodosOpen(true)} className="shrink-0">
            + {NEW_TODO_LABEL}
          </Button>
        )}
      </div>

      {deadlines.length > 0 && (
        <Card variant="flat">
          <Card.Content>
            <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">🚨 Cancellation deadlines</h3>
            <ul className="space-y-2">
              {deadlines.map((b) => (
                <li key={`${b.entityId}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 break-words text-[var(--text-primary)]">{b.label}</span>
                  {b.deadline && (
                    <span className="shrink-0">
                      <Deadline date={b.deadline} kind="cancellation" compact />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      )}

      {nothing && <EmptyState icon="🎉" title={WAITING_ON_EMPTY} />}

      {!nothing && view === 'person' &&
        waitingOn.byPerson.map((person) => {
          const info = people.get(person.userId)
          const isEscalated = escalated.has(person.userId)
          const reminded = lastReminded.get(person.userId)
          const nudgeable = person.todos.filter((t) => canNudge(person.userId, t))
          return (
            <Card key={person.userId}>
              <Card.Content>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <UserAvatar avatarData={{ avatar_url: info?.avatarUrl, avatar_data: info?.avatarData }} size="md" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[var(--text-primary)]">{info?.name ?? person.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {todoCountLabel(person.count)}
                        {person.overdueCount > 0 && ` · ${person.overdueCount} overdue`}
                        {reminded && showLastReminded(reminded, tripFinished) && ` · Last reminded ${formatDistanceToNow(new Date(reminded), { addSuffix: true })}`}
                        {isEscalated && ' · needs a personal nudge'}
                      </p>
                    </div>
                  </div>
                  {nudgeable.length > 0 && (
                    <Button
                      size="sm"
                      variant={isEscalated ? 'primary' : 'secondary'}
                      onClick={() => startNudge(person.userId, nudgeable[0])}
                    >
                      👋 Nudge
                    </Button>
                  )}
                </div>

                {/* Long titles quote question/to-do names; wrap inside the chip. */}
                <ul className="mt-3 flex flex-wrap gap-2">
                  {person.todos.map((todo) => {
                    const chip = (
                      <Badge variant={todo.overdue ? 'error' : 'neutral'} size="md" wrap>
                        {KIND_ICON[todo.kind]} {todo.title}
                      </Badge>
                    )
                    return (
                      <li key={todo.id} className="min-w-0 max-w-full">
                        {canNudge(person.userId, todo) ? (
                          <button
                            type="button"
                            onClick={() => startNudge(person.userId, todo)}
                            title={`${todo.subtitle ?? todo.title}: tap to nudge about this`}
                            className="cursor-pointer max-w-full text-left"
                          >
                            {chip}
                          </button>
                        ) : (
                          chip
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Card.Content>
            </Card>
          )
        })}

      {!nothing && view === 'item' && (
        <ul className="space-y-2">
          {waitingOn.byItem.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              nameOf={nameOf}
              todoFor={(userId) => waitingOn.byUser.get(userId)?.find((t) => t.id === item.todoIds[userId])}
              canNudge={canNudge}
              onNudge={startNudge}
              onEdit={canManageTrip ? () => setTodosOpen(true) : undefined}
            />
          ))}
        </ul>
      )}

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

      {todosOpen && <ActionsSheet isOpen onClose={() => setTodosOpen(false)} tripId={tripId} isOrganizer={canManageTrip} />}
    </div>
  )
}

function progressLabel(item: WaitingOnItem): string | null {
  if (item.done === undefined || item.total === undefined) return null
  return item.kind === 'answer' ? `${item.done} of ${item.total} answered` : doneCountLabel(item.done, item.total)
}

function ItemRow({
  item,
  nameOf,
  todoFor,
  canNudge,
  onNudge,
  onEdit,
}: {
  item: WaitingOnItem
  nameOf: (userId: string) => string
  todoFor: (userId: string) => Todo | undefined
  canNudge: (userId: string, todo: Todo) => boolean
  onNudge: (userId: string, todo: Todo) => void
  onEdit?: () => void
}) {
  const progress = progressLabel(item)
  return (
    <li>
      <Card variant="flat">
        <Card.Content className="space-y-2 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-[var(--text-primary)]">
                {KIND_ICON[item.kind]} {item.title}
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {[progress, item.detail, item.due && !item.overdue ? `due ${formatDayMonth(item.due)}` : null].filter(Boolean).join(' · ') ||
                  (item.userIds.length > 1 ? `${item.userIds.length} people` : '')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {item.overdue && (
                <Badge variant="error" size="sm">
                  Overdue
                </Badge>
              )}
              {item.kind === 'task' && onEdit && (
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  Edit
                </Button>
              )}
            </div>
          </div>
          <ul className="flex flex-wrap items-center gap-1.5">
            <li className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {item.unblocks != null && item.userIds.length > 1 ? anyOrganizerLabel(item.userIds.length) : 'Waiting on'}
            </li>
            {item.userIds.map((userId) => {
              const todo = todoFor(userId)
              const name = nameOf(userId)
              return (
                <li key={userId}>
                  {todo && canNudge(userId, todo) ? (
                    <button
                      type="button"
                      onClick={() => onNudge(userId, todo)}
                      title={`Nudge ${name} about this`}
                      className="cursor-pointer"
                    >
                      <Badge variant="neutral" size="sm">
                        👋 {name}
                      </Badge>
                    </button>
                  ) : (
                    <Badge variant="neutral" size="sm">
                      {name}
                    </Badge>
                  )}
                </li>
              )
            })}
          </ul>
        </Card.Content>
      </Card>
    </li>
  )
}
