import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Input, Modal, Select, SegmentedControl, TextArea, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useActions, useCreateAction, useUpdateAction, useDeleteAction, useToggleActionDone, useSectionVoters } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { useSections } from '../../../lib/queries/usePlanning'
import { useChecklists } from '../../../lib/queries/useChecklists'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { ChecklistTab, openBringCountForUser } from '../../checklists'
import { ActionRow, ROW_ID_PREFIX } from './ActionRow'
import { TODOS_TITLE, NEW_TODO_LABEL, ADD_TODO_LABEL, WHO_EVERYONE, doneCountLabel } from '../lib/todoLabels'
import { countsTowardActions, isActionCompleteForUser, isGroupComplete, isOverdue, openActionCountForUser } from '../lib/actionStatus'
import type { SectionVoterIds } from '../lib/actionStatus'
import { getDecisionShape } from '../../decisions/lib/decisionShapes'
import type { TablesUpdate } from '../../../types/database.types'

export interface ActionsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  isOrganizer: boolean
  /** Segment to show on open — Today's packing nudge lands on 'bring' directly. */
  initialSegment?: 'actions' | 'bring'
  /** To-do (`trip_actions.id`) or bring item (`checklist_items.id`) to scroll to and briefly highlight on open. */
  highlightId?: string
}

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-accent-500']
const HIGHLIGHT_MS = 2200

type Segment = 'actions' | 'bring'

interface ActionFormValues {
  title: string
  notes: string
  assignee: string
  beforeTrip: boolean
  dueDate: string
  /** Linked open question (planning_sections.id), or '' for none — see actionStatus.ts's derived completion. */
  sectionId: string
}

const EMPTY_FORM: ActionFormValues = { title: '', notes: '', assignee: '', beforeTrip: false, dueDate: '', sectionId: '' }

/**
 * Launched "To-dos" sheet — trip actions/to-dos (book it, send it, sort
 * it) plus the packing/bring list, as two segments of one sheet (matches
 * QuickCaptureSheet/AddToPlanSheet chrome — a `Modal` — so z-index and
 * mobile/desktop framing are identical, no bespoke overlay classes).
 */
export function ActionsSheet({ isOpen, onClose, tripId, isOrganizer, initialSegment, highlightId }: ActionsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: trip } = useTrip(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: actions, isLoading } = useActions(tripId)
  const { data: bringItems } = useChecklists(tripId)
  const { data: sections } = useSections(tripId)
  const sectionVoters = useSectionVoters(tripId)
  const closedSectionIds = useMemo(() => new Set((sections ?? []).filter((s) => s.status === 'completed').map((s) => s.id)), [sections])
  const createAction = useCreateAction(tripId)
  const updateAction = useUpdateAction(tripId)
  const deleteAction = useDeleteAction(tripId)
  const toggleDone = useToggleActionDone(tripId)

  // The sheet is conditionally mounted by TripDetail ({actionsOpen && ...}),
  // so the initializer runs fresh on every open — no reset effect needed.
  const [segment, setSegment] = useState<Segment>(initialSegment ?? 'actions')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const { values, updateField, setValues, clearDraft } = useFormDraft<ActionFormValues>(`actions-add:${tripId}`, EMPTY_FORM)

  const assigneeOptions = useMemo(
    () => [
      { value: '', label: WHO_EVERYONE },
      ...(participants ?? [])
        .filter((p) => p.active !== false)
        .map((p) => ({ value: p.user_id, label: p.user?.full_name || p.user?.email || 'Unknown' })),
    ],
    [participants]
  )

  // Open, non-personal (group-vote) decision sections a new/edited action
  // can link to — "personal order" sections (getDecisionShape) have no
  // single group vote to derive completion from, and a closed section has
  // nothing left to vote on.
  const sectionOptions = useMemo(
    () => [
      { value: '', label: 'None' },
      ...(sections ?? [])
        .filter((s) => s.status !== 'completed' && getDecisionShape(s.metadata) !== 'personal')
        .map((s) => ({ value: s.id, label: s.title })),
    ],
    [sections]
  )

  const sorted = useMemo(() => {
    const list = [...(actions || [])]
    const openList = list.filter((a) => !isActionFullyDone(a, trip, participants ?? [], sectionVoters))
    const doneList = list.filter((a) => isActionFullyDone(a, trip, participants ?? [], sectionVoters))
    const byUrgency = (a: ActionWithCompletions, b: ActionWithCompletions) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    }
    openList.sort(byUrgency)
    return { openList, doneList }
  }, [actions, trip, participants, sectionVoters])

  // `?open=todo:<id>` / `bring:<id>`: once the rows exist, scroll to the row
  // and flash a ring on it (a done to-do is tucked under "Show done", so
  // expand that first).
  const highlightedIsDone = !!highlightId && sorted.doneList.some((a) => a.id === highlightId)
  useEffect(() => {
    if (highlightedIsDone) setShowDone(true)
  }, [highlightedIsDone])
  const dataReady = !isLoading && !!bringItems
  useEffect(() => {
    if (!highlightId || !dataReady) return
    const prefix = segment === 'bring' ? 'bring-row-' : ROW_ID_PREFIX
    let off: ReturnType<typeof setTimeout> | undefined
    let el: HTMLElement | null = null
    const on = setTimeout(() => {
      el = document.getElementById(`${prefix}${highlightId}`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add(...HIGHLIGHT_CLASSES)
      off = setTimeout(() => el?.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS)
    }, 150)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
      el?.classList.remove(...HIGHLIGHT_CLASSES)
    }
    // Re-run only when the target or the visible segment/data readiness changes.
  }, [highlightId, segment, dataReady, showDone])

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
      sectionId: action.section_id || '',
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
    if (!values.beforeTrip && !values.dueDate) {
      showToast({ type: 'error', message: 'Please choose a deadline' })
      return
    }
    const payload: TablesUpdate<'trip_actions'> = {
      title: trimmed,
      notes: values.notes.trim() || null,
      assigned_to: values.assignee || null,
      deadline_kind: values.beforeTrip ? 'before_trip' : 'fixed',
      due_date: values.beforeTrip ? null : values.dueDate || null,
      section_id: values.sectionId || null,
    }
    try {
      if (editingId) {
        await updateAction.mutateAsync({ id: editingId, update: payload })
      } else {
        await createAction.mutateAsync({
          title: trimmed,
          notes: values.notes.trim() || null,
          assigned_to: values.assignee || null,
          deadline_kind: values.beforeTrip ? 'before_trip' : 'fixed',
          due_date: values.beforeTrip ? null : values.dueDate || null,
          section_id: values.sectionId || null,
          created_by: user.id,
        })
      }
      clearDraft()
      setValues(EMPTY_FORM)
      setFormOpen(false)
      setEditingId(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save this to-do', description: (err as Error).message })
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAction.mutateAsync(id)
      setConfirmingDeleteId(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete this to-do', description: (err as Error).message })
    }
  }

  const handleToggle = (action: ActionWithCompletions, done: boolean) => {
    if (!user) return
    toggleDone.mutate(
      { actionId: action.id, isGroupAction: !action.assigned_to, userId: user.id, done },
      { onError: (err) => showToast({ type: 'error', message: 'Could not update this to-do', description: (err as Error).message }) }
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title={TODOS_TITLE}>
      <div className="space-y-4">
        <SegmentedControl
          fullWidth
          value={segment}
          onChange={(v) => setSegment(v as Segment)}
          options={[
            // Badges: open items relevant to the CURRENT user (their own /
            // whole-group actions; unclaimed or their unpacked bring items).
            { value: 'actions', label: TODOS_TITLE, badge: openActionCountForUser(actions, user?.id, sectionVoters) },
            { value: 'bring', label: '🎒 Bring', badge: openBringCountForUser(bringItems, user?.id) },
          ]}
        />

        {segment === 'actions' ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" onClick={openForCreate}>
                + {NEW_TODO_LABEL}
              </Button>
            </div>

            {isLoading ? (
              <p className="text-sm text-[var(--text-muted)]">Loading…</p>
            ) : sorted.openList.length === 0 && sorted.doneList.length === 0 ? (
              <EmptyState
                icon="✅"
                title="No to-dos."
                description="Add one for the group — like 'Book the transfer' or 'Bring a speaker'."
                action={
                  <Button variant="primary" onClick={openForCreate}>
                    + {NEW_TODO_LABEL}
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
                      sectionVoters={sectionVoters}
                      linkedSectionClosed={!!action.section_id && closedSectionIds.has(action.section_id)}
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
                      {showDone ? 'Hide' : 'Show'} {doneCountLabel(sorted.doneList.length, sorted.openList.length + sorted.doneList.length)}
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
                            sectionVoters={sectionVoters}
                            linkedSectionClosed={!!action.section_id && closedSectionIds.has(action.section_id)}
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
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Things to bring</h3>
            <ChecklistTab
              tripId={tripId}
              isOrganizer={isOrganizer}
              emptyStateTitle="Nothing to bring yet."
              emptyStateDescription="Who's bringing what — no deadlines, just don't forget the speaker."
            />
          </div>
        )}
      </div>

      <Modal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        size="sm"
        title={editingId ? 'Edit to-do' : NEW_TODO_LABEL}
      >
        <div className="space-y-4">
          <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} placeholder="e.g. Book the villa" required autoFocus />
          <TextArea label="Notes (optional)" value={values.notes} onChange={(e) => updateField('notes', e.target.value)} rows={2} />
          <Select
            label="Who"
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
          {(values.beforeTrip || values.dueDate) && (
            <p className="text-xs text-[var(--text-muted)]">
              Giving this a deadline means whoever it's assigned to (or everyone, if it's for Everyone) gets reminder
              emails — 7 days before, 1 day before, and once overdue. The organizer can turn this off for the whole
              trip in Auto-chase settings.
            </p>
          )}
          <Select
            label="Linked open question (optional)"
            value={values.sectionId}
            onChange={(e) => updateField('sectionId', e.target.value)}
            options={sectionOptions}
            helperText="Ticks off automatically once someone answers — no need to also tick it by hand."
          />

          <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={createAction.isPending || updateAction.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={createAction.isPending || updateAction.isPending}>
              {editingId ? 'Save' : ADD_TODO_LABEL}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}

/**
 * Whether an action is "done" for sorting purposes: individual → complete
 * for the assignee (manual tick OR a vote in the linked section); group →
 * every active participant complete the same way. Delegates to the shared
 * actionStatus predicates so this stays in lockstep with ActionRow's own
 * done state.
 */
function isActionFullyDone(
  action: ActionWithCompletions,
  trip: { start_date?: string | null } | null | undefined,
  participants: { user_id: string; active?: boolean | null; confirmation_status?: string | null }[],
  sectionVoters: SectionVoterIds
): boolean {
  void trip
  if (action.assigned_to) return isActionCompleteForUser(action, action.assigned_to, sectionVoters)
  const activeIds = participants.filter(countsTowardActions).map((p) => p.user_id)
  return isGroupComplete(action, activeIds, sectionVoters)
}
