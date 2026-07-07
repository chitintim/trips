import { describe, it, expect } from 'vitest'
import { computeStageSuggestion } from './stageSuggestions'
import type { StageSuggestionInput } from './stageSuggestions'

const base: StageSuggestionInput = {
  storedStatus: 'gathering_interest',
  effectiveStage: 'gathering_interest',
  confirmationEnabled: false,
  participantStatuses: [],
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
    const s = computeStageSuggestion({
      ...base,
      storedStatus: 'confirming_participants',
      effectiveStage: 'confirming_participants',
      participantStatuses: ['confirmed', 'confirmed', 'declined'],
    })
    expect(s?.to).toBe('booking_details')
  })

  it('does not suggest booking_details while someone is still pending/conditional', () => {
    for (const straggler of ['pending', 'conditional', 'interested', 'waitlist']) {
      const s = computeStageSuggestion({
        ...base,
        storedStatus: 'confirming_participants',
        effectiveStage: 'confirming_participants',
        participantStatuses: ['confirmed', straggler],
      })
      expect(s).toBeNull()
    }
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
  })

  it('is silent when stored status already matches the effective stage endgame', () => {
    expect(
      computeStageSuggestion({ ...base, storedStatus: 'trip_completed', effectiveStage: 'trip_completed' })
    ).toBeNull()
  })
})
