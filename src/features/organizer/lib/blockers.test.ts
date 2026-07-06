import { describe, it, expect } from 'vitest'
import { computeBlockers, type ComputeBlockersInput } from './blockers'
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

describe('computeBlockers', () => {
  it('surfaces pending RSVPs and arrived conditional-date promises', () => {
    const result = computeBlockers(
      baseInput({
        participants: [
          participant({ user_id: 'a', confirmation_status: 'pending' }),
          participant({ user_id: 'b', confirmation_status: 'conditional', conditional_date: '2026-07-01' }),
          participant({ user_id: 'c', confirmation_status: 'conditional', conditional_date: '2026-08-01' }),
          participant({ user_id: 'd', confirmation_status: 'confirmed' }),
        ],
      })
    )
    const kinds = result.people.flatMap((p) => p.blockers.map((b) => `${p.userId}:${b.kind}`))
    expect(kinds).toContain('a:pending_rsvp')
    expect(kinds).toContain('b:due_conditional')
    expect(kinds).not.toContain('c:due_conditional') // future promise not yet due
    expect(kinds.filter((k) => k.startsWith('d:'))).toHaveLength(0)
  })

  it('flags non-voters only on open deadline polls', () => {
    const sections = [
      {
        id: 's1',
        title: 'Saturday dinner',
        vote_deadline: '2026-07-10T00:00:00Z',
        options: [{ id: 'o1' }, { id: 'o2' }],
      },
      { id: 's2', title: 'Closed poll', vote_deadline: '2026-07-01T00:00:00Z', options: [{ id: 'o3' }] },
      { id: 's3', title: 'No deadline', vote_deadline: null, options: [{ id: 'o4' }] },
    ] as unknown as SectionWithOptions[]
    const votes = [{ id: 'v1', option_id: 'o1', user_id: 'a', rank: null, created_at: '' }] as OptionVote[]

    const result = computeBlockers(
      baseInput({
        participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' })],
        sections,
        votes,
      })
    )
    const byUser = Object.fromEntries(result.people.map((p) => [p.userId, p.blockers]))
    expect(byUser['a']).toBeUndefined() // voted on the only open deadline poll
    expect(byUser['b']).toHaveLength(1)
    expect(byUser['b'][0].kind).toBe('unvoted_poll')
    expect(byUser['b'][0].entityId).toBe('s1')
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
      },
    ] as unknown as ExpenseWithDetails[]

    const result = computeBlockers(
      baseInput({
        participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' }), participant({ user_id: 'c' })],
        expenses,
      })
    )
    const flat = result.people.flatMap((p) => p.blockers.map((b) => `${p.userId}:${b.kind}`))
    expect(flat).toEqual(['c:unclaimed_items'])
  })

  it('assigns settlement blockers to the payer (suggested) and recipient (marked_paid)', () => {
    const settlements = [
      { id: 's1', status: 'suggested', from_user_id: 'a', to_user_id: 'b', amount: 10, currency: 'GBP' },
      { id: 's2', status: 'marked_paid', from_user_id: 'a', to_user_id: 'b', amount: 5, currency: 'GBP' },
      { id: 's3', status: 'confirmed', from_user_id: 'a', to_user_id: 'b', amount: 5, currency: 'GBP' },
    ] as unknown as Settlement[]

    const result = computeBlockers(
      baseInput({ participants: [participant({ user_id: 'a' }), participant({ user_id: 'b' })], settlements })
    )
    const byUser = Object.fromEntries(result.people.map((p) => [p.userId, p.blockers]))
    expect(byUser['a'].map((b) => b.entityId)).toEqual(['s1'])
    expect(byUser['b'].map((b) => b.entityId)).toEqual(['s2'])
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
    expect(result.totalCount).toBe(1)
  })

  it('escalates loops with >= maxReminders notifications and maps the nudge type', () => {
    const notifications = [
      { id: 'n1', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a' },
      { id: 'n2', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a' },
      { id: 'n3', kind: 'unvoted_poll', entity_id: 's1', user_id: 'a' },
      { id: 'n4', kind: 'unvoted_poll', entity_id: 's2', user_id: 'a' },
    ] as unknown as Notification[]

    const result = computeBlockers(
      baseInput({ participants: [participant({ user_id: 'a' })], notifications, maxReminders: 3 })
    )
    const escalations = result.people[0].blockers.filter((b) => b.kind === 'escalation')
    expect(escalations).toHaveLength(1)
    expect(escalations[0].entityId).toBe('s1')
    expect(escalations[0].nudgeType).toBe('unvoted_poll')
  })

  it('surfaces unexpired waitlist offers and orders people by blocker count', () => {
    const result = computeBlockers(
      baseInput({
        participants: [
          participant({ user_id: 'a', confirmation_status: 'pending' }),
          participant({
            user_id: 'b',
            confirmation_status: 'pending',
            waitlist_offer_expires_at: '2026-07-07T12:00:00Z',
          }),
        ],
      })
    )
    expect(result.people[0].userId).toBe('b') // 2 blockers > 1
    expect(result.people[0].blockers.map((x) => x.kind)).toContain('expiring_waitlist_offer')
  })
})
