import { describe, it, expect } from 'vitest'
import { computeCostBand } from './costBand'
import type { SectionWithOptions, OptionWithSelections, OptionVote, SelectionWithUser } from '../../../lib/queries/usePlanning'

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

function selection(overrides: Partial<SelectionWithUser> & { option_id: string; user_id: string }): SelectionWithUser {
  return {
    id: `${overrides.option_id}-${overrides.user_id}-sel`,
    selected_at: new Date().toISOString(),
    metadata: null,
    user: null as never,
    ...overrides,
  }
}

const TRIP = { estimated_accommodation_cost: null, accommodation_cost_currency: null }

describe('computeCostBand', () => {
  it('returns null with nothing to estimate from', () => {
    expect(computeCostBand(TRIP, [], [], 0)).toBeNull()
  })

  it('includes the accommodation estimate as a fixed low/high line', () => {
    const band = computeCostBand({ estimated_accommodation_cost: 500, accommodation_cost_currency: 'GBP' }, [], [], 4)
    expect(band).toEqual({
      low: 500,
      high: 500,
      currency: 'GBP',
      breakdown: [{ label: 'Accommodation (estimate)', amount: 500, currency: 'GBP' }],
    })
  })

  it('open vote section contributes a min/max spread across its active options', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Where are we staying?',
        options: [
          option({ id: 'o1', section_id: 's1', title: 'Hostel', price: 50, currency: 'GBP' }),
          option({ id: 'o2', section_id: 's1', title: 'Chalet', price: 150, currency: 'GBP' }),
        ],
      }),
    ]
    const band = computeCostBand(TRIP, sections, [], 4)
    expect(band!.low).toBe(50)
    expect(band!.high).toBe(150)
  })

  it('a decided (completed, with a winner) section contributes a single fixed figure, not a spread', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Where are we staying?',
        status: 'completed',
        options: [
          option({ id: 'o1', section_id: 's1', title: 'Hostel', price: 50, currency: 'GBP' }),
          option({ id: 'o2', section_id: 's1', title: 'Chalet', price: 150, currency: 'GBP' }),
        ],
      }),
    ]
    const votes = [vote({ option_id: 'o2', user_id: 'user-1' }), vote({ option_id: 'o2', user_id: 'user-2' })]
    const band = computeCostBand(TRIP, sections, votes, 4)
    expect(band!.low).toBe(150)
    expect(band!.high).toBe(150)
  })

  it('a completed section with no votes at all does not resolve a winner, so it still spreads', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Where are we staying?',
        status: 'completed',
        options: [
          option({ id: 'o1', section_id: 's1', title: 'Hostel', price: 50, currency: 'GBP' }),
          option({ id: 'o2', section_id: 's1', title: 'Chalet', price: 150, currency: 'GBP' }),
        ],
      }),
    ]
    const band = computeCostBand(TRIP, sections, [], 4)
    expect(band!.low).toBe(50)
    expect(band!.high).toBe(150)
  })

  it('is tier-aware for both the open spread and a decided winner', () => {
    const tieredOption = option({
      id: 'o1',
      section_id: 's1',
      title: 'Chalet A',
      currency: 'GBP',
      price_type: 'total_split',
      metadata: { price_tiers: [{ max_people: 6, total: 300 }, { max_people: 12, total: 450 }] } as never,
    })
    const openSections = [section({ id: 's1', title: 'Chalet', options: [tieredOption] })]
    const openBand = computeCostBand(TRIP, openSections, [], 9)
    expect(openBand!.low).toBe(50) // 450/9
    expect(openBand!.high).toBe(50)

    const decidedSections = [section({ id: 's1', title: 'Chalet', status: 'completed', options: [tieredOption] })]
    const decidedVotes = [vote({ option_id: 'o1', user_id: 'user-1' })]
    const decidedBand = computeCostBand(TRIP, decidedSections, decidedVotes, 9)
    expect(decidedBand!.low).toBe(50)
    expect(decidedBand!.high).toBe(50)
  })

  it('skips shape-2 (personal order) sections from the vote spread entirely', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Ski rental',
        metadata: { decision_shape: 'personal' } as never,
        options: [option({ id: 'o1', section_id: 's1', title: 'Skis', price: 999, currency: 'GBP' })],
      }),
    ]
    const band = computeCostBand(TRIP, sections, [], 4)
    expect(band).toBeNull() // nothing else to estimate from, and the personal section contributes nothing without a viewer order
  })

  it('folds the viewer\'s own personal-order total into low/high when same currency as the band', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Ski rental',
        metadata: { decision_shape: 'personal' } as never,
        options: [
          option({
            id: 'o1',
            section_id: 's1',
            title: 'Skis',
            currency: 'GBP',
            metadata: { pricing: { per_day: 10 } } as never,
            selections: [selection({ option_id: 'o1', user_id: 'me', metadata: { start_date: '2026-08-01', end_date: '2026-08-05', quantity: 1 } as never })],
          }),
        ],
      }),
    ]
    const band = computeCostBand(TRIP, sections, [], 4, 'me')
    expect(band!.low).toBe(50) // 10/day * 5 days
    expect(band!.high).toBe(50)
    expect(band!.breakdown).toContainEqual({ label: 'Your personal orders', amount: 50, currency: 'GBP' })
  })

  it('does not fold a different-viewer\'s selections into the total', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Ski rental',
        metadata: { decision_shape: 'personal' } as never,
        options: [
          option({
            id: 'o1',
            section_id: 's1',
            title: 'Skis',
            currency: 'GBP',
            metadata: { pricing: { flat: 40 } } as never,
            selections: [selection({ option_id: 'o1', user_id: 'someone-else' })],
          }),
        ],
      }),
    ]
    const band = computeCostBand(TRIP, sections, [], 4, 'me')
    expect(band).toBeNull()
  })

  it('adds a mismatched-currency personal order as a breakdown line without folding it into low/high', () => {
    const sections = [
      section({
        id: 's1',
        title: 'Ski rental',
        metadata: { decision_shape: 'personal' } as never,
        options: [
          option({
            id: 'o1',
            section_id: 's1',
            title: 'Skis',
            currency: 'EUR',
            metadata: { pricing: { flat: 40 } } as never,
            selections: [selection({ option_id: 'o1', user_id: 'me' })],
          }),
        ],
      }),
    ]
    const band = computeCostBand({ estimated_accommodation_cost: 500, accommodation_cost_currency: 'GBP' }, sections, [], 4, 'me')
    expect(band!.currency).toBe('GBP')
    expect(band!.low).toBe(500)
    expect(band!.high).toBe(500)
    expect(band!.breakdown).toContainEqual({ label: 'Your personal orders', amount: 40, currency: 'EUR' })
  })
})
