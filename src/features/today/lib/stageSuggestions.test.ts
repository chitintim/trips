import { describe, it, expect } from 'vitest'
import { computeStageSuggestion } from './stageSuggestions'
import type { StageSuggestionInput } from './stageSuggestions'
import { rsvpStanding, tripPlaces, type RsvpStanding, type RsvpPersonInput } from '../../people/lib/rsvpStanding'

const NOW = new Date(2026, 10, 16, 12, 0, 0)

/** Standings for a roster of [status, extra] on a tracked trip with the given capacity/deadline. */
function standingsFor(
  roster: Array<[string | null, Partial<RsvpPersonInput>?]>,
  opts: { capacity?: number | null; deadline?: string | null } = {}
): RsvpStanding[] {
  const trip = { confirmation_enabled: true, confirmation_deadline: opts.deadline ?? null, capacity_limit: opts.capacity ?? null }
  const people: RsvpPersonInput[] = roster.map(([status, extra], i) => ({
    user_id: `u${i}`,
    active: true,
    confirmation_status: status,
    ...extra,
  }))
  const places = tripPlaces(trip, people)
  return people.map((person) =>
    rsvpStanding({ trip, stage: 'confirming_participants', person, places, today: '2026-11-16', now: NOW })
  )
}

const confirming = { storedStatus: 'confirming_participants', effectiveStage: 'confirming_participants' } as const

const base: StageSuggestionInput = {
  storedStatus: 'gathering_interest',
  effectiveStage: 'gathering_interest',
  confirmationEnabled: false,
  standings: [],
  bookingCount: 0,
}

describe('computeStageSuggestion', () => {
  it('suggests confirming_participants once RSVPs are enabled', () => {
    const s = computeStageSuggestion({ ...base, confirmationEnabled: true })
    expect(s?.to).toBe('confirming_participants')
    expect(s?.kind).toBe('advance')
  })

  it('stays quiet while gathering without confirmations', () => {
    expect(computeStageSuggestion(base)).toBeNull()
  })

  it('suggests booking_details when everyone answered (non-declined all confirmed)', () => {
    const s = computeStageSuggestion({ ...base, ...confirming, standings: standingsFor([['confirmed'], ['confirmed'], ['declined']]) })
    expect(s?.to).toBe('booking_details')
    expect(s?.detail).toBe('Everyone who is still in is going. Time to decide and book the details.')
  })

  it('does not suggest booking_details while someone can still answer before the deadline', () => {
    for (const straggler of ['pending', 'conditional', 'interested']) {
      const s = computeStageSuggestion({
        ...base,
        ...confirming,
        standings: standingsFor([['confirmed'], [straggler, { conditional_type: 'users' }]], { deadline: '2026-11-20T00:00:00.000Z' }),
      })
      expect(s).toBeNull()
    }
  })

  it('does not suggest booking_details when nobody is going', () => {
    expect(computeStageSuggestion({ ...base, ...confirming, standings: standingsFor([['declined'], ['cancelled']]) })).toBeNull()
  })

  it('is not held up by cancelled people, plain waitlisters or late replies', () => {
    const passed = '2026-11-14T00:00:00.000Z'
    const s = computeStageSuggestion({
      ...base,
      ...confirming,
      standings: standingsFor([['confirmed'], ['cancelled'], ['waitlist'], ['pending'], ['interested']], { capacity: 9, deadline: passed }),
    })
    expect(s?.to).toBe('booking_details')
  })

  it('is held up by a live waitlist offer', () => {
    const offer = { waitlist_offer_expires_at: new Date(NOW.getTime() + 3600_000).toISOString() }
    const s = computeStageSuggestion({
      ...base,
      ...confirming,
      standings: standingsFor([['confirmed'], ['waitlist', offer]], { capacity: 3 }),
    })
    expect(s).toBeNull()
  })

  it('is not held up by maybes when the trip is full, and says so', () => {
    const s = computeStageSuggestion({
      ...base,
      ...confirming,
      standings: standingsFor([['confirmed'], ['confirmed'], ['interested'], ['pending']], { capacity: 2 }),
    })
    expect(s?.to).toBe('booking_details')
    expect(s?.detail).toBe('Everyone with a place has answered. 2 not sure or not replied, but the trip is full.')
  })

  it('suggests booked_awaiting_departure after the first booking', () => {
    const s = computeStageSuggestion({
      ...base,
      storedStatus: 'booking_details',
      effectiveStage: 'booking_details',
      bookingCount: 1,
    })
    expect(s?.to).toBe('booked_awaiting_departure')
  })

  it('prefers the date-driven sync when the trip has started', () => {
    const s = computeStageSuggestion({
      ...base,
      storedStatus: 'booking_details',
      effectiveStage: 'trip_ongoing',
      bookingCount: 3,
    })
    expect(s?.to).toBe('trip_ongoing')
    expect(s?.kind).toBe('sync')
  })

  it('offers the completed sync when the dates are past', () => {
    const s = computeStageSuggestion({
      ...base,
      storedStatus: 'trip_ongoing',
      effectiveStage: 'trip_completed',
    })
    expect(s?.to).toBe('trip_completed')
    expect(s?.kind).toBe('sync')
    expect(s?.title).toMatch(/^Tidy up/)
    expect(s?.detail).toMatch(/already shown as finished/)
  })

  it('is silent when stored status already matches the effective stage endgame', () => {
    expect(
      computeStageSuggestion({ ...base, storedStatus: 'trip_completed', effectiveStage: 'trip_completed' })
    ).toBeNull()
  })
})
