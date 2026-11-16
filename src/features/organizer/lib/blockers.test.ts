import { describe, it, expect } from 'vitest'
import { computeBlockers, escalatedUserIds, lastRemindedByUser, todoToBlocker, type ComputeBlockersInput } from './blockers'
import { computeTodos } from '../../../lib/todos/computeTodos'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { Booking } from '../../../lib/queries/useBookings'
import type { Notification } from '../../../lib/queries/useNotifications'

const NOW = new Date('2026-07-06T12:00:00Z').getTime()

function participant(overrides: Partial<ParticipantWithUser> & { user_id: string }): ParticipantWithUser {
  return {
    id: `tp-${overrides.user_id}`,
    trip_id: 'trip-1',
    role: 'participant',
    active: true,
    confirmation_status: 'confirmed',
    conditional_date: null,
    conditional_type: null,
    conditional_user_ids: null,
    confirmation_note: null,
    confirmed_at: null,
    joined_at: '2026-01-01T00:00:00Z',
    waitlist_offer_expires_at: null,
    user: {
      id: overrides.user_id,
      full_name: `User ${overrides.user_id}`,
      email: `${overrides.user_id}@x.com`,
      avatar_data: null,
    } as ParticipantWithUser['user'],
    ...overrides,
  } as ParticipantWithUser
}

const baseTrip: NonNullable<ComputeBlockersInput['trip']> = {
  id: '',
  name: '',
  status: 'confirming_participants',
  start_date: '2099-01-01',
  end_date: '2099-01-02',
  confirmation_enabled: true,
  confirmation_deadline: null,
  base_currency: 'GBP',
}

function baseInput(overrides: Partial<ComputeBlockersInput> = {}): ComputeBlockersInput {
  return {
    participants: [],
    sections: [],
    votes: [],
    expenses: [],
    settlements: [],
    bookings: [],
    notifications: [],
    now: NOW,
    ...overrides,
  }
}

const question = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: `Question ${id}`,
    status: 'in_progress',
    vote_deadline: null,
    voting_method: 'single',
    metadata: null,
    options: [
      { id: `${id}-a`, title: 'A', status: 'available', selections: [] },
      { id: `${id}-b`, title: 'B', status: 'available', selections: [] },
    ],
    ...over,
  }) as unknown as SectionWithOptions

const byUser = (r: ReturnType<typeof computeBlockers>) => Object.fromEntries(r.people.map((p) => [p.userId, p.blockers]))

describe('computeBlockers (adapter over computeWaitingOn)', () => {
  it('is not empty when an open question has no deadline and someone has not answered (the old false all-clear)', () => {
    const result = computeBlockers(
      baseInput({
        participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' })],
        sections: [question('s1')],
        votes: [{ id: 'v1', option_id: 's1-a', user_id: 'a', rank: null, created_at: '' }] as OptionVote[],
      })
    )
    const people = byUser(result)
    expect(people['a']).toBeUndefined()
    expect(people['b']).toHaveLength(1)
    expect(people['b'][0].kind).toBe('unvoted_poll')
    expect(people['b'][0].entityId).toBeUndefined() // not a UUID: never sent as blocker_entity_id
    expect(result.todoCount).toBe(1)
  })

  it("each person's blockers equal that person's own to-dos", () => {
    const participants = [
      participant({ user_id: 'a' }),
      participant({ user_id: 'b', confirmation_status: 'pending' }),
      participant({ user_id: 'c' }),
    ]
    const sections = [question('s1'), question('s2')]
    const votes = [{ id: 'v1', option_id: 's1-a', user_id: 'a', rank: null, created_at: '' }] as OptionVote[]
    const settlements = [
      { id: 'p1', status: 'suggested', from_user_id: 'c', to_user_id: 'a', amount: 10, currency: 'GBP' },
    ] as unknown as Settlement[]
    const input = baseInput({ participants, sections, votes, settlements })
    const result = computeBlockers(input)
    for (const p of result.people) {
      const own = computeTodos(
        {
          trip: { id: '', name: '', status: 'confirming_participants', start_date: '2099-01-01', end_date: '2099-01-02', confirmation_enabled: true, confirmation_deadline: null, base_currency: 'GBP' },
          participants,
          sections,
          votes,
          actions: [],
          checklists: [],
          expenses: [],
          settlements,
          travelEvents: [],
          bookings: [],
        },
        p.userId,
        new Date(NOW)
      ).filter((t) => t.group === 'personal')
      expect(p.blockers.map((b) => b.label)).toEqual(own.map((t) => t.title))
    }
  })

  it('does not count declined or cancelled people, or closed questions', () => {
    const result = computeBlockers(
      baseInput({
        participants: [
          participant({ user_id: 'a', confirmation_status: 'declined' }),
          participant({ user_id: 'b', confirmation_status: 'cancelled' }),
          participant({ user_id: 'c' }),
        ],
        sections: [question('s1', { status: 'completed' })],
      })
    )
    expect(result.todoCount).toBe(0)
    expect(result.people).toEqual([])
  })

  it('reports pending replies, with an RSVP nudge type', () => {
    const result = computeBlockers(baseInput({ participants: [participant({ user_id: 'a', confirmation_status: 'pending' })] }))
    const [b] = byUser(result)['a']
    expect(b.kind).toBe('pending_rsvp')
    expect(b.nudgeType).toBe('pending_rsvp')
  })

  it('hides RSVP to-dos when the trip does not track confirmation', () => {
    const result = computeBlockers(
      baseInput({ participants: [participant({ user_id: 'a', confirmation_status: 'pending' })], confirmationEnabled: false })
    )
    expect(result.todoCount).toBe(0)
  })

  it('chases unclaimed itemized receipts per tagged participant, skipping the payer and claimants', () => {
    const expenses = [
      {
        id: 'e1',
        description: 'Izakaya',
        amount: 90,
        currency: 'JPY',
        ai_parsed: true,
        status: 'partially_allocated',
        paid_by: 'a',
        participant_ids: ['a', 'b', 'c'],
        claims: [{ user_id: 'b' }],
        allocation_link: { code: 'abc123' },
      },
    ] as unknown as ExpenseWithDetails[]
    const result = computeBlockers(
      baseInput({ participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' }), participant({ user_id: 'c' })], expenses })
    )
    expect(result.people.flatMap((p) => p.blockers.map((b) => `${p.userId}:${b.kind}`))).toEqual(['c:unclaimed_items'])
  })

  it('assigns payment to-dos to the payer (suggested) and the recipient (marked paid)', () => {
    const settlements = [
      { id: 's1', status: 'suggested', from_user_id: 'a', to_user_id: 'b', amount: 10, currency: 'GBP' },
      { id: 's2', status: 'marked_paid', from_user_id: 'a', to_user_id: 'b', amount: 5, currency: 'GBP' },
      { id: 's3', status: 'confirmed', from_user_id: 'a', to_user_id: 'b', amount: 5, currency: 'GBP' },
    ] as unknown as Settlement[]
    const result = computeBlockers(baseInput({
        participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' })],
        settlements,
        // Per-payment rows only exist once balances are frozen.
        trip: { ...baseTrip, settlement_snapshot: { frozen: true } as never },
      }))
    const people = byUser(result)
    expect(people['a'].map((b) => b.nudgeType)).toEqual(['unpaid_settlement'])
    expect(people['b'].map((b) => b.nudgeType)).toEqual(['unpaid_settlement'])
  })

  it('surfaces upcoming booking cancellation deadlines at trip level within the window only', () => {
    const bookings = [
      { id: 'b1', title: 'Chalet', status: 'reserved', booked_by: 'a', cancellation_deadline: '2026-07-09T00:00:00Z' },
      { id: 'b2', title: 'Far', status: 'reserved', booked_by: 'a', cancellation_deadline: '2026-09-01T00:00:00Z' },
      { id: 'b3', title: 'Past', status: 'reserved', booked_by: 'a', cancellation_deadline: '2026-07-01T00:00:00Z' },
      { id: 'b4', title: 'Cancelled', status: 'cancelled', booked_by: 'a', cancellation_deadline: '2026-07-09T00:00:00Z' },
    ] as unknown as Booking[]
    const result = computeBlockers(baseInput({ participants: [participant({ user_id: 'a' })], bookings }))
    expect(result.bookingDeadlines.map((b) => b.entityId)).toEqual(['b1'])
    expect(result.todoCount).toBe(0) // deadlines are not anyone's to-do
    expect(result.totalCount).toBe(1)
  })

  it('orders people by to-do count, most first', () => {
    const result = computeBlockers(
      baseInput({
        participants: [participant({ user_id: 'a', confirmation_status: 'pending' }), participant({ user_id: 'b', confirmation_status: 'pending' })],
        sections: [question('s1')],
        votes: [{ id: 'v1', option_id: 's1-a', user_id: 'a', rank: null, created_at: '' }] as OptionVote[],
      })
    )
    expect(result.people[0].userId).toBe('b') // 2 to-dos > 1
  })

  it('flags people auto-chase has given up on and records when they were last reminded', () => {
    const notifications = [
      { id: 'n1', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a', sent_at: '2026-07-01T00:00:00Z' },
      { id: 'n2', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a', sent_at: '2026-07-03T00:00:00Z' },
      { id: 'n3', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a', sent_at: '2026-07-02T00:00:00Z' },
    ] as unknown as Notification[]
    const result = computeBlockers(
      baseInput({ participants: [participant({ user_id: 'a', confirmation_status: 'pending' })], notifications, maxReminders: 3 })
    )
    expect(result.people[0].escalated).toBe(true)
    expect(result.people[0].lastRemindedAt).toBe('2026-07-03T00:00:00Z')
  })
})

describe('helpers', () => {
  it('escalatedUserIds needs maxReminders for the same kind+entity', () => {
    const n = (kind: string, entity_id: string, user_id: string) => ({ kind, entity_id, user_id })
    expect(escalatedUserIds([n('x', '1', 'a'), n('x', '2', 'a'), n('y', '1', 'a')], 3).size).toBe(0)
    expect([...escalatedUserIds([n('x', '1', 'a'), n('x', '1', 'a'), n('x', '1', 'a')], 3)]).toEqual(['a'])
  })

  it('lastRemindedByUser keeps the latest', () => {
    const m = lastRemindedByUser([
      { user_id: 'a', sent_at: '2026-07-01T00:00:00Z' },
      { user_id: 'a', sent_at: '2026-07-05T00:00:00Z' },
    ])
    expect(m.get('a')).toBe('2026-07-05T00:00:00Z')
  })

  it('todoToBlocker gives hand-written fallback (null nudge type) to tasks and organiser to-dos', () => {
    const base = { id: 'task:1', group: 'personal', userId: 'a', entityId: '1', title: 'Book the transfer', subtitle: null, actionLabel: 'Done', due: null, overdue: false, link: '?open=todo:1' } as const
    expect(todoToBlocker({ ...base, kind: 'task' }).nudgeType).toBeNull()
    expect(todoToBlocker({ ...base, kind: 'org_decide', group: 'organiser' }).kind).toBe('organiser')
  })
})
