import { describe, expect, it } from 'vitest'
import { computeWaitingOn } from '../todos/computeTodos'
import { todoCountLabel } from '../todos/copy'
import type { SnapshotParticipant, SnapshotSection, SnapshotTrip, TripSnapshot } from '../todos/types'
import { buildOrganiserSummary } from '../../features/today/lib/organiserSummaryModel'
import { todayListModel, todoSurfaceCore, tripCardBadgeCount } from './todoSurfaces'
import { buildAnsweredSectionVoters } from '../answers/answers'
import { buildTodoViews, groupTodos } from '../../features/actions/lib/todoModel'
import type { ActionWithCompletions } from '../../features/actions/lib/actionStatus'

/**
 * THE INVARIANT (UX redesign 3.5): for any trip and any person, the header
 * pill, Today's list, the dashboard badge and that person's row in the
 * organiser's "Waiting on" are the same number, because they all read
 * computeTodos. Three fixture trips shaped like the real ones.
 */

const NOW = new Date(2026, 10, 16, 12, 0, 0)

const person = (id: string, name: string, over: Partial<SnapshotParticipant> = {}): SnapshotParticipant => ({
  user_id: id,
  role: 'participant',
  active: true,
  confirmation_status: 'confirmed',
  user: { full_name: `${name} Smith`, first_name: name },
  ...over,
})

const question = (id: string, title: string, over: Partial<SnapshotSection> = {}): SnapshotSection => ({
  id,
  title,
  status: 'in_progress',
  vote_deadline: null,
  voting_method: 'single',
  metadata: null,
  options: [
    { id: `${id}-a`, title: `${title} A`, status: 'available', selections: [] },
    { id: `${id}-b`, title: `${title} B`, status: 'available', selections: [] },
  ],
  ...over,
})

const PAST = new Date(2026, 10, 10, 12).toISOString()

/** A decided accommodation question; `status` is the winning option's legacy status. */
const decidedStay = (metadata: Record<string, unknown>, status = 'available'): SnapshotSection =>
  question('b', 'Where to stay', {
    status: 'completed',
    section_type: 'accommodation',
    metadata: metadata as never,
    options: [
      { id: 'b-win', title: 'Osaka Airbnb', status, selections: [] },
      { id: 'b-lose', title: 'Hotel', status: 'available', selections: [] },
    ],
  })

const baseTrip: SnapshotTrip = {
  id: 'trip',
  name: 'Trip',
  status: 'confirming_participants',
  start_date: '2027-02-06',
  end_date: '2027-02-13',
  confirmation_enabled: true,
  confirmation_deadline: null,
  base_currency: 'GBP',
  created_by: 'tim',
}

const crew = [
  person('tim', 'Tim', { role: 'organizer' }),
  person('sam', 'Sam'),
  person('chai', 'Chai', { confirmation_status: 'pending' }),
  person('ana', 'Ana', { confirmation_status: 'interested' }),
  person('out', 'Out', { confirmation_status: 'declined' }),
]

function snap(over: Partial<TripSnapshot>): TripSnapshot {
  return { trip: baseTrip, participants: crew, sections: [], votes: [], actions: [], checklists: [], expenses: [], settlements: [], travelEvents: [], ...over }
}

const FIXTURES: Record<string, TripSnapshot> = {
  // Upcoming, RSVPs pending, many open questions (more than Today shows collapsed), tasks, packing and a payment.
  japow: snap({
    sections: Array.from({ length: 7 }, (_, i) =>
      question(`q${i}`, `Question ${i}`, i === 1 ? { vote_deadline: new Date(2026, 10, 12, 12).toISOString() } : {})
    ),
    votes: [{ option_id: 'q0-a', user_id: 'sam' }],
    actions: [{ id: 'a1', title: 'Passports', assigned_to: null, deadline_kind: 'fixed', due_date: '2026-11-10', completed_at: null, section_id: null }],
    checklists: [{ id: 'c1', title: 'Speaker', assigned_to: 'sam', done: false }],
    settlements: [{ id: 's1', from_user_id: 'sam', to_user_id: 'tim', amount: 20, currency: 'GBP', status: 'suggested' }],
  }),
  // Finished, open questions never count, legacy booked option.
  japan2026: snap({
    trip: { ...baseTrip, id: 'japan', status: 'trip_completed', start_date: '2026-03-01', end_date: '2026-03-14' },
    sections: [
      question('j0', 'Accommodation', {
        options: [
          { id: 'j0-a', title: 'Tokyo Airbnb', status: 'booked', selections: [] },
          { id: 'j0-b', title: 'Hotel', status: 'available', selections: [] },
        ],
      }),
      question('j1', 'Dinner'),
    ],
    actions: [{ id: 'act', title: 'Book flights', assigned_to: null, deadline_kind: 'fixed', due_date: '2026-01-01', completed_at: null, section_id: null }],
  }),
  // Finished, balances NEVER frozen: participants have no to-do (info line only), the organiser has ONE freeze to-do.
  unfrozen: snap({
    trip: { ...baseTrip, id: 'unfrozen', status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08', settlement_snapshot: null },
    balances: { tim: 5000, sam: -4698.61, chai: -301.39, ana: 0, out: -50 },
  }),
  // Slice 4E: organiser lifecycle fixtures (decide / tie / book / own-choice close).
  deadlineLeader: snap({ sections: [question('d', 'Where to stay', { vote_deadline: PAST })], votes: [{ option_id: 'd-a', user_id: 'sam' }, { option_id: 'd-a', user_id: 'chai' }, { option_id: 'd-b', user_id: 'ana' }] }),
  deadlineTie: snap({ sections: [question('d', 'Where to stay', { vote_deadline: PAST })], votes: [{ option_id: 'd-a', user_id: 'sam' }, { option_id: 'd-b', user_id: 'chai' }] }),
  decidedRealBook: snap({
    sections: [decidedStay({ decided_option_id: 'b-win', followup_action_id: 'act-book' })],
    votes: [{ option_id: 'b-win', user_id: 'sam' }],
    actions: [{ id: 'act-book', title: 'Book: Osaka Airbnb', assigned_to: 'sam', deadline_kind: 'fixed', due_date: '2026-12-01', completed_at: null, section_id: null }],
  }),
  decidedBooked: snap({
    sections: [decidedStay({ decided_option_id: 'b-win' }, 'booked')],
    votes: [{ option_id: 'b-win', user_id: 'sam' }],
    bookings: [{ option_id: 'b-win', status: 'reserved' }],
  }),
  ownPastDeadline: snap({ sections: [question('own', 'Ski rental', { metadata: { decision_shape: 'personal' }, vote_deadline: PAST })] }),
  // Finished, money owed, one payment awaiting confirmation.
  sicily: snap({
    trip: { ...baseTrip, id: 'sicily', status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08' },
    balances: { tim: 5000, sam: -4698.61, chai: -301.39, out: -50 },
    settlements: [
      { id: 'st1', from_user_id: 'chai', to_user_id: 'tim', amount: 301.39, currency: 'GBP', status: 'suggested' },
      { id: 'st2', from_user_id: 'ana', to_user_id: 'tim', amount: 10, currency: 'GBP', status: 'marked_paid' },
    ],
  }),
  // A payment the receiver says has not arrived: the payer responds, the receiver owes nothing.
  // (A stale flag on a suggested row must change nothing.)
  disputed: snap({
    trip: { ...baseTrip, id: 'disp', status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08' },
    balances: { tim: 5000, sam: -4698.61, chai: -301.39 },
    settlements: [
      { id: 'd1', from_user_id: 'sam', to_user_id: 'tim', amount: 4698.61, currency: 'GBP', status: 'marked_paid', receipt_disputed_at: new Date(NOW.getTime() - 3_600_000).toISOString() },
      { id: 'd2', from_user_id: 'chai', to_user_id: 'tim', amount: 301.39, currency: 'GBP', status: 'suggested', receipt_disputed_at: new Date(NOW.getTime() - 3_600_000).toISOString() },
    ],
  }),
}

describe('one count on every surface', () => {
  for (const [name, s] of Object.entries(FIXTURES)) {
    it(`${name}: header pill = Today list = dashboard badge = Waiting on row, for every person`, () => {
      const waitingOn = computeWaitingOn(s, NOW)
      for (const p of s.participants) {
        const header = todoSurfaceCore(s, p.user_id, NOW)
        const todayExpanded = todayListModel(header.todos, true)
        const todayCollapsed = todayListModel(header.todos, false)
        const badge = tripCardBadgeCount(s, p.user_id, NOW)
        const row = waitingOn.byPerson.find((r) => r.userId === p.user_id)

        expect(header.count).toBe(header.todos.length)
        // Today lists every to-do once expanded; collapsing only hides rows behind "See all (n)".
        expect(todayExpanded.total).toBe(header.count)
        expect(todayExpanded.shownPersonal.length + todayExpanded.organiser.length).toBe(header.count)
        expect(todayCollapsed.total).toBe(header.count)
        if (todayCollapsed.seeAllCount != null) expect(todayCollapsed.seeAllCount).toBe(todayCollapsed.personal.length)
        expect(badge).toBe(header.count)
        expect(row?.count ?? 0).toBe(header.count)
        expect(waitingOn.byUser.get(p.user_id) ?? []).toEqual(header.todos)
        expect(todoCountLabel(badge ?? 0)).toBe(todoCountLabel(header.count ?? 0))
      }
      expect(waitingOn.totalTodos).toBe(waitingOn.byPerson.reduce((n, r) => n + r.count, 0))
    })
  }

  it('the fixtures are not trivially empty', () => {
    const total = (s: TripSnapshot) => s.participants.reduce((n, p) => n + (todoSurfaceCore(s, p.user_id, NOW).count ?? 0), 0)
    expect(total(FIXTURES.japow)).toBeGreaterThan(10)
    expect(total(FIXTURES.sicily)).toBeGreaterThan(0)
    // Someone with more than five personal rows exercises the "See all" path.
    expect(todayListModel(todoSurfaceCore(FIXTURES.japow, 'chai', NOW).todos, false).seeAllCount).not.toBeNull()
  })

  it('disputed: payer is asked to respond, receiver is not asked to confirm, organiser sees it under the payer', () => {
    const s = FIXTURES.disputed
    expect(todoSurfaceCore(s, 'sam', NOW).todos.map((t) => t.kind)).toEqual(['respond_payment'])
    expect(todoSurfaceCore(s, 'tim', NOW).todos.map((t) => t.kind)).not.toContain('confirm_payment')
    expect(todoSurfaceCore(s, 'chai', NOW).todos.map((t) => t.kind)).not.toContain('respond_payment')
    const wo = computeWaitingOn(s, NOW)
    expect(wo.byPerson.find((r) => r.userId === 'sam')?.todos[0]).toMatchObject({ kind: 'respond_payment', title: "Tim says your £4,698.61 hasn't arrived" })
  })

  it('loading (no snapshot) or nobody signed in shows no count at all, never 0', () => {
    expect(todoSurfaceCore(null, 'sam', NOW)).toEqual({ todos: [], count: undefined, hasOverdue: false, info: [] })
    expect(todoSurfaceCore(FIXTURES.japow, null, NOW).count).toBeUndefined()
    expect(tripCardBadgeCount(null, 'sam', NOW)).toBeUndefined()
  })

  it('blocked items are info, not to-dos: never counted on any surface', () => {
    const s = FIXTURES.unfrozen
    const sam = todoSurfaceCore(s, 'sam', NOW)
    expect(sam.count).toBe(0)
    expect(sam.info).toHaveLength(1)
    expect(tripCardBadgeCount(s, 'sam', NOW)).toBe(0)
    expect(computeWaitingOn(s, NOW).byPerson.map((p) => p.userId)).toEqual(['tim'])
    expect(todoSurfaceCore(s, 'tim', NOW).count).toBe(1)
  })
})

/**
 * Today's "Your to-dos" (the engine) and the To-dos sheet's "Yours" group
 * (todoModel) are built by different code, so pin that they agree for the
 * task-type items, including Anyone items (unclaimed = nobody's, claimed = the
 * claimer's), Everyone items and a "No preference"/"None for me" pass that
 * ticks a linked to-do.
 */
describe('Today count = the To-dos sheet "Yours" group, for task-type items', () => {
  const act = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: id,
    assigned_to: null as string | null,
    who_mode: null as string | null,
    deadline_kind: 'fixed',
    due_date: '2026-12-01' as string | null,
    completed_at: null as string | null,
    section_id: null as string | null,
    trip_action_completions: [] as Array<{ user_id: string }>,
    ...over,
  })
  const trip = snap({
    sections: [question('q1', 'Where to eat'), question('q2', 'Ski rental', { metadata: { decision_shape: 'personal' } })],
    votes: [{ option_id: 'q1-a', user_id: 'sam' }],
    passes: [{ section_id: 'q2', user_id: 'ana', kind: 'none_for_me' }],
    actions: [
      act('everyone'),
      act('everyone-undated', { due_date: null }),
      act('everyone-ticked-by-sam', { trip_action_completions: [{ user_id: 'sam' }] }),
      act('person-sam', { assigned_to: 'sam' }),
      act('person-sam-done', { assigned_to: 'sam', completed_at: '2026-11-01T00:00:00Z' }),
      act('anyone-unclaimed', { who_mode: 'anyone' }),
      act('anyone-claimed-sam', { who_mode: 'anyone', assigned_to: 'sam' }),
      act('anyone-claimed-tim', { who_mode: 'anyone', assigned_to: 'tim', due_date: null }),
      act('linked-to-q1', { section_id: 'q1' }),
      act('linked-to-q2', { section_id: 'q2' }),
    ],
    checklists: [
      { id: 'bring-unclaimed', title: 'Speaker', assigned_to: null, done: false },
      { id: 'bring-sam', title: 'Charger', assigned_to: 'sam', done: false },
      { id: 'bring-sam-done', title: 'Tent', assigned_to: 'sam', done: true },
    ],
  })

  const yoursFor = (userId: string) => {
    const sectionVoters = buildAnsweredSectionVoters(trip.sections as never, { votes: trip.votes as never, passes: trip.passes as never })
    const views = buildTodoViews({
      actions: trip.actions as unknown as ActionWithCompletions[],
      checklists: trip.checklists.map((c) => ({ ...c, created_by: 'tim' })),
      participants: trip.participants.map((p) => ({ user_id: p.user_id, active: p.active, confirmation_status: p.confirmation_status })),
      userId,
      trip: { start_date: trip.trip.start_date },
      sectionVoters,
      closedSectionIds: new Set(),
      finished: false,
    })
    const me = trip.participants.find((p) => p.user_id === userId)
    const inScope = !!me && me.active !== false && me.confirmation_status !== 'declined' && me.confirmation_status !== 'cancelled'
    return groupTodos(views, { userId, finished: false, viewerInScope: inScope })
  }

  for (const id of ['tim', 'sam', 'chai', 'ana']) {
    it(`${id}: task to-dos on Today equal the sheet's Yours group`, () => {
      const tasks = todoSurfaceCore(trip, id, NOW).todos.filter((t) => t.kind === 'task')
      const yours = yoursFor(id).yours
      expect(tasks.map((t) => t.entityId).sort()).toEqual(yours.map((v) => v.id).sort())
    })
  }

  it('unclaimed Anyone items are nobody\'s to-do; claimed ones count for the claimer only', () => {
    const ids = (u: string) => todoSurfaceCore(trip, u, NOW).todos.filter((t) => t.kind === 'task').map((t) => t.entityId)
    for (const u of ['tim', 'sam', 'chai', 'ana']) expect(ids(u)).not.toContain('anyone-unclaimed')
    expect(ids('sam')).toContain('anyone-claimed-sam')
    expect(ids('tim')).not.toContain('anyone-claimed-sam')
    expect(ids('tim')).toContain('anyone-claimed-tim')
    // Everyone items still land on every in-scope person, a pass ticks the linked one.
    expect(ids('chai')).toContain('everyone')
    expect(ids('ana')).not.toContain('linked-to-q2')
    expect(ids('chai')).toContain('linked-to-q2')
  })

  it('Waiting on shows done/total only for Everyone to-dos, never for Anyone items', () => {
    const w = computeWaitingOn(trip, NOW)
    const everyone = w.byItem.find((i) => i.entityId === 'everyone')
    const claimed = w.byItem.find((i) => i.entityId === 'anyone-claimed-sam')
    expect(everyone?.total).toBeGreaterThan(0)
    expect(claimed?.total).toBeUndefined()
    expect(w.byItem.some((i) => i.entityId === 'anyone-unclaimed')).toBe(false)
  })
})

describe('organiser lifecycle fixtures (decide / tie / book / close answers)', () => {
  const org = (key: string, uid = 'tim') => todoSurfaceCore(FIXTURES[key], uid, NOW).todos.filter((t) => t.group === 'organiser').map((t) => `${t.kind}:${t.link}`)

  it('deadline passed with a clear leader -> Decide; with a tie -> Tie (never both)', () => {
    expect(org('deadlineLeader')).toEqual(['org_decide:?open=decide:d'])
    expect(org('deadlineTie')).toEqual(['org_tie:?open=decide:d'])
  })

  it('decided with a real Book to-do: no synthetic duplicate; the assignee sees ONE task; Waiting on has no org_book', () => {
    expect(org('decidedRealBook')).toEqual([])
    expect(todoSurfaceCore(FIXTURES.decidedRealBook, 'sam', NOW).todos.map((t) => t.id)).toEqual(['task:act-book'])
    expect(computeWaitingOn(FIXTURES.decidedRealBook, NOW).byItem.some((i) => i.kind === 'org_book')).toBe(false)
  })

  it('decided + booked: no Book to-do for anyone', () => {
    expect(org('decidedBooked')).toEqual([])
    for (const p of crew) expect(todoSurfaceCore(FIXTURES.decidedBooked, p.user_id, NOW).todos.filter((t) => t.title.startsWith('Book:'))).toEqual([])
  })

  it('own-choice past its deadline: the organiser gets "Close answers", participants only their own pick', () => {
    const t = todoSurfaceCore(FIXTURES.ownPastDeadline, 'tim', NOW).todos
    expect(t.filter((x) => x.group === 'organiser').map((x) => x.title)).toEqual(['Close answers for Ski rental'])
    expect(todoSurfaceCore(FIXTURES.ownPastDeadline, 'sam', NOW).todos.map((x) => x.kind)).toEqual(['answer'])
  })

  it('the Today organiser card says what to do about it, and calls the tie out', () => {
    const s = FIXTURES.deadlineTie
    const summary = buildOrganiserSummary(computeWaitingOn(s, NOW), 'tim', todoSurfaceCore(s, 'tim', NOW).todos)
    expect(summary.headline).toContain('1 tied')
    expect(summary.lines[0]).toBe('Tie: choose a winner for Where to stay — any organizer can do this (1)')
    const leader = buildOrganiserSummary(computeWaitingOn(FIXTURES.deadlineLeader, NOW), 'tim', todoSurfaceCore(FIXTURES.deadlineLeader, 'tim', NOW).todos)
    expect(leader.headline).toContain('1 to decide')
    expect(leader.lines[0]).toBe('Decide: Where to stay — any organizer can do this (1)')
  })

  it('decided by anyone (or the auto-decide job) clears the Decide / Tie to-do on every surface', () => {
    const decided = { ...FIXTURES.deadlineTie, sections: [{ ...FIXTURES.deadlineTie.sections[0], status: 'completed', metadata: { decided_option_id: 'd-a' } }] }
    expect(todoSurfaceCore(decided, 'tim', NOW).todos.some((t) => t.kind === 'org_tie' || t.kind === 'org_decide')).toBe(false)
    expect(computeWaitingOn(decided, NOW).byItem.some((i) => i.kind === 'org_tie' || i.kind === 'org_decide')).toBe(false)
  })
})

describe('blocked money: the freeze to-do is the organiser\'s, never the people it unblocks', () => {
  it('only organisers hold it, on every surface (By person, By item, Today list)', () => {
    const s = FIXTURES.unfrozen
    const organisers = new Set(s.participants.filter((p) => p.role === 'organizer').map((p) => p.user_id))
    const w = computeWaitingOn(s, NOW)
    for (const row of w.byPerson) {
      const hasFreeze = row.todos.some((t) => t.id === 'org_setup:freeze')
      expect(hasFreeze).toBe(organisers.has(row.userId))
    }
    const item = w.byItem.find((i) => i.id === 'org_setup:' + `${s.trip.id}:freeze`)
    expect(item).toBeDefined()
    expect(item!.userIds.every((id) => organisers.has(id))).toBe(true)
    expect(item!.unblocks).toBeGreaterThan(0)
    // The people it unblocks get an info line, not a to-do, and are not counted.
    for (const p of s.participants.filter((x) => !organisers.has(x.user_id))) {
      expect(todoSurfaceCore(s, p.user_id, NOW).todos.some((t) => t.id === 'org_setup:freeze')).toBe(false)
    }
  })
})
