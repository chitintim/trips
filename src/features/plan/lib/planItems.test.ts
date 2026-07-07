import { describe, it, expect } from 'vitest'
import {
  composePlanItems,
  groupPlanItemsByDate,
  getUndatedItems,
  groupUndatedBySection,
  getOpenVotables,
  type ComposePlanItemsInput,
} from './planItems'
import type { TimelineEvent } from '../../../types'
import type { SectionWithOptions, OptionVote, OptionWithSelections } from '../../../lib/queries/usePlanning'
import type { Booking } from '../../../lib/queries/useBookings'

function event(overrides: Partial<TimelineEvent> & { id: string; event_date: string; title: string }): TimelineEvent {
  return {
    trip_id: 'trip-1',
    category: 'other',
    created_by: 'user-1',
    created_at: null,
    updated_at: null,
    description: null,
    end_time: null,
    location: null,
    metadata: null,
    participant_ids: null,
    place_id: null,
    sort_order: 0,
    source_option_id: null,
    start_time: null,
    all_day: false,
    ...overrides,
  }
}

function option(overrides: Partial<OptionWithSelections> & { id: string; section_id: string; title: string }): OptionWithSelections {
  return {
    created_at: '',
    updated_at: '',
    currency: null,
    description: null,
    locked: false,
    metadata: null,
    order_index: 0,
    place_id: null,
    price: null,
    price_type: 'per_person_fixed',
    status: 'available',
    selections: [],
    ...overrides,
  }
}

function section(overrides: Partial<SectionWithOptions> & { id: string; title: string; options: OptionWithSelections[] }): SectionWithOptions {
  return {
    trip_id: 'trip-1',
    created_at: '',
    updated_at: '',
    allow_multiple_selections: false,
    description: null,
    hide_votes_until_close: true,
    metadata: null,
    order_index: 0,
    quorum: null,
    section_type: 'activities',
    status: 'in_progress',
    vote_deadline: null,
    voting_method: 'single',
    ...overrides,
  }
}

function vote(overrides: Partial<OptionVote> & { option_id: string; user_id: string }): OptionVote {
  return { id: `${overrides.option_id}-${overrides.user_id}`, rank: null, created_at: new Date().toISOString(), ...overrides }
}

function booking(overrides: Partial<Booking> & { id: string; title: string }): Booking {
  return {
    trip_id: 'trip-1',
    booked_by: 'user-1',
    amount: null,
    booking_date: null,
    cancellation_deadline: null,
    confirmation_ref: null,
    created_at: '',
    updated_at: '',
    currency: null,
    document_url: null,
    expense_id: null,
    notes: null,
    option_id: null,
    place_id: null,
    refundable: null,
    status: 'reserved',
    timeline_event_id: null,
    vendor: null,
    ...overrides,
  }
}

const BASE_INPUT: ComposePlanItemsInput = {
  events: [],
  sections: [],
  votes: [],
  bookings: [],
  confirmedCount: 4,
  currentUserId: 'user-1',
}

describe('composePlanItems', () => {
  it('makes a plain timeline event "decided"', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      events: [event({ id: 'e1', event_date: '2026-08-01', title: 'Dinner' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ stage: 'decided', idKind: 'event', title: 'Dinner', date: '2026-08-01' })
  })

  it('makes a timeline event "booked" when a booking references it', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      events: [event({ id: 'e1', event_date: '2026-08-01', title: 'Chalet' })],
      bookings: [booking({ id: 'b1', title: 'Chalet booking', timeline_event_id: 'e1', expense_id: 'exp-1' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].stage).toBe('booked')
    expect(items[0].bookingId).toBe('b1')
    expect(items[0].expenseId).toBe('exp-1')
    expect(items[0].booking?.status).toBe('reserved')
  })

  it('marks an option in an open, voted-on section as a "proposal", undated by default', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          status: 'in_progress',
          options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ stage: 'proposal', idKind: 'option', date: null })
    expect(items[0].vote).toMatchObject({ totalVotes: 1, votingMethod: 'single' })
  })

  it('marks an option in a not-started, unvoted section as an "idea"', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Someday ideas',
          status: 'not_started',
          options: [option({ id: 'o1', section_id: 's1', title: 'Maybe a hike' })],
        }),
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0].stage).toBe('idea')
    expect(items[0].vote).toBeNull()
  })

  it('an option absorbed by an event (source_option_id) does not render twice', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      events: [event({ id: 'e1', event_date: '2026-08-02', title: 'Chalet A', source_option_id: 'o1' })],
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          status: 'completed',
          options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    // Only the event should appear — the winning option must not also
    // produce a standalone proposal/decided card.
    expect(items).toHaveLength(1)
    expect(items[0].idKind).toBe('event')
    expect(items[0].optionId).toBe('o1')
  })

  it('cancelled options never produce a plan item', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [option({ id: 'o1', section_id: 's1', title: 'Rejected chalet', status: 'cancelled' })],
        }),
      ],
    })
    expect(items).toHaveLength(0)
  })

  it('enriches an option with a booking without duplicating it', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })],
        }),
      ],
      bookings: [booking({ id: 'b1', title: 'Chalet A booking', option_id: 'o1', vendor: 'Booking.com' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].stage).toBe('booked')
    expect(items[0].booking?.vendor).toBe('Booking.com')
  })

  it('reads a proposed date from option metadata, overriding section metadata', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Activities',
          options: [
            option({
              id: 'o1',
              section_id: 's1',
              title: 'Museum trip',
              metadata: { proposed_date: '2026-08-05', proposed_start_time: '14:00' } as never,
            }),
          ],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    expect(items[0].date).toBe('2026-08-05')
    expect(items[0].startTime).toBe('14:00')
  })

  it('computes cost impact per person for total_split options', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      confirmedCount: 4,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [
            option({ id: 'o1', section_id: 's1', title: 'Chalet A', price: 400, currency: 'GBP', price_type: 'total_split' }),
          ],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    expect(items[0].costImpact).toEqual({ perPerson: 100, currency: 'GBP', isTiered: false, sensitivityLine: null })
  })

  it('is tier-aware when an option carries price_tiers metadata (UX_REDESIGN.md Part 5 shape 3)', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      confirmedCount: 9,
      sections: [
        section({
          id: 's1',
          title: 'Chalet',
          options: [
            option({
              id: 'o1',
              section_id: 's1',
              title: 'Chalet A',
              currency: 'GBP',
              price_type: 'total_split',
              metadata: { price_tiers: [{ max_people: 6, total: 300 }, { max_people: 12, total: 450 }] } as never,
            }),
          ],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    expect(items[0].costImpact).toEqual({
      perPerson: 50,
      currency: 'GBP',
      isTiered: true,
      sensitivityLine: '£50/pp if 6 · £37.50/pp if 12',
    })
  })

  it('never sets vote on options under a personal-order (shape 2) section, even with in_progress status', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Ski rental',
          status: 'in_progress',
          metadata: { decision_shape: 'personal' } as never,
          options: [option({ id: 'o1', section_id: 's1', title: 'Skis' })],
        }),
      ],
    })
    expect(items[0].vote).toBeNull()
    expect(items[0].isPersonalOrder).toBe(true)
    expect(items[0].stage).toBe('proposal')
  })

  it('marks options under an ordinary vote section as isPersonalOrder: false', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [section({ id: 's1', title: 'Accommodation', options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })] })],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' })],
    })
    expect(items[0].isPersonalOrder).toBe(false)
    expect(items[0].vote).not.toBeNull()
  })

  it('flags the winning option as an unscheduled winner when no event has claimed it yet', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [
            option({ id: 'o1', section_id: 's1', title: 'Chalet A' }),
            option({ id: 'o2', section_id: 's1', title: 'Chalet B' }),
          ],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-1' }), vote({ option_id: 'o1', user_id: 'user-2' }), vote({ option_id: 'o2', user_id: 'user-3' })],
    })
    const winnerItem = items.find((i) => i.id === 'o1')
    const loserItem = items.find((i) => i.id === 'o2')
    expect(winnerItem?.isUnscheduledWinner).toBe(true)
    expect(loserItem?.isUnscheduledWinner).toBe(false)
  })

  it('reports my vote (voted + rank) for the current user', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      currentUserId: 'user-1',
      sections: [
        section({
          id: 's1',
          title: 'Activities',
          voting_method: 'ranked',
          options: [option({ id: 'o1', section_id: 's1', title: 'Hike' })],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-1', rank: 2 })],
    })
    expect(items[0].vote?.myVote).toEqual({ voted: true, rank: 2 })
  })

  it('collects bookings that reference neither an option nor an event as unlinked', () => {
    const { items, unlinkedBookings } = composePlanItems({
      ...BASE_INPUT,
      bookings: [booking({ id: 'b1', title: 'Standalone insurance' })],
    })
    expect(items).toHaveLength(0)
    expect(unlinkedBookings).toHaveLength(1)
    expect(unlinkedBookings[0].id).toBe('b1')
  })
})

describe('groupPlanItemsByDate', () => {
  it('groups by date and time-orders each day, ignoring undated items', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      events: [
        event({ id: 'e1', event_date: '2026-08-01', title: 'Late lunch', start_time: '13:00' }),
        event({ id: 'e2', event_date: '2026-08-01', title: 'Breakfast', start_time: '08:00' }),
      ],
      sections: [
        section({
          id: 's1',
          title: 'Ideas',
          status: 'not_started',
          options: [option({ id: 'o1', section_id: 's1', title: 'Undated idea' })],
        }),
      ],
    })
    const byDate = groupPlanItemsByDate(items)
    expect(byDate.size).toBe(1)
    const day = byDate.get('2026-08-01')!
    expect(day.map((i) => i.title)).toEqual(['Breakfast', 'Late lunch'])
  })
})

describe('getUndatedItems / groupUndatedBySection', () => {
  it('separates undated proposals into the tray, grouped by section', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({ id: 's1', title: 'Accommodation', options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })] }),
        section({ id: 's2', title: 'Flights', options: [option({ id: 'o2', section_id: 's2', title: 'BA flight' })] }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' }), vote({ option_id: 'o2', user_id: 'user-2' })],
    })
    const undated = getUndatedItems(items)
    expect(undated).toHaveLength(2)
    const grouped = groupUndatedBySection(items)
    expect(grouped.size).toBe(2)
    expect(grouped.get('s1')?.[0].title).toBe('Chalet A')
    expect(grouped.get('s2')?.[0].title).toBe('BA flight')
  })
})

describe('getOpenVotables', () => {
  it('returns only proposals with a vote summary, sorted by deadline (nulls last)', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          vote_deadline: '2026-08-10T00:00:00Z',
          options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A' })],
        }),
        section({
          id: 's2',
          title: 'Flights',
          vote_deadline: null,
          options: [option({ id: 'o2', section_id: 's2', title: 'BA flight' })],
        }),
        section({
          id: 's3',
          title: 'Dining',
          vote_deadline: '2026-08-05T00:00:00Z',
          options: [option({ id: 'o3', section_id: 's3', title: 'Ramen spot' })],
        }),
        section({
          id: 's4',
          title: 'Ideas',
          status: 'not_started',
          options: [option({ id: 'o4', section_id: 's4', title: 'Idea only' })],
        }),
      ],
      votes: [vote({ option_id: 'o1', user_id: 'user-2' }), vote({ option_id: 'o2', user_id: 'user-2' }), vote({ option_id: 'o3', user_id: 'user-2' })],
    })
    const votables = getOpenVotables(items)
    expect(votables.map((v) => v.title)).toEqual(['Ramen spot', 'Chalet A', 'BA flight'])
  })
})
