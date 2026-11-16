import { describe, expect, it } from 'vitest'
import { computeWaitingOn } from '../todos/computeTodos'
import { todoCountLabel } from '../todos/copy'
import type { SnapshotParticipant, SnapshotSection, SnapshotTrip, TripSnapshot } from '../todos/types'
import { todayListModel, todoSurfaceCore, tripCardBadgeCount } from './todoSurfaces'

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
  // Finished, money owed, one payment awaiting confirmation.
  sicily: snap({
    trip: { ...baseTrip, id: 'sicily', status: 'trip_completed', start_date: '2025-06-01', end_date: '2025-06-08' },
    balances: { tim: 5000, sam: -4698.61, chai: -301.39, out: -50 },
    settlements: [
      { id: 'st1', from_user_id: 'chai', to_user_id: 'tim', amount: 301.39, currency: 'GBP', status: 'suggested' },
      { id: 'st2', from_user_id: 'ana', to_user_id: 'tim', amount: 10, currency: 'GBP', status: 'marked_paid' },
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

  it('loading (no snapshot) or nobody signed in shows no count at all, never 0', () => {
    expect(todoSurfaceCore(null, 'sam', NOW)).toEqual({ todos: [], count: undefined, hasOverdue: false })
    expect(todoSurfaceCore(FIXTURES.japow, null, NOW).count).toBeUndefined()
    expect(tripCardBadgeCount(null, 'sam', NOW)).toBeUndefined()
  })
})
