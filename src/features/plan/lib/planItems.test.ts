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

function selection(overrides: { id: string; option_id: string; user_id: string; metadata?: unknown }) {
  return {
    id: overrides.id,
    option_id: overrides.option_id,
    user_id: overrides.user_id,
    selected_at: '2026-01-01T00:00:00Z',
    metadata: overrides.metadata ?? null,
    user: { id: overrides.user_id, full_name: overrides.user_id, email: `${overrides.user_id}@example.com`, avatar_url: null, avatar_data: null } as never,
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

  it('marks an option "booked" when its own status is booked, even with no bookings-table row', () => {
    // Pre-v3 trips (20260707160000_legacy_sections_to_personal) never had a
    // `bookings` table — "we booked this" was recorded directly on the
    // option's own status column.
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [option({ id: 'o1', section_id: 's1', title: 'Chalet A', status: 'booked' })],
        }),
      ],
    })
    expect(items[0].stage).toBe('booked')
    expect(items[0].bookingId).toBeNull()
  })

  it('carries the option\'s selections onto the PlanItem regardless of stage', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      sections: [
        section({
          id: 's1',
          title: 'Accommodation',
          options: [
            option({
              id: 'o1',
              section_id: 's1',
              title: 'Chalet A',
              selections: [selection({ id: 'sel-1', option_id: 'o1', user_id: 'user-2' })] as never,
            }),
          ],
        }),
      ],
    })
    expect(items[0].selections).toHaveLength(1)
    expect(items[0].selections[0].user_id).toBe('user-2')
  })

  it('gives timeline events an empty selections array', () => {
    const { items } = composePlanItems({
      ...BASE_INPUT,
      events: [event({ id: 'e1', event_date: '2026-08-01', title: 'Dinner' })],
    })
    expect(items[0].selections).toEqual([])
  })

  describe('legacy Méribel-shaped trip (migrated to decision_shape: personal)', () => {
    // Real-data shapes from the user's Méribel trip, post
    // 20260707160000_legacy_sections_to_personal: every pre-v3 section gets
    // stamped decision_shape:'personal' (no heuristic in composePlanItems
    // itself — getDecisionShape reads the stamped metadata natively). No
    // vote_deadline anywhere, no option_votes anywhere, `selections` rows
    // carry no metadata (no order-form dates/variant/quantity existed in
    // the legacy app).
    const legacyMeta = { decision_shape: 'personal' as const, legacy_migrated: true }

    it('a single-select restaurant section with selections + one booked option: options stay "proposal" except the booked one, and every option keeps its selections for the avatar stack', () => {
      const restaurants = section({
        id: 'restaurants',
        title: 'Restaurants',
        status: 'completed',
        vote_deadline: null,
        allow_multiple_selections: false,
        metadata: legacyMeta as never,
        options: [
          option({
            id: 'r1',
            section_id: 'restaurants',
            title: 'Le Refuge',
            status: 'booked',
            selections: [
              selection({ id: 'sel-1', option_id: 'r1', user_id: 'alex' }),
              selection({ id: 'sel-2', option_id: 'r1', user_id: 'sarah' }),
            ] as never,
          }),
          option({
            id: 'r2',
            section_id: 'restaurants',
            title: 'La Fromagerie',
            selections: [selection({ id: 'sel-3', option_id: 'r2', user_id: 'jo' })] as never,
          }),
          option({
            id: 'r3',
            section_id: 'restaurants',
            title: 'Pizzeria (never picked)',
            selections: [],
          }),
        ],
      })
      const { items } = composePlanItems({ ...BASE_INPUT, sections: [restaurants] })

      const booked = items.find((i) => i.id === 'r1')!
      const picked = items.find((i) => i.id === 'r2')!
      const unpicked = items.find((i) => i.id === 'r3')!

      expect(booked.stage).toBe('booked')
      expect(booked.selections).toHaveLength(2)
      expect(booked.vote).toBeNull()
      expect(booked.isPersonalOrder).toBe(true)

      expect(picked.stage).toBe('proposal')
      expect(picked.selections).toHaveLength(1)
      expect(picked.vote).toBeNull()

      expect(unpicked.stage).toBe('proposal')
      expect(unpicked.selections).toHaveLength(0)
    })

    it('a multi-select ski rental section (with an opt-out option) never produces vote UI, and carries per-option selections for the "who picked what" tray expansion', () => {
      const skiRental = section({
        id: 'ski',
        title: 'Ski Equipment Rental',
        status: 'in_progress',
        vote_deadline: null,
        allow_multiple_selections: true,
        metadata: legacyMeta as never,
        options: [
          option({
            id: 'ski-adult',
            section_id: 'ski',
            title: 'Adult skis + boots',
            selections: [
              selection({ id: 's1', option_id: 'ski-adult', user_id: 'alex' }),
              selection({ id: 's2', option_id: 'ski-adult', user_id: 'sarah' }),
              selection({ id: 's3', option_id: 'ski-adult', user_id: 'jo' }),
            ] as never,
          }),
          option({
            id: 'ski-kids',
            section_id: 'ski',
            title: 'Kids skis',
            selections: [selection({ id: 's4', option_id: 'ski-kids', user_id: 'sam' })] as never,
          }),
          option({
            id: 'ski-own',
            section_id: 'ski',
            title: 'I have my own skis',
            selections: [selection({ id: 's5', option_id: 'ski-own', user_id: 'pat' })] as never,
          }),
        ],
      })
      const { items } = composePlanItems({ ...BASE_INPUT, sections: [skiRental] })

      expect(items.every((i) => i.isPersonalOrder)).toBe(true)
      expect(items.every((i) => i.vote === null)).toBe(true)
      expect(items.find((i) => i.id === 'ski-adult')?.selections).toHaveLength(3)
      expect(items.find((i) => i.id === 'ski-own')?.selections).toHaveLength(1)
    })

    it('zero open-questions: no legacy personal-shape option ever surfaces in getOpenVotables (no vote_deadline, no vote UI to chase)', () => {
      const restaurants = section({
        id: 'restaurants',
        title: 'Restaurants',
        vote_deadline: null,
        metadata: legacyMeta as never,
        options: [
          option({ id: 'r1', section_id: 'restaurants', title: 'Le Refuge', selections: [selection({ id: 'sel-1', option_id: 'r1', user_id: 'alex' })] as never }),
        ],
      })
      const skiRental = section({
        id: 'ski',
        title: 'Ski Equipment Rental',
        vote_deadline: null,
        allow_multiple_selections: true,
        metadata: legacyMeta as never,
        options: [
          option({ id: 'ski-adult', section_id: 'ski', title: 'Adult skis', selections: [selection({ id: 's1', option_id: 'ski-adult', user_id: 'alex' })] as never }),
        ],
      })
      const { items } = composePlanItems({ ...BASE_INPUT, sections: [restaurants, skiRental] })
      expect(getOpenVotables(items)).toHaveLength(0)
    })
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
