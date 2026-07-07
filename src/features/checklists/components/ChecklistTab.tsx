import { useMemo, useState } from 'react'
import { Button, Card, EmptyState, Input, Select, Skeleton, UserAvatar, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useChecklists, useCreateChecklistItem, useToggleChecklistItem, useDeleteChecklistItem } from '../../../lib/queries/useChecklists'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'

export interface ChecklistTabProps {
  tripId: string
}

/**
 * Shared trip checklist (plan §6.4: "who's bringing the speaker") —
 * lightweight items with an optional assignee, optimistic check/uncheck,
 * and assignee avatars. Anyone on the trip can add and tick items.
 */
export function ChecklistTab({ tripId }: ChecklistTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: items, isLoading } = useChecklists(tripId)
  const { data: participants } = useParticipants(tripId)
  const createItem = useCreateChecklistItem(tripId)
  const toggleItem = useToggleChecklistItem(tripId)
  const deleteItem = useDeleteChecklistItem(tripId)
  const logActivity = useTripActivityLog(tripId)

  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')

  const usersById = useMemo(() => {
    const map = new Map<string, { name: string; avatar_url: unknown; avatar_data: unknown }>()
    for (const p of participants ?? []) {
      map.set(p.user_id, {
        name: (p.user?.full_name || p.user?.email || 'Someone').split(' ')[0],
        avatar_url: p.user?.avatar_url ?? null,
        avatar_data: p.user?.avatar_data ?? null,
      })
    }
    return map
  }, [participants])

  const assigneeOptions = useMemo(
    () => [
      { value: '', label: 'Anyone' },
      ...(participants ?? [])
        .filter((p) => p.active !== false)
        .map((p) => ({ value: p.user_id, label: p.user?.full_name || p.user?.email || 'Unknown' })),
    ],
    [participants]
  )

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || !user) return
    try {
      await createItem.mutateAsync({
        title: trimmed,
        created_by: user.id,
        assigned_to: assignee || null,
      })
      logActivity({ verb: 'checklist_added', entity: { type: 'checklist_item', label: trimmed } })
      setTitle('')
      setAssignee('')
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add item', description: (err as Error).message })
    }
  }

  const handleToggle = (id: string, done: boolean, itemTitle: string) => {
    toggleItem.mutate(
      { id, done },
      {
        onError: (err) => showToast({ type: 'error', message: 'Could not update item', description: (err as Error).message }),
        onSuccess: () => {
          if (done) logActivity({ verb: 'checklist_completed', entity: { type: 'checklist_item', id, label: itemTitle } })
        },
      }
    )
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteItem.mutateAsync(id)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete item', description: (err as Error).message })
    }
  }

  if (isLoading) return <Skeleton variant="list" lines={5} />

  const open = (items ?? []).filter((i) => !i.done)
  const done = (items ?? []).filter((i) => i.done)

  return (
    <div className="space-y-4">
      <Card variant="flat">
        <Card.Content>
          <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Add to the list"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Bluetooth speaker, sunscreen, cards"
              />
            </div>
            <div className="sm:w-44">
              <Select label="Who's bringing it" value={assignee} onChange={(e) => setAssignee(e.target.value)} options={assigneeOptions} />
            </div>
            <Button type="submit" isLoading={createItem.isPending} disabled={!title.trim()}>
              Add
            </Button>
          </form>
        </Card.Content>
      </Card>

      {(items ?? []).length === 0 ? (
        <EmptyState
          icon="🎒"
          title="Nothing on the list yet"
          description="Shared things the group needs — speaker, board games, first-aid kit — and who's bringing them."
        />
      ) : (
        <>
          <ul className="space-y-1.5">
            {[...open, ...done].map((item) => {
              const assigneeInfo = item.assigned_to ? usersById.get(item.assigned_to) : undefined
              const canDelete = item.created_by === user?.id
              return (
                <li
                  key={item.id}
                  className="group flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(e) => handleToggle(item.id, e.target.checked, item.title)}
                    className="h-5 w-5 shrink-0 accent-accent-600 cursor-pointer"
                    aria-label={`Mark "${item.title}" ${item.done ? 'not done' : 'done'}`}
                  />
                  <span
                    className={`min-w-0 flex-1 text-sm ${
                      item.done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {item.title}
                  </span>
                  {assigneeInfo && (
                    <span className="flex shrink-0 items-center gap-1.5" title={`${assigneeInfo.name} is bringing this`}>
                      <UserAvatar avatarData={assigneeInfo} size="xs" />
                      <span className="hidden text-xs text-[var(--text-muted)] sm:inline">{assigneeInfo.name}</span>
                    </span>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="shrink-0 rounded px-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-danger-600 group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Delete "${item.title}"`}
                    >
                      ✕
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          {done.length > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              {done.length} of {(items ?? []).length} sorted
            </p>
          )}
        </>
      )}
    </div>
  )
}
