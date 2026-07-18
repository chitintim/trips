import { useMemo, useState } from 'react'
import { Button, EmptyState, Input, Modal, Select, SegmentedControl, TextArea, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useActions, useCreateAction, useUpdateAction, useDeleteAction, useToggleActionDone } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { ChecklistTab } from '../../checklists'
import { ActionRow } from './ActionRow'
import { isOverdue } from '../lib/actionStatus'
import type { TablesUpdate } from '../../../types/database.types'

export interface ActionsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  isOrganizer: boolean
}

type Segment = 'actions' | 'bring'

interface ActionFormValues {
  title: string
  notes: string
  assignee: string
  beforeTrip: boolean
  dueDate: string
}

const EMPTY_FORM: ActionFormValues = { title: '', notes: '', assignee: '', beforeTrip: false, dueDate: '' }

/**
 * Launched "Actions" sheet — trip actions/to-dos (book it, send it, sort
 * it) plus the packing/bring list, as two segments of one sheet (matches
 * QuickCaptureSheet/AddToPlanSheet chrome — a `Modal` — so z-index and
 * mobile/desktop framing are identical, no bespoke overlay classes).
 */
export function ActionsSheet({ isOpen, onClose, tripId, isOrganizer }: ActionsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: trip } = useTrip(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: actions, isLoading } = useActions(tripId)
  const createAction = useCreateAction(tripId)
  const updateAction = useUpdateAction(tripId)
  const deleteAction = useDeleteAction(tripId)
  const toggleDone = useToggleActionDone(tripId)

  const [segment, setSegment] = useState<Segment>('actions')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const { values, updateField, setValues, clearDraft } = useFormDraft<ActionFormValues>(`actions-add:${tripId}`, EMPTY_FORM)

  const assigneeOptions = useMemo(
    () => [
      { value: '', label: 'Whole group' },
      ...(participants ?? [])
        .filter((p) => p.active !== false)
        .map((p) => ({ value: p.user_id, label: p.user?.full_name || p.user?.email || 'Unknown' })),
    ],
    [participants]
  )

  const sorted = useMemo(() => {
    const list = [...(actions || [])]
    const openList = list.filter((a) => !isActionFullyDone(a, trip, participants ?? []))
    const doneList = list.filter((a) => isActionFullyDone(a, trip, participants ?? []))
    const byUrgency = (a: ActionWithCompletions, b: ActionWithCompletions) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    }
    openList.sort(byUrgency)
    return { openList, doneList }
  }, [actions, trip, participants])

  const openForCreate = () => {
    setEditingId(null)
    setValues(EMPTY_FORM)
    setFormOpen(true)
  }

  const openForEdit = (action: ActionWithCompletions) => {
    setEditingId(action.id)
    setValues({
      title: action.title,
      notes: action.notes || '',
      assignee: action.assigned_to || '',
      beforeTrip: action.deadline_kind === 'before_trip',
      dueDate: action.due_date || '',
    })
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!user) return
    const trimmed = values.title.trim()
    if (!trimmed) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }
    const payload: TablesUpdate<'trip_actions'> = {
      title: trimmed,
      notes: values.notes.trim() || null,
      assigned_to: values.assignee || null,
      deadline_kind: values.beforeTrip ? 'before_trip' : 'fixed_date',
      due_date: values.beforeTrip ? null : values.dueDate || null,
    }
    try {
      if (editingId) {
        await updateAction.mutateAsync({ id: editingId, update: payload })
      } else {
        await createAction.mutateAsync({
          title: trimmed,
          notes: values.notes.trim() || null,
          assigned_to: values.assignee || null,
          deadline_kind: values.beforeTrip ? 'before_trip' : 'fixed_date',
          due_date: values.beforeTrip ? null : values.dueDate || null,
          created_by: user.id,
        })
      }
      clearDraft()
      setValues(EMPTY_FORM)
      setFormOpen(false)
      setEditingId(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save this action', description: (err as Error).message })
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAction.mutateAsync(id)
      setConfirmingDeleteId(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete this action', description: (err as Error).message })
    }
  }

  const handleToggle = (action: ActionWithCompletions, done: boolean) => {
    if (!user) return
    toggleDone.mutate(
      { actionId: action.id, isGroupAction: !action.assigned_to, userId: user.id, done },
      { onError: (err) => showToast({ type: 'error', message: 'Could not update this action', description: (err as Error).message }) }
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title="Actions">
      <div className="space-y-4">
        <SegmentedControl
          fullWidth
          value={segment}
          onChange={(v) => setSegment(v as Segment)}
          options={[
            { value: 'actions', label: 'Actions' },
            { value: 'bring', label: 'Bring list' },
          ]}
        />

        {segment === 'actions' ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" onClick={openForCreate}>
                + New action
              </Button>
            </div>

            {isLoading ? (
              <p className="text-sm text-[var(--text-muted)]">Loading…</p>
            ) : sorted.openList.length === 0 && sorted.doneList.length === 0 ? (
              <EmptyState
                icon="✅"
                title="No actions yet"
                description="Tasks with an owner and a deadline — book it, send it, sort it."
                action={
                  <Button variant="primary" onClick={openForCreate}>
                    + New action
                  </Button>
                }
              />
            ) : (
              <>
                <ul className="space-y-2">
                  {sorted.openList.map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      trip={trip}
                      participants={participants ?? []}
                      currentUserId={user?.id}
                      isOrganizer={isOrganizer}
                      onToggle={(done) => handleToggle(action, done)}
                      onEdit={() => openForEdit(action)}
                      onDelete={() =>
                        confirmingDeleteId === action.id ? handleDelete(action.id) : setConfirmingDeleteId(action.id)
                      }
                    />
                  ))}
                </ul>

                {sorted.doneList.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowDone((v) => !v)}
                      className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    >
                      {showDone ? 'Hide' : 'Show'} {sorted.doneList.length} done
                    </button>
                    {showDone && (
                      <ul className="mt-2 space-y-2">
                        {sorted.doneList.map((action) => (
                          <ActionRow
                            key={action.id}
                            action={action}
                            trip={trip}
                            participants={participants ?? []}
                            currentUserId={user?.id}
                            isOrganizer={isOrganizer}
                            onToggle={(done) => handleToggle(action, done)}
                            onEdit={() => openForEdit(action)}
                            onDelete={() =>
                              confirmingDeleteId === action.id ? handleDelete(action.id) : setConfirmingDeleteId(action.id)
                            }
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Packing & bring list</h3>
            <ChecklistTab
              tripId={tripId}
              isOrganizer={isOrganizer}
              emptyStateTitle="Nothing on the list yet"
              emptyStateDescription="Who's bringing what — no deadlines, just don't forget the speaker."
            />
          </div>
        )}
      </div>

      <Modal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        size="sm"
        title={editingId ? 'Edit action' : 'New action'}
      >
        <div className="space-y-4">
          <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} placeholder="e.g. Book the villa" required autoFocus />
          <TextArea label="Notes (optional)" value={values.notes} onChange={(e) => updateField('notes', e.target.value)} rows={2} />
          <Select
            label="Assignee"
            value={values.assignee}
            onChange={(e) => updateField('assignee', e.target.value)}
            options={assigneeOptions}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={values.beforeTrip}
              onChange={(e) => updateField('beforeTrip', e.target.checked)}
              className="h-5 w-5 accent-accent-600"
            />
            <span className="text-sm text-[var(--text-primary)]">Due before the trip starts</span>
          </label>
          {!values.beforeTrip && (
            <Input label="Deadline" type="date" value={values.dueDate} onChange={(e) => updateField('dueDate', e.target.value)} />
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={createAction.isPending || updateAction.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={createAction.isPending || updateAction.isPending}>
              {editingId ? 'Save' : 'Add action'}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}

/** Whether an action is "done" for sorting purposes: individual → completed_at set; group → every active participant confirmed. */
function isActionFullyDone(
  action: ActionWithCompletions,
  trip: { start_date?: string | null } | null | undefined,
  participants: { user_id: string; active?: boolean | null }[]
): boolean {
  void trip
  if (action.assigned_to) return action.completed_at != null
  const activeIds = participants.filter((p) => p.active !== false).map((p) => p.user_id)
  const completedIds = new Set((action.trip_action_completions || []).map((c) => c.user_id))
  return activeIds.length > 0 && activeIds.every((id) => completedIds.has(id))
}
