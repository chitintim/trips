import { describe, it, expect } from 'vitest'
import { buildAnsweredSectionVoters } from '../../../lib/answers/answers'
import { withClosedSections } from './actionStatus'
import type { ActionWithCompletions } from './actionStatus'
import { checklistAssigneeFor, checklistCanStore, checklistWhoMode } from '../../checklists/lib/checklistWho'
import {
  actionWhoMode,
  buildActionColumns,
  buildChecklistColumns,
  buildTodoViews,
  canClaim,
  canCreate,
  canEditOrDelete,
  canTick,
  canUnclaim,
  dueChip,
  EMPTY_TODO_FORM,
  groupTodos,
  isTickOnBehalf,
  validateTodoForm,
} from './todoModel'
import type { ChecklistRow, TodoFormValues, Viewer } from './todoModel'

const ME = 'me'
const SAM = 'sam'
const PRIYA = 'priya'
const PEOPLE = [{ user_id: ME }, { user_id: SAM }, { user_id: PRIYA }]

function act(over: Partial<ActionWithCompletions> & { id: string }): ActionWithCompletions {
  return {
    trip_id: 't',
    title: over.id,
    notes: null,
    created_by: SAM,
    assigned_to: null,
    deadline_kind: 'fixed',
    due_date: '2999-01-01',
    completed_at: null,
    completed_by: null,
    created_at: '2026-01-01T00:00:00Z',
    section_id: null,
    trip_action_completions: [],
    ...over,
  } as ActionWithCompletions
}
function chk(over: Partial<ChecklistRow> & { id: string }): ChecklistRow {
  return { title: over.id, assigned_to: null, created_by: SAM, done: false, ...over }
}

function build(actions: ActionWithCompletions[], checklists: ChecklistRow[] = [], opts: { voters?: Map<string, Set<string>>; closed?: string[]; finished?: boolean } = {}) {
  const views = buildTodoViews({
    actions,
    checklists,
    participants: PEOPLE,
    userId: ME,
    trip: { start_date: '2999-06-01' },
    sectionVoters: opts.voters ?? new Map(),
    closedSectionIds: new Set(opts.closed ?? []),
    finished: opts.finished ?? false,
  })
  const groups = groupTodos(views, { userId: ME, finished: opts.finished ?? false, viewerInScope: true })
  return { views, groups }
}
const ids = (list: { id: string }[]) => list.map((v) => v.id)

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: ME, isOrganizer: false, isParticipant: true, finished: false, whoSupported: true, ...over })

describe('Who-mode mapping keeps existing rows meaning what they meant', () => {
  it('trip_actions: no assignee = Everyone, assignee = a person (with or without the who_mode column)', () => {
    expect(actionWhoMode({ assigned_to: null })).toBe('everyone')
    expect(actionWhoMode({ assigned_to: null, who_mode: null })).toBe('everyone')
    expect(actionWhoMode({ assigned_to: SAM })).toBe('person')
    expect(actionWhoMode({ assigned_to: SAM, who_mode: null })).toBe('person')
  })

  it("trip_actions: who_mode 'anyone' = up for grabs, claimed when assigned", () => {
    expect(actionWhoMode({ assigned_to: null, who_mode: 'anyone' })).toBe('anyone')
    expect(actionWhoMode({ assigned_to: ME, who_mode: 'anyone' })).toBe('anyone')
  })

  it('trip_checklists: no assignee = Anyone, assignee = a person; Everyone cannot be stored', () => {
    expect(checklistWhoMode({ assigned_to: null })).toBe('anyone')
    expect(checklistWhoMode({ assigned_to: SAM })).toBe('person')
    expect(checklistCanStore('everyone')).toBe(false)
    expect(checklistCanStore('anyone')).toBe(true)
    expect(() => checklistAssigneeFor('everyone', null)).toThrow()
    expect(checklistAssigneeFor('anyone', 'ignored')).toBeNull()
    expect(checklistAssigneeFor('person', SAM)).toBe(SAM)
  })

  it('views carry the mode of each stored row', () => {
    const { views } = build([act({ id: 'a-all' }), act({ id: 'a-sam', assigned_to: SAM }), act({ id: 'a-any', who_mode: 'anyone' })], [chk({ id: 'c-any' }), chk({ id: 'c-sam', assigned_to: SAM })])
    expect(Object.fromEntries(views.map((v) => [v.id, v.mode]))).toEqual({
      'a-all': 'everyone',
      'a-sam': 'person',
      'a-any': 'anyone',
      'c-any': 'anyone',
      'c-sam': 'person',
    })
  })
})

describe('grouping', () => {
  it('puts each item in the right section', () => {
    const { groups } = build(
      [
        act({ id: 'every-undone' }),
        act({ id: 'every-mine-done', trip_action_completions: [{ user_id: ME, completed_at: 'x' }] }),
        act({ id: 'mine', assigned_to: ME }),
        act({ id: 'sams', assigned_to: SAM }),
        act({ id: 'grab', who_mode: 'anyone' }),
        act({ id: 'claimed-by-me', who_mode: 'anyone', assigned_to: ME }),
        act({ id: 'claimed-by-sam', who_mode: 'anyone', assigned_to: SAM }),
        act({ id: 'finished', assigned_to: SAM, completed_at: '2026-01-01T00:00:00Z' }),
      ],
      [chk({ id: 'bring-grab' }), chk({ id: 'bring-mine', assigned_to: ME }), chk({ id: 'bring-done', assigned_to: SAM, done: true })]
    )
    expect(ids(groups.yours).sort()).toEqual(['bring-mine', 'claimed-by-me', 'every-undone', 'mine'])
    expect(ids(groups.everyone)).toEqual(['every-mine-done'])
    expect(ids(groups.others).sort()).toEqual(['claimed-by-sam', 'sams'])
    expect(ids(groups.upForGrabs).sort()).toEqual(['bring-grab', 'grab'])
    expect(ids(groups.done).sort()).toEqual(['bring-done', 'finished'])
  })

  it('an Everyone to-do shows "x of y done" and who is left', () => {
    const { views } = build([act({ id: 'e', trip_action_completions: [{ user_id: SAM, completed_at: 'x' }] })])
    expect(views[0].doneIds).toEqual([SAM])
    expect(views[0].leftIds).toEqual([ME, PRIYA])
    expect(views[0].total).toBe(3)
    expect(views[0].done).toBe(false)
  })

  it('an Everyone to-do is done only when every person in scope has ticked', () => {
    const all = PEOPLE.map((p) => ({ user_id: p.user_id, completed_at: 'x' }))
    expect(build([act({ id: 'e', trip_action_completions: all })]).groups.done).toHaveLength(1)
  })

  it('people who declined do not block or count', () => {
    const views = buildTodoViews({
      actions: [act({ id: 'e', trip_action_completions: [{ user_id: ME, completed_at: 'x' }, { user_id: SAM, completed_at: 'x' }] })],
      checklists: [],
      participants: [...PEOPLE.slice(0, 2), { user_id: PRIYA, confirmation_status: 'declined' }],
      userId: ME,
      trip: null,
      sectionVoters: new Map(),
      closedSectionIds: new Set(),
      finished: false,
    })
    expect(views[0].done).toBe(true)
    expect(views[0].total).toBe(2)
  })

  it('a viewer who is out sees Everyone to-dos under Everyone, not Yours', () => {
    const views = build([act({ id: 'e' })]).views
    const groups = groupTodos(views, { userId: ME, finished: false, viewerInScope: false })
    expect(ids(groups.yours)).toEqual([])
    expect(ids(groups.everyone)).toEqual(['e'])
  })

  it('orders overdue first, then by due date, undated last', () => {
    const { groups } = build([
      act({ id: 'later', assigned_to: ME, due_date: '2998-01-01' }),
      act({ id: 'late', assigned_to: ME, due_date: '2020-01-01' }),
      act({ id: 'sooner', assigned_to: ME, due_date: '2997-01-01' }),
      act({ id: 'undated', assigned_to: ME, due_date: null }),
    ])
    expect(ids(groups.yours)).toEqual(['late', 'sooner', 'later', 'undated'])
  })

  it('finished trips: nothing is a to-do, open items become read-only history and nothing is overdue', () => {
    const { groups, views } = build([act({ id: 'a', assigned_to: ME, due_date: '2020-01-01' }), act({ id: 'g', who_mode: 'anyone' })], [chk({ id: 'c' })], { finished: true })
    expect(ids(groups.leftOpen).sort()).toEqual(['a', 'c', 'g'])
    expect(groups.yours).toEqual([])
    expect(groups.upForGrabs).toEqual([])
    expect(views.some((v) => v.overdue)).toBe(false)
    expect(dueChip(views[0], true)).toBeNull()
  })
})

describe('linked questions', () => {
  const section = (id: string, status = 'open') => ({ id, status, metadata: null, options: [{ id: `${id}-o1`, status: 'available' }] })

  it('a pass counts as answered and ticks the linked to-do', () => {
    const voters = buildAnsweredSectionVoters([section('q1')] as never, { votes: [], passes: [{ section_id: 'q1', user_id: ME, kind: 'no_preference' }] })
    const { views } = build([act({ id: 'link', section_id: 'q1' })], [], { voters })
    expect(views[0].doneForViewer).toBe(true)
    expect(views[0].done).toBe(false) // others have not answered
    expect(views[0].doneIds).toEqual([ME])
  })

  it('a vote still counts', () => {
    const voters = buildAnsweredSectionVoters([section('q1')] as never, { votes: [{ option_id: 'q1-o1', user_id: ME }] })
    expect(build([act({ id: 'link', section_id: 'q1', assigned_to: ME })], [], { voters }).groups.done).toHaveLength(1)
  })

  it('a closed question retires the to-do: done, flagged "no longer needed"', () => {
    const voters = withClosedSections(new Map(), [section('q1', 'completed')], [ME, SAM, PRIYA])
    const { views, groups } = build([act({ id: 'link', section_id: 'q1' }), act({ id: 'grab', section_id: 'q1', who_mode: 'anyone' })], [], { voters, closed: ['q1'] })
    expect(views.every((v) => v.noLongerNeeded && v.done)).toBe(true)
    expect(groups.done).toHaveLength(2)
    expect(groups.upForGrabs).toEqual([])
  })
})

describe('permissions: only offer what the server accepts', () => {
  const grab = () => build([act({ id: 'g', who_mode: 'anyone' })]).views[0]
  const bringGrab = () => build([], [chk({ id: 'b', created_by: PRIYA })]).views[0]

  it('anyone participant can create; not on a finished trip; not when out', () => {
    expect(canCreate(viewer())).toBe(true)
    expect(canCreate(viewer({ finished: true }))).toBe(false)
    expect(canCreate(viewer({ isParticipant: false }))).toBe(false)
    expect(canCreate(viewer({ userId: undefined }))).toBe(false)
  })

  it('claim: any participant once the migration is applied', () => {
    expect(canClaim(grab(), viewer())).toBe(true)
    expect(canClaim(bringGrab(), viewer())).toBe(true)
  })

  it('claim before the migration: only the creator or an organizer (the old UPDATE policy)', () => {
    const v = viewer({ whoSupported: false })
    expect(canClaim(bringGrab(), v)).toBe(false) // created by someone else
    expect(canClaim(bringGrab(), viewer({ whoSupported: false, isOrganizer: true }))).toBe(true)
    expect(canClaim(build([], [chk({ id: 'mine', created_by: ME })]).views[0], v)).toBe(true)
  })

  it('cannot claim a claimed, done, finished or out-of-trip item', () => {
    expect(canClaim(build([act({ id: 'c', who_mode: 'anyone', assigned_to: SAM })]).views[0], viewer())).toBe(false)
    expect(canClaim(grab(), viewer({ finished: true }))).toBe(false)
    expect(canClaim(grab(), viewer({ isParticipant: false }))).toBe(false)
    expect(canClaim(build([], [chk({ id: 'd', done: true })]).views[0], viewer())).toBe(false)
  })

  it('give back: the claimer only, and not once done', () => {
    const mine = build([act({ id: 'm', who_mode: 'anyone', assigned_to: ME })]).views[0]
    expect(canUnclaim(mine, viewer())).toBe(true)
    expect(canUnclaim(mine, viewer({ userId: SAM }))).toBe(false)
    const done = build([act({ id: 'm', who_mode: 'anyone', assigned_to: ME, completed_at: 'x' })]).views[0]
    expect(canUnclaim(done, viewer())).toBe(false)
    // a plainly named person on a trip_action cannot hand it back; a bring item's assignee can
    expect(canUnclaim(build([act({ id: 'p', assigned_to: ME })]).views[0], viewer())).toBe(false)
    expect(canUnclaim(build([], [chk({ id: 'bm', assigned_to: ME })]).views[0], viewer())).toBe(true)
  })

  it('tick: Everyone = each their own; a person = only them or an organizer; unclaimed Anyone = claim first', () => {
    const every = build([act({ id: 'e' })]).views[0]
    const sams = build([act({ id: 's', assigned_to: SAM })]).views[0]
    expect(canTick(every, viewer())).toBe(true)
    expect(canTick(every, viewer({ isOrganizer: true, isParticipant: false }))).toBe(false)
    expect(canTick(sams, viewer())).toBe(false)
    expect(canTick(sams, viewer({ isOrganizer: true }))).toBe(true)
    expect(isTickOnBehalf(sams, viewer({ isOrganizer: true }))).toBe(true)
    expect(canTick(sams, viewer({ userId: SAM }))).toBe(true)
    expect(canTick(grab(), viewer())).toBe(false)
    expect(canTick(grab(), viewer({ isOrganizer: true }))).toBe(false)
    expect(canTick(every, viewer({ finished: true }))).toBe(false)
  })

  it('a done bring item with no assignee can be unticked by who ticked it, or an organizer', () => {
    const doneUnassigned = build([], [chk({ id: 'du', done: true, done_by: SAM })]).views[0]
    expect(canTick(doneUnassigned, viewer())).toBe(false)
    expect(canTick(doneUnassigned, viewer({ userId: SAM }))).toBe(true)
    expect(canTick(doneUnassigned, viewer({ isOrganizer: true }))).toBe(true)
    expect(canTick(doneUnassigned, viewer({ userId: SAM, finished: true }))).toBe(false)
    // an open unassigned item still cannot be ticked
    expect(canTick(build([], [chk({ id: 'ou', done_by: SAM })]).views[0], viewer({ userId: SAM }))).toBe(false)
    // done with no recorded ticker: only an organizer
    const noTicker = build([], [chk({ id: 'nt', done: true })]).views[0]
    expect(canTick(noTicker, viewer())).toBe(false)
    expect(canTick(noTicker, viewer({ isOrganizer: true }))).toBe(true)
  })

  it('edit and delete: creator or organizer, never on a finished trip', () => {
    const v = build([act({ id: 'x', created_by: ME })]).views[0]
    expect(canEditOrDelete(v, viewer())).toBe(true)
    expect(canEditOrDelete(v, viewer({ userId: SAM }))).toBe(false)
    expect(canEditOrDelete(v, viewer({ userId: SAM, isOrganizer: true }))).toBe(true)
    expect(canEditOrDelete(v, viewer({ finished: true }))).toBe(false)
  })
})

describe('form -> columns', () => {
  const form = (over: Partial<TodoFormValues>): TodoFormValues => ({ ...EMPTY_TODO_FORM, title: '  Book it ', dueDate: '2999-02-02', ...over })

  it('Everyone / a person write exactly what they wrote before (no who_mode key)', () => {
    const every = buildActionColumns(form({ mode: 'everyone' }))
    expect(every).toMatchObject({ title: 'Book it', assigned_to: null, deadline_kind: 'fixed', due_date: '2999-02-02' })
    expect('who_mode' in every).toBe(false)
    const person = buildActionColumns(form({ mode: 'person', personId: SAM }))
    expect(person.assigned_to).toBe(SAM)
    expect('who_mode' in person).toBe(false)
  })

  it("Anyone writes who_mode 'anyone' with no assignee; editing a claimed one keeps the claimer", () => {
    expect(buildActionColumns(form({ mode: 'anyone' }))).toMatchObject({ assigned_to: null, who_mode: 'anyone' })
    const cols = buildActionColumns(form({ mode: 'anyone' }), { assigned_to: PRIYA, who_mode: 'anyone' })
    expect(cols.assigned_to).toBe(PRIYA)
    expect(cols.completed_at).toBeUndefined()
  })

  it("moving an Anyone to-do to a person clears who_mode, and changing who resets completion", () => {
    const cols = buildActionColumns(form({ mode: 'person', personId: SAM }), { assigned_to: null, who_mode: 'anyone' })
    expect(cols).toMatchObject({ assigned_to: SAM, who_mode: null, completed_at: null, completed_by: null })
  })

  it('an untouched edit does not reset completion', () => {
    const cols = buildActionColumns(form({ mode: 'person', personId: SAM }), { assigned_to: SAM })
    expect(cols.completed_at).toBeUndefined()
    expect('who_mode' in cols).toBe(false)
  })

  it('due date optional, or before the trip', () => {
    expect(buildActionColumns(form({ dueDate: '' }))).toMatchObject({ deadline_kind: 'fixed', due_date: null })
    expect(buildActionColumns(form({ beforeTrip: true }))).toMatchObject({ deadline_kind: 'before_trip', due_date: null })
  })

  it('bring items store only title + assignee', () => {
    expect(buildChecklistColumns(form({ mode: 'anyone' }))).toEqual({ title: 'Book it', assigned_to: null })
    expect(buildChecklistColumns(form({ mode: 'person', personId: SAM }))).toEqual({ title: 'Book it', assigned_to: SAM })
    expect(() => buildChecklistColumns(form({ mode: 'everyone' }))).toThrow()
  })

  it('validation mirrors the server', () => {
    const ok = { whoSupported: true }
    expect(validateTodoForm(form({ title: ' ' }), ok)).toMatch(/title/i)
    expect(validateTodoForm(form({ mode: 'person' }), ok)).toMatch(/who/i)
    expect(validateTodoForm(form({ dueDate: '' }), ok)).toBeNull()
    // before the migration: a deadline is required and general Anyone is not available
    expect(validateTodoForm(form({ dueDate: '' }), { whoSupported: false })).toMatch(/deadline/i)
    expect(validateTodoForm(form({ mode: 'anyone' }), { whoSupported: false })).toMatch(/not available/i)
    // ...but a bring item can be Anyone and needs no date, and cannot be Everyone
    expect(validateTodoForm(form({ mode: 'anyone', bring: true, dueDate: '' }), { whoSupported: false })).toBeNull()
    expect(validateTodoForm(form({ mode: 'everyone', bring: true }), ok)).toMatch(/bring/i)
  })
})
