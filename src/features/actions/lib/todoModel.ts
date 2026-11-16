/**
 * To-dos model (UX redesign 2.3 / 3.2, slice 2E): one view of the two tables.
 *
 * Pure: no React, no Supabase. The To-dos sheet renders `groupTodos(...)` and
 * asks the `can*` predicates before showing any control, so the UI never offers
 * something the row-level-security policies would reject.
 *
 * Who modes and where they live (existing rows keep their CURRENT meaning):
 *
 *   mode      trip_actions                                  trip_checklists
 *   --------  --------------------------------------------  -----------------------------------
 *   Everyone  assigned_to NULL (completion row per person)  not representable -> use trip_actions
 *   a person  assigned_to = user                            assigned_to = user
 *   Anyone    who_mode = 'anyone' (assigned_to NULL until   assigned_to NULL (as today); claiming
 *             claimed; claiming sets assigned_to)           sets assigned_to
 *
 * `who_mode` is the additive column from 20261117100000_todo_who_mode.sql. It is
 * absent before that is applied, and `undefined`/NULL always reads as the
 * historical meaning (no assignee = Everyone).
 */
import { daysUntil } from '../../../lib/dates'
import { checklistAssigneeFor, checklistWhoMode } from '../../checklists/lib/checklistWho'
import { countsTowardActions, groupCompletedUserIds, isActionCompleteForUser, isOverdue, resolveDueDate } from './actionStatus'
import type { ActionWithCompletions, SectionVoterIds, TripForActionStatus } from './actionStatus'
import type { WhoMode } from './todoLabels'

export type TodoSource = 'action' | 'checklist'

/** The `who_mode` value that marks an up-for-grabs `trip_actions` row. Everything else is derived from `assigned_to`. */
export const ANYONE_MODE_VALUE = 'anyone'

export interface ChecklistRow {
  id: string
  title: string
  assigned_to: string | null
  created_by: string
  done: boolean
  done_at?: string | null
  done_by?: string | null
}

export interface TodoParticipant {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
}

// ---------------------------------------------------------------------------
// Mapping: a stored row -> its Who mode
// ---------------------------------------------------------------------------

/** Who mode of a `trip_actions` row. */
export function actionWhoMode(action: { assigned_to: string | null; who_mode?: string | null }): WhoMode {
  if (action.who_mode === ANYONE_MODE_VALUE) return 'anyone'
  return action.assigned_to ? 'person' : 'everyone'
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface TodoView {
  /** `${source}:${id}`, unique across both tables. */
  key: string
  source: TodoSource
  id: string
  title: string
  notes: string | null
  mode: WhoMode
  /** The named person, or whoever claimed an Anyone to-do. null for Everyone and unclaimed. */
  assigneeId: string | null
  /** Anyone-mode and someone has claimed it. */
  claimed: boolean
  /** Something to bring (a `trip_checklists` row): only changes the wording ("I'll bring it"). */
  isBring: boolean
  createdBy: string
  /** Resolved due date (YYYY-MM-DD), or null (checklist items never have one). */
  due: string | null
  /** 'before_trip' for "due before the trip starts". */
  deadlineKind: string
  overdue: boolean
  sectionId: string | null
  /** The linked question is closed: nobody needs to do this any more. */
  noLongerNeeded: boolean
  /** Finished for what it asks (see `isFinished`). */
  done: boolean
  /** Who ticked it off (checklist done_by / action completed_by), or null. */
  doneBy: string | null
  /** Everyone mode: has the viewer ticked theirs. Otherwise same as `done`. */
  doneForViewer: boolean
  /** Everyone mode: people (in scope) who have ticked. */
  doneIds: string[]
  /** Everyone mode: people (in scope) who still have to. */
  leftIds: string[]
  /** Everyone mode: number of people in scope. */
  total: number
}

export interface BuildViewsInput {
  actions: ReadonlyArray<ActionWithCompletions>
  checklists: ReadonlyArray<ChecklistRow>
  participants: ReadonlyArray<TodoParticipant>
  userId: string | undefined
  trip: TripForActionStatus | null | undefined
  /** section_id -> user ids who ANSWERED (vote, selection or pass), widened for closed questions. */
  sectionVoters: SectionVoterIds
  closedSectionIds: ReadonlySet<string>
  /** Finished trips never show overdue. */
  finished: boolean
}

export function buildTodoViews(input: BuildViewsInput): TodoView[] {
  const { actions, checklists, participants, userId, trip, sectionVoters, closedSectionIds, finished } = input
  const inScope = participants.filter(countsTowardActions).map((p) => p.user_id)
  const views: TodoView[] = []

  for (const a of actions) {
    const mode = actionWhoMode(a)
    const noLongerNeeded = !!a.section_id && closedSectionIds.has(a.section_id)
    let done: boolean
    let doneForViewer: boolean
    let doneIds: string[] = []
    let leftIds: string[] = []
    if (mode === 'everyone') {
      const completed = groupCompletedUserIds(a, sectionVoters)
      doneIds = inScope.filter((id) => completed.has(id))
      leftIds = inScope.filter((id) => !completed.has(id))
      done = inScope.length > 0 && leftIds.length === 0
      doneForViewer = userId ? isActionCompleteForUser(a, userId, sectionVoters) : false
    } else if (mode === 'anyone' && !a.assigned_to) {
      // Unclaimed: nobody has taken it on, so it cannot be done (a closed question still retires it).
      done = false
      doneForViewer = false
    } else {
      done = isActionCompleteForUser(a, a.assigned_to as string, sectionVoters)
      doneForViewer = done
    }
    if (noLongerNeeded) {
      done = true
      doneForViewer = true
    }
    views.push({
      key: `action:${a.id}`,
      source: 'action',
      id: a.id,
      title: a.title,
      notes: a.notes,
      mode,
      assigneeId: mode === 'everyone' ? null : a.assigned_to,
      claimed: mode === 'anyone' && !!a.assigned_to,
      isBring: false,
      createdBy: a.created_by,
      due: resolveDueDate(a, trip),
      deadlineKind: a.deadline_kind,
      overdue: !finished && !done && isOverdue(a, trip),
      sectionId: a.section_id,
      noLongerNeeded,
      done,
      doneBy: mode === 'everyone' ? null : a.completed_by ?? null,
      doneForViewer,
      doneIds,
      leftIds,
      total: mode === 'everyone' ? inScope.length : 0,
    })
  }

  for (const c of checklists) {
    const mode = checklistWhoMode(c)
    views.push({
      key: `checklist:${c.id}`,
      source: 'checklist',
      id: c.id,
      title: c.title,
      notes: null,
      mode,
      assigneeId: c.assigned_to,
      claimed: false,
      isBring: true,
      createdBy: c.created_by,
      due: null,
      deadlineKind: 'fixed',
      overdue: false,
      sectionId: null,
      noLongerNeeded: false,
      done: c.done,
      doneBy: c.done_by ?? null,
      doneForViewer: c.done,
      doneIds: [],
      leftIds: [],
      total: 0,
    })
  }
  return views
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface TodoGroups {
  /** Assigned to you, claimed by you, or Everyone and you haven't done yours. */
  yours: TodoView[]
  /** Everyone to-dos you aren't (or are no longer) on the hook for: "x of y done", who's left. */
  everyone: TodoView[]
  /** Open to-dos with a named person or a claimer who isn't you. */
  others: TodoView[]
  /** Anyone to-dos nobody has claimed. */
  upForGrabs: TodoView[]
  /** Finished trips only: everything not done, shown as history instead of as things to do. */
  leftOpen: TodoView[]
  done: TodoView[]
}

function byUrgency(a: TodoView, b: TodoView): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
  if (a.due && b.due) return a.due.localeCompare(b.due)
  if (a.due) return -1
  if (b.due) return 1
  return 0
}

export function groupTodos(views: ReadonlyArray<TodoView>, opts: { userId: string | undefined; finished: boolean; viewerInScope: boolean }): TodoGroups {
  const groups: TodoGroups = { yours: [], everyone: [], others: [], upForGrabs: [], leftOpen: [], done: [] }
  for (const v of views) {
    if (v.done) groups.done.push(v)
    else if (opts.finished) groups.leftOpen.push(v)
    else if (v.mode === 'everyone') (opts.viewerInScope && !v.doneForViewer ? groups.yours : groups.everyone).push(v)
    else if (v.mode === 'anyone' && !v.assigneeId) groups.upForGrabs.push(v)
    else (v.assigneeId && v.assigneeId === opts.userId ? groups.yours : groups.others).push(v)
  }
  for (const key of ['yours', 'everyone', 'others', 'upForGrabs', 'leftOpen'] as const) groups[key].sort(byUrgency)
  return groups
}

/** Open to-dos that are the viewer's own job (the sheet's "Yours" count). */
export function yoursCount(groups: TodoGroups): number {
  return groups.yours.length
}

// ---------------------------------------------------------------------------
// Due chip (calm: overdue is amber, never red; finished trips show none)
// ---------------------------------------------------------------------------

export interface DueChip {
  label: string
  tone: 'overdue' | 'soon' | 'plain'
}

/** "3 days left" / "Due today" / "Overdue by 2 days" / "Before trip"; null when there is no due date. */
export function dueChip(view: Pick<TodoView, 'due' | 'deadlineKind' | 'done' | 'overdue'>, finished: boolean): DueChip | null {
  if (finished || view.done) return null
  const before = view.deadlineKind === 'before_trip'
  if (!view.due) return before ? { label: 'Before trip', tone: 'plain' } : null
  const days = daysUntil(view.due)
  const prefix = before ? 'Before trip · ' : ''
  if (days === 0) return { label: `${prefix}Due today`, tone: 'soon' }
  if (days < 0) return { label: `${prefix}Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, tone: 'overdue' }
  return { label: `${prefix}${days} day${days === 1 ? '' : 's'} left`, tone: days <= 2 ? 'soon' : 'plain' }
}

// ---------------------------------------------------------------------------
// Permissions: only offer what the server will accept
// ---------------------------------------------------------------------------

export interface Viewer {
  userId: string | undefined
  isOrganizer: boolean
  /** An active participant who is still in the trip (not declined/cancelled). */
  isParticipant: boolean
  finished: boolean
  /**
   * 20261117100000_todo_who_mode.sql is applied (who_mode column + claim policies). Before it, only the
   * creator, the assignee or an organizer can update a row, so a plain participant cannot claim.
   */
  whoSupported: boolean
}

/** Creating needs a participant and a live trip; the INSERT policy is "created_by = me and I'm a participant". */
export function canCreate(viewer: Viewer): boolean {
  return !!viewer.userId && viewer.isParticipant && !viewer.finished
}

/** Edit and delete: the UPDATE/DELETE policies allow the creator or an organizer (the assignee may update but not reassign). */
export function canEditOrDelete(view: Pick<TodoView, 'createdBy'>, viewer: Viewer): boolean {
  return !viewer.finished && !!viewer.userId && (viewer.isOrganizer || view.createdBy === viewer.userId)
}

/** Whether the server lets the viewer UPDATE this row's assignee (claim / give back). */
function canWriteAssignee(view: Pick<TodoView, 'createdBy'>, viewer: Viewer): boolean {
  return viewer.whoSupported || viewer.isOrganizer || view.createdBy === viewer.userId
}

export function canClaim(view: TodoView, viewer: Viewer): boolean {
  return (
    !viewer.finished &&
    !!viewer.userId &&
    viewer.isParticipant &&
    view.mode === 'anyone' &&
    !view.assigneeId &&
    !view.done &&
    !view.noLongerNeeded &&
    canWriteAssignee(view, viewer)
  )
}

/**
 * The claimer gives an Anyone to-do back. A bring item that is assigned looks the same as one that was
 * claimed (one nullable column), so its assignee may also hand it back.
 */
export function canUnclaim(view: TodoView, viewer: Viewer): boolean {
  return (
    !viewer.finished &&
    !!viewer.userId &&
    view.assigneeId === viewer.userId &&
    (view.mode === 'anyone' || view.source === 'checklist') &&
    !view.done &&
    canWriteAssignee(view, viewer)
  )
}

/**
 * Ticking: Everyone = each person ticks their own (an organizer cannot tick for someone else: the completion
 * INSERT policy is own-row only); a named person or claimer = only them, or an organizer. An unclaimed
 * Anyone to-do has to be claimed first.
 */
export function canTick(view: TodoView, viewer: Viewer): boolean {
  if (viewer.finished || !viewer.userId || view.noLongerNeeded) return false
  if (view.mode === 'everyone') return viewer.isParticipant
  if (!view.assigneeId) {
    // A done bring item can end up with no assignee (it was ticked, then given back / reassigned): whoever
    // ticked it, or an organizer, can still undo it. Never offered for opening an unclaimed one.
    return view.done && (viewer.isOrganizer || (!!view.doneBy && view.doneBy === viewer.userId))
  }
  return view.assigneeId === viewer.userId || viewer.isOrganizer
}

/** True when an organizer is ticking on someone else's behalf (shown de-emphasised). */
export function isTickOnBehalf(view: TodoView, viewer: Viewer): boolean {
  return view.mode !== 'everyone' && !!view.assigneeId && view.assigneeId !== viewer.userId && canTick(view, viewer)
}

// ---------------------------------------------------------------------------
// Form -> columns
// ---------------------------------------------------------------------------

export interface TodoFormValues {
  title: string
  notes: string
  mode: WhoMode
  /** The named person when mode is 'person'. */
  personId: string
  beforeTrip: boolean
  dueDate: string
  /** Linked question (planning_sections.id) or ''. */
  sectionId: string
  /** Create as something to bring (a bring-list row). New items only. */
  bring: boolean
}

export const EMPTY_TODO_FORM: TodoFormValues = {
  title: '',
  notes: '',
  mode: 'everyone',
  personId: '',
  beforeTrip: false,
  dueDate: '',
  sectionId: '',
  bring: false,
}

/** The first problem with the form, or null. Server rules are mirrored so a save is never doomed. */
export function validateTodoForm(values: TodoFormValues, opts: { whoSupported: boolean; editingSource?: TodoSource }): string | null {
  if (!values.title.trim()) return 'Please enter a title'
  const bring = opts.editingSource ? opts.editingSource === 'checklist' : values.bring
  if (values.mode === 'person' && !values.personId) return 'Choose who this is for'
  if (bring && values.mode === 'everyone') return 'Something to bring needs a person or Anyone'
  if (!bring && values.mode === 'anyone' && !opts.whoSupported) return '"Anyone" is not available for this kind of to-do yet'
  // Before the migration a "fixed" deadline must have a date (trip_actions_due_when_fixed).
  if (!bring && !opts.whoSupported && !values.beforeTrip && !values.dueDate) return 'Please choose a deadline'
  return null
}

export type ActionWriteColumns = {
  title: string
  notes: string | null
  assigned_to: string | null
  deadline_kind: string
  due_date: string | null
  section_id: string | null
  who_mode?: string | null
  completed_at?: string | null
  completed_by?: string | null
}

/**
 * Columns for a `trip_actions` create/update. `existing` is the row being edited.
 * - Everyone: assigned_to NULL. A person: assigned_to = them. Anyone: who_mode = 'anyone', assigned_to NULL
 *   (or the current claimer, when editing a claimed one and leaving it on Anyone).
 * - `who_mode` is written only when needed (set to 'anyone', or cleared from an 'anyone' row), so a plain
 *   Everyone/person write is identical to today's and works before the migration.
 * - Changing who it is for resets the completion (it would otherwise carry over to someone else).
 */
export function buildActionColumns(
  values: TodoFormValues,
  existing?: { assigned_to: string | null; who_mode?: string | null } | null
): ActionWriteColumns {
  const trimmedNotes = values.notes.trim()
  let assignedTo: string | null
  if (values.mode === 'person') assignedTo = values.personId
  else if (values.mode === 'anyone') assignedTo = existing && actionWhoMode(existing) === 'anyone' ? existing.assigned_to : null
  else assignedTo = null

  const cols: ActionWriteColumns = {
    title: values.title.trim(),
    notes: trimmedNotes || null,
    assigned_to: assignedTo,
    deadline_kind: values.beforeTrip ? 'before_trip' : 'fixed',
    due_date: values.beforeTrip ? null : values.dueDate || null,
    section_id: values.sectionId || null,
  }
  if (values.mode === 'anyone') cols.who_mode = ANYONE_MODE_VALUE
  else if (existing?.who_mode != null) cols.who_mode = null

  if (existing) {
    const before = actionWhoMode(existing)
    if (before !== values.mode || existing.assigned_to !== assignedTo) {
      cols.completed_at = null
      cols.completed_by = null
    }
  }
  return cols
}

/** Columns for a `trip_checklists` create/update (title and assignee only; the table has nothing else). */
export function buildChecklistColumns(values: TodoFormValues): { title: string; assigned_to: string | null } {
  return { title: values.title.trim(), assigned_to: checklistAssigneeFor(values.mode, values.personId) }
}

/** Form values for editing an existing view's underlying row. */
export function formValuesFor(
  view: TodoView,
  row: { notes?: string | null; deadline_kind?: string; due_date?: string | null; section_id?: string | null }
): TodoFormValues {
  return {
    title: view.title,
    notes: row.notes ?? '',
    mode: view.mode,
    personId: view.mode === 'person' ? (view.assigneeId ?? '') : '',
    beforeTrip: row.deadline_kind === 'before_trip',
    dueDate: row.due_date ?? '',
    sectionId: row.section_id ?? '',
    bring: view.isBring,
  }
}

// ---------------------------------------------------------------------------
// DOM ids and the Who <select> encoding (kept out of the components for fast refresh)
// ---------------------------------------------------------------------------

/** DOM id prefixes: the sheet scrolls to / flashes a row for `?open=todo:<id>` and `?open=bring:<id>`. */
export const ROW_ID_PREFIX = 'todo-row-'
export const BRING_ROW_ID_PREFIX = 'bring-row-'

export function rowDomId(view: Pick<TodoView, 'source' | 'id'>): string {
  return `${view.source === 'checklist' ? BRING_ROW_ID_PREFIX : ROW_ID_PREFIX}${view.id}`
}

const PERSON_PREFIX = 'person:'

/** One Select carries the whole Who choice: 'everyone' | 'anyone' | 'person:<userId>'. */
export function whoSelectValue(values: Pick<TodoFormValues, 'mode' | 'personId'>): string {
  return values.mode === 'person' ? `${PERSON_PREFIX}${values.personId}` : values.mode
}

export function personSelectValue(userId: string): string {
  return `${PERSON_PREFIX}${userId}`
}

export function applyWhoSelect(value: string): Pick<TodoFormValues, 'mode' | 'personId'> {
  if (value.startsWith(PERSON_PREFIX)) return { mode: 'person', personId: value.slice(PERSON_PREFIX.length) }
  return { mode: value === 'anyone' ? 'anyone' : 'everyone', personId: '' }
}
