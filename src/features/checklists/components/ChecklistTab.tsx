import { useMemo, useState } from 'react'
import { Button, Card, EmptyState, Input, LinkifiedText, Select, Skeleton, UserAvatar, useToast } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useChecklists, useCreateChecklistItem, useToggleChecklistItem, useDeleteChecklistItem } from '../../../lib/queries/useChecklists'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useFormDraft } from '../../../lib/forms/useFormDraft'

export interface ChecklistTabProps {
  tripId: string
  /** Lets the organizer mark/unmark on behalf of someone else's assigned item, de-emphasized vs. the assignee's own control. */
  isOrganizer?: boolean
  /** Empty-state title override — lets callers (e.g. ActionsSheet's Bring list segment) rephrase for their context. */
  emptyStateTitle?: string
  /** Empty-state description override, paired with emptyStateTitle. */
  emptyStateDescription?: string
}

interface AddItemFormValues {
  title: string
  assignee: string
}

const EMPTY_ADD_ITEM_VALUES: AddItemFormValues = { title: '', assignee: '' }

/**
 * Shared trip checklist (plan §6.4: "who's bringing the speaker") —
 * lightweight items with an optional assignee, optimistic check/uncheck,
 * and assignee avatars. Anyone on the trip can add items; an ASSIGNED
 * item's completion belongs to that assignee (an actionable "Mark as
 * packed" button for them, a passive "waiting on/packed by" status for
 * everyone else, with a de-emphasized organizer-override link). Unassigned
 * items keep the plain shared checkbox.
 */
export function ChecklistTab({
  tripId,
  isOrganizer = false,
  emptyStateTitle = 'Nothing on the list yet',
  emptyStateDescription = "Shared things the group needs — speaker, board games, first-aid kit — and who's bringing them.",
}: ChecklistTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: items, isLoading, isError, refetch, isRefetching } = useChecklists(tripId)
  const { data: participants } = useParticipants(tripId)
  const createItem = useCreateChecklistItem(tripId)
  const toggleItem = useToggleChecklistItem(tripId)
  const deleteItem = useDeleteChecklistItem(tripId)
  const logActivity = useTripActivityLog(tripId)

  // Add-item form draft (Form & Flow Standard §5.1) -- a half-typed
  // "bring the speaker" note shouldn't vanish if the tab backgrounds.
  // Create-only form (no edit mode), so persistence stays enabled by
  // default and is cleared on successful add.
  const { values: addItemValues, updateField: updateAddItemField, setValues: setAddItemValues, clearDraft: clearAddItemDraft } =
    useFormDraft<AddItemFormValues>(`checklist-add-item:${tripId}`, EMPTY_ADD_ITEM_VALUES)
  // Inline two-step delete confirm (ManageParticipantSheet.tsx's pattern,
  // scaled down to a per-row toggle since this is a list): first tap on ✕
  // arms the row, a second tap actually deletes. Only one row can be armed
  // at a time.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

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
    const trimmed = addItemValues.title.trim()
    if (!trimmed || !user) return
    try {
      await createItem.mutateAsync({
        title: trimmed,
        created_by: user.id,
        assigned_to: addItemValues.assignee || null,
      })
      logActivity({ verb: 'checklist_added', entity: { type: 'checklist_item', label: trimmed } })
      clearAddItemDraft()
      setAddItemValues(EMPTY_ADD_ITEM_VALUES)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add item', description: (err as Error).message })
    }
  }

  const handleToggle = (id: string, done: boolean, itemTitle: string) => {
    toggleItem.mutate(
      { id, done, doneBy: user?.id ?? null },
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
      setConfirmingDeleteId(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete item', description: (err as Error).message })
    }
  }

  if (isLoading) return <Skeleton variant="list" lines={5} />

  if (isError) {
    return (
      <EmptyState
        icon={<ErrorState className="w-20 h-20 text-danger-500" />}
        title="Couldn't load the checklist"
        description="Something went wrong fetching this trip's checklist. Check your connection and try again."
        action={
          <Button variant="primary" onClick={() => refetch()} isLoading={isRefetching}>
            Try again
          </Button>
        }
      />
    )
  }

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
                value={addItemValues.title}
                onChange={(e) => updateAddItemField('title', e.target.value)}
                placeholder="e.g. Bluetooth speaker, sunscreen, cards"
              />
            </div>
            <div className="sm:w-44">
              <Select
                label="Who's bringing it"
                value={addItemValues.assignee}
                onChange={(e) => updateAddItemField('assignee', e.target.value)}
                options={assigneeOptions}
              />
            </div>
            <Button type="submit" isLoading={createItem.isPending} disabled={!addItemValues.title.trim()}>
              Add
            </Button>
          </form>
        </Card.Content>
      </Card>

      {(items ?? []).length === 0 ? (
        <EmptyState icon="🎒" title={emptyStateTitle} description={emptyStateDescription} />
      ) : (
        <>
          <ul className="space-y-1.5">
            {[...open, ...done].map((item) => {
              const assigneeInfo = item.assigned_to ? usersById.get(item.assigned_to) : undefined
              const canDelete = item.created_by === user?.id
              const isAssigned = !!item.assigned_to
              const isAssignee = isAssigned && item.assigned_to === user?.id
              const canOverride = isAssigned && !isAssignee && isOrganizer
              return (
                <li
                  key={item.id}
                  className="group flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] px-3 py-2"
                >
                  {!isAssigned ? (
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={(e) => handleToggle(item.id, e.target.checked, item.title)}
                      className="h-5 w-5 shrink-0 accent-accent-600 cursor-pointer"
                      aria-label={`Mark "${item.title}" ${item.done ? 'not done' : 'done'}`}
                    />
                  ) : isAssignee ? (
                    <button
                      type="button"
                      onClick={() => handleToggle(item.id, !item.done, item.title)}
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                        item.done
                          ? 'bg-success-100 text-success-800 dark:bg-success-900 dark:text-success-300'
                          : 'bg-accent-600 text-white hover:bg-accent-700'
                      }`}
                    >
                      {item.done ? '✓ Packed' : 'Mark as packed'}
                    </button>
                  ) : (
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
                      aria-hidden="true"
                    >
                      {item.done ? '✓' : '○'}
                    </span>
                  )}
                  <LinkifiedText
                    text={item.title}
                    className={`min-w-0 flex-1 break-words text-sm ${
                      item.done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'
                    }`}
                  />
                  {isAssigned && !isAssignee && assigneeInfo && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <UserAvatar avatarData={assigneeInfo} size="xs" />
                      <span className="hidden sm:inline">
                        {item.done ? `${assigneeInfo.name} packed it` : `Waiting on ${assigneeInfo.name}`}
                      </span>
                    </span>
                  )}
                  {isAssigned && isAssignee && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <UserAvatar avatarData={assigneeInfo} size="xs" />
                      <span className="hidden text-xs text-[var(--text-muted)] sm:inline">You</span>
                    </span>
                  )}
                  {canOverride && (
                    <button
                      type="button"
                      onClick={() => handleToggle(item.id, !item.done, item.title)}
                      className="shrink-0 text-[10px] text-[var(--text-muted)] underline opacity-0 transition-opacity hover:text-[var(--text-secondary)] group-hover:opacity-100 focus:opacity-100"
                      title="Organizer override"
                    >
                      {item.done ? 'Unmark' : 'Mark for them'}
                    </button>
                  )}
                  {canDelete &&
                    (confirmingDeleteId === item.id ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs">
                        <button
                          type="button"
                          onClick={() => setConfirmingDeleteId(null)}
                          className="rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          disabled={deleteItem.isPending}
                          className="rounded px-1.5 py-0.5 font-medium text-danger-600 hover:text-danger-700 disabled:opacity-60"
                          aria-label={`Confirm delete "${item.title}"`}
                        >
                          {deleteItem.isPending ? 'Deleting…' : 'Delete?'}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDeleteId(item.id)}
                        className="shrink-0 rounded px-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-danger-600 group-hover:opacity-100 focus:opacity-100"
                        aria-label={`Delete "${item.title}"`}
                      >
                        ✕
                      </button>
                    ))}
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
