import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Modal, Skeleton, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import {
  useActions,
  useClaimAction,
  useCreateAction,
  useDeleteAction,
  useTodoWhoSupport,
  useToggleActionDone,
  useUpdateAction,
} from '../../../lib/queries/useActions'
import { useSections } from '../../../lib/queries/usePlanning'
import {
  shouldLogChecklistCompletion,
  useChecklists,
  useClaimChecklistItem,
  useCreateChecklistItem,
  useDeleteChecklistItem,
  useToggleChecklistItem,
  useUpdateChecklistItem,
} from '../../../lib/queries/useChecklists'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useTodoGroups } from '../lib/useTodoGroups'
import { TodoRow } from './TodoRow'
import { TodoFormModal } from './TodoFormModal'
import {
  NEW_TODO_LABEL,
  SECTION_DONE,
  SECTION_EVERYONE,
  GRABS_HINT,
  SECTION_GRABS,
  SECTION_LEFT_OPEN,
  SECTION_OTHERS,
  SECTION_YOURS,
  YOURS_EMPTY,
  TODOS_EMPTY_BODY,
  TODOS_EMPTY_TITLE,
  TODOS_FINISHED_NOTE,
  TODOS_TITLE,
} from '../lib/todoLabels'
import {
  EMPTY_TODO_FORM,
  buildActionColumns,
  buildChecklistColumns,
  canCreate,
  formValuesFor,
  validateTodoForm,
} from '../lib/todoModel'
import type { TodoFormValues, TodoView, Viewer } from '../lib/todoModel'

export interface ActionsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  isOrganizer: boolean
  /**
   * Legacy hint from the two-segment sheet. 'bring' now scrolls to "Up for grabs"
   * (where unclaimed bring items live) when there is no `highlightId`.
   */
  initialSegment?: 'actions' | 'bring'
  /** To-do (`trip_actions.id`) or bring item (`trip_checklists.id`) to scroll to and briefly highlight on open. */
  highlightId?: string
}

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-accent-500']
const HIGHLIGHT_MS = 2200
const GRABS_SECTION_ID = 'todo-section-grabs'

/**
 * The To-dos sheet (UX redesign 2.3): trip actions and the bring list as ONE
 * list, grouped by whose job it is.
 *
 *   Yours       assigned or claimed by you, or Everyone and you haven't ticked yours
 *   Everyone    group to-dos you've done (or aren't part of): "x of y done", who's left
 *   With others named or claimed by someone else
 *   Up for grabs  "Anyone" to-dos nobody has claimed yet (incl. bring items)
 *   Done        collapsed
 *
 * Finished trips show the same items read-only as history.
 */
export function ActionsSheet({ isOpen, onClose, tripId, isOrganizer, initialSegment, highlightId }: ActionsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: participants } = useParticipants(tripId)
  const actionsQuery = useActions(tripId)
  const checklistsQuery = useChecklists(tripId)
  const { data: sections } = useSections(tripId)
  const whoSupported = useTodoWhoSupport()
  const logActivity = useTripActivityLog(tripId)

  const createAction = useCreateAction(tripId)
  const updateAction = useUpdateAction(tripId)
  const deleteAction = useDeleteAction(tripId)
  const toggleAction = useToggleActionDone(tripId)
  const claimAction = useClaimAction(tripId)
  const createItem = useCreateChecklistItem(tripId)
  const updateItem = useUpdateChecklistItem(tripId)
  const deleteItem = useDeleteChecklistItem(tripId)
  const toggleItem = useToggleChecklistItem(tripId)
  const claimItem = useClaimChecklistItem(tripId)

  const actions = actionsQuery.data
  const isLoading = actionsQuery.isLoading || checklistsQuery.isLoading
  const isError = actionsQuery.isError || checklistsQuery.isError

  // The sheet is conditionally mounted by its caller, so these initialisers run fresh on every open.
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<TodoView | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set())

  const { values, updateField, setValues, clearDraft } = useFormDraft<TodoFormValues>(`todos-add:${tripId}`, EMPTY_TODO_FORM)

  const { views, groups, finished, isParticipant } = useTodoGroups(tripId)
  const viewer: Viewer = { userId: user?.id, isOrganizer, isParticipant, finished, whoSupported }

  // Questions a to-do can be linked to: any open one, plus the one this to-do is already linked to.
  const sectionChoices = useMemo(() => {
    const linked = editing?.sectionId
    return (sections ?? []).filter((s) => s.status !== 'completed' || s.id === linked).map((s) => ({ id: s.id, title: s.title }))
  }, [sections, editing])

  // `?open=todo:<id>` / `bring:<id>`: expand "Done" if the target is there, then scroll to the row and flash a ring.
  const highlightedIsDone = !!highlightId && groups.done.some((v) => v.id === highlightId)
  useEffect(() => {
    if (highlightedIsDone) setShowDone(true)
  }, [highlightedIsDone])
  const dataReady = !isLoading && !isError
  useEffect(() => {
    if (!dataReady) return
    let off: ReturnType<typeof setTimeout> | undefined
    let el: HTMLElement | null = null
    const on = setTimeout(() => {
      if (highlightId) {
        el = document.getElementById(`todo-row-${highlightId}`) ?? document.getElementById(`bring-row-${highlightId}`)
        if (!el) return
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add(...HIGHLIGHT_CLASSES)
        off = setTimeout(() => el?.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS)
      } else if (initialSegment === 'bring') {
        document.getElementById(GRABS_SECTION_ID)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
    }, 150)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
      el?.classList.remove(...HIGHLIGHT_CLASSES)
    }
    // Re-run only when the target or data readiness changes (and when a done target is revealed).
  }, [highlightId, initialSegment, dataReady, showDone])

  const withBusy = async (key: string, fn: () => Promise<unknown>, errorMessage: string) => {
    setBusyKeys((prev) => new Set(prev).add(key))
    try {
      await fn()
    } catch (err) {
      showToast({ type: 'error', message: errorMessage, description: (err as Error).message })
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const openForCreate = () => {
    setEditing(null)
    setValues(EMPTY_TODO_FORM)
    setFormOpen(true)
  }

  const openForEdit = (view: TodoView) => {
    const row = view.source === 'action' ? (actions ?? []).find((a) => a.id === view.id) : undefined
    setEditing(view)
    setValues(formValuesFor(view, row ?? {}))
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const handleSave = async () => {
    if (!user) return
    const problem = validateTodoForm(values, { whoSupported, editingSource: editing?.source })
    if (problem) {
      showToast({ type: 'error', message: problem })
      return
    }
    const bring = editing ? editing.source === 'checklist' : values.bring
    try {
      if (bring) {
        const cols = buildChecklistColumns(values)
        if (editing) await updateItem.mutateAsync({ id: editing.id, update: cols })
        else {
          await createItem.mutateAsync({ ...cols, created_by: user.id })
          logActivity({ verb: 'checklist_added', entity: { type: 'checklist_item', label: cols.title } })
        }
      } else if (editing) {
        const existing = (actions ?? []).find((a) => a.id === editing.id)
        await updateAction.mutateAsync({ id: editing.id, update: buildActionColumns(values, existing) })
      } else {
        await createAction.mutateAsync({ ...buildActionColumns(values), created_by: user.id })
      }
      clearDraft()
      setValues(EMPTY_TODO_FORM)
      closeForm()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save this to-do', description: (err as Error).message })
    }
  }

  const handleDelete = (view: TodoView) => {
    if (confirmingDeleteKey !== view.key) {
      setConfirmingDeleteKey(view.key)
      return
    }
    void withBusy(
      view.key,
      async () => {
        await (view.source === 'action' ? deleteAction.mutateAsync(view.id) : deleteItem.mutateAsync(view.id))
        setConfirmingDeleteKey(null)
      },
      'Could not delete this to-do'
    )
  }

  const handleTick = (view: TodoView, done: boolean) => {
    if (!user) return
    const onError = (err: unknown) => showToast({ type: 'error', message: 'Could not update this to-do', description: (err as Error).message })
    if (view.source === 'action') {
      toggleAction.mutate(
        { actionId: view.id, isGroupAction: view.mode === 'everyone', userId: user.id, done, anyone: view.mode === 'anyone' },
        { onError, onSuccess: () => done && showToast({ type: 'success', message: 'To-do done ✓' }) }
      )
      return
    }
    toggleItem.mutate(
      { id: view.id, done, doneBy: user.id },
      {
        onError,
        onSuccess: () => {
          if (!done) return
          showToast({ type: 'success', message: 'To-do done ✓' })
          if (shouldLogChecklistCompletion(tripId, view.id, Date.now())) {
            logActivity({ verb: 'checklist_completed', entity: { type: 'checklist_item', id: view.id, label: view.title } })
          }
        },
      }
    )
  }

  const handleClaim = (view: TodoView, claim: boolean) => {
    if (!user) return
    void withBusy(
      view.key,
      () =>
        view.source === 'action'
          ? claimAction.mutateAsync({ id: view.id, userId: user.id, claim })
          : claimItem.mutateAsync({ id: view.id, userId: user.id, claim }),
      claim ? "Could not take this one" : 'Could not give this one back'
    )
  }

  const renderRows = (list: TodoView[]) => (
    <ul className="space-y-2">
      {list.map((view) => (
        <TodoRow
          key={view.key}
          view={view}
          participants={participants ?? []}
          viewer={viewer}
          busy={busyKeys.has(view.key)}
          confirmingDelete={confirmingDeleteKey === view.key}
          onTick={(done) => handleTick(view, done)}
          onClaim={() => handleClaim(view, true)}
          onUnclaim={() => handleClaim(view, false)}
          onEdit={() => openForEdit(view)}
          onDelete={() => handleDelete(view)}
          onCancelDelete={() => setConfirmingDeleteKey(null)}
        />
      ))}
    </ul>
  )

  const section = (id: string, title: string, list: TodoView[], hint?: string) =>
    list.length === 0 ? null : (
      <section id={id} aria-label={title} className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {title} <span className="font-normal text-[var(--text-muted)]">· {list.length}</span>
        </h3>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
        {renderRows(list)}
      </section>
    )

  const mayCreate = canCreate(viewer)
  const isEmpty = views.length === 0

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title={TODOS_TITLE}>
      <div className="space-y-5">
        {finished && <p className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text-secondary)]">{TODOS_FINISHED_NOTE}</p>}

        {mayCreate && !isEmpty && (
          <div className="flex justify-end">
            <Button size="sm" onClick={openForCreate}>
              + {NEW_TODO_LABEL}
            </Button>
          </div>
        )}

        {isLoading ? (
          <Skeleton variant="list" lines={4} />
        ) : isError ? (
          <EmptyState
            title="Couldn't load the to-dos"
            description="Something went wrong fetching this trip's to-dos. Check your connection and try again."
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void actionsQuery.refetch()
                  void checklistsQuery.refetch()
                }}
              >
                Try again
              </Button>
            }
          />
        ) : isEmpty ? (
          <EmptyState
            icon="✅"
            title={TODOS_EMPTY_TITLE}
            description={TODOS_EMPTY_BODY}
            action={
              mayCreate ? (
                <Button variant="primary" onClick={openForCreate}>
                  + {NEW_TODO_LABEL}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {!finished && groups.yours.length === 0 && (
              <section aria-label={SECTION_YOURS} className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{SECTION_YOURS}</h3>
                <p className="text-xs text-[var(--text-muted)]">{YOURS_EMPTY}</p>
              </section>
            )}
            {section('todo-section-yours', SECTION_YOURS, groups.yours)}
            {section('todo-section-everyone', SECTION_EVERYONE, groups.everyone)}
            {section('todo-section-others', SECTION_OTHERS, groups.others)}
            {section(GRABS_SECTION_ID, SECTION_GRABS, groups.upForGrabs, GRABS_HINT)}
            {section('todo-section-left-open', SECTION_LEFT_OPEN, groups.leftOpen)}

            {groups.done.length > 0 && (
              <section id="todo-section-done" aria-label={SECTION_DONE}>
                <button
                  type="button"
                  onClick={() => setShowDone((v) => !v)}
                  aria-expanded={showDone}
                  className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {SECTION_DONE} <span className="font-normal text-[var(--text-muted)]">· {groups.done.length}</span> {showDone ? '▾' : '▸'}
                </button>
                {showDone && <div className="mt-2">{renderRows(groups.done)}</div>}
              </section>
            )}
          </>
        )}
      </div>

      <TodoFormModal
        isOpen={formOpen}
        onClose={closeForm}
        editingSource={editing ? editing.source : null}
        values={values}
        updateField={updateField}
        setValues={setValues}
        participants={participants ?? []}
        sections={sectionChoices}
        whoSupported={whoSupported}
        isPending={createAction.isPending || updateAction.isPending || createItem.isPending || updateItem.isPending}
        onSubmit={handleSave}
      />
    </Modal>
  )
}
