import { describe, it, expect } from 'vitest'
import { computeNightsWeights, nightsWeightsToWeightArray } from './nightsWeighting'
import { largestRemainderDistribute } from '../../../lib/money'
import type { TimelineEvent } from '../../../types'

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: overrides.id ?? Math.random().toString(36),
    trip_id: 'trip-1',
    title: 'Event',
    category: 'other',
    event_date: '2026-08-01',
    start_time: null,
    end_time: null,
    all_day: null,
    description: null,
    location: null,
    metadata: null,
    participant_ids: null,
    place_id: null,
    sort_order: null,
    source_option_id: null,
    created_by: 'user-1',
    created_at: null,
    updated_at: null,
    ...overrides,
  } as TimelineEvent
}

describe('computeNightsWeights', () => {
  const tripStart = '2026-08-01'
  const tripEnd = '2026-08-08' // 7-night trip

  it('falls back to full trip range when no arrival/departure events exist', () => {
    const results = computeNightsWeights(['alice', 'bob'], [], tripStart, tripEnd)
    expect(results).toEqual([
      { participantId: 'alice', nights: 7, derivedFromEvents: false },
      { participantId: 'bob', nights: 7, derivedFromEvents: false },
    ])
  })

  it('gives a late arriver fewer nights than someone there the whole trip', () => {
    const events: TimelineEvent[] = [
      makeEvent({
        title: 'Bob arrives',
        category: 'flight',
        event_date: '2026-08-04', // arrives day 4 -> 4 nights present (04,05,06,07)
        participant_ids: ['bob'],
      }),
    ]
    const results = computeNightsWeights(['alice', 'bob'], events, tripStart, tripEnd)
    const alice = results.find((r) => r.participantId === 'alice')!
    const bob = results.find((r) => r.participantId === 'bob')!

    expect(alice.nights).toBe(7)
    expect(alice.derivedFromEvents).toBe(false)
    expect(bob.nights).toBe(4)
    expect(bob.derivedFromEvents).toBe(true)
    expect(bob.nights).toBeLessThan(alice.nights)
  })

  it('gives an early leaver fewer nights via a departure event', () => {
    const events: TimelineEvent[] = [
      makeEvent({
        title: 'Early departure home',
        category: 'flight',
        event_date: '2026-08-05', // leaves day 5 -> present days 01-05 = 4 nights
        participant_ids: ['carol'],
      }),
    ]
    const results = computeNightsWeights(['carol'], events, tripStart, tripEnd)
    expect(results[0].nights).toBe(4)
    expect(results[0].derivedFromEvents).toBe(true)
  })

  it('handles both arrival and departure events for the same participant', () => {
    const events: TimelineEvent[] = [
      makeEvent({ title: 'Arrival', category: 'flight', event_date: '2026-08-02', participant_ids: ['dave'] }),
      makeEvent({ title: 'Departure', category: 'flight', event_date: '2026-08-06', participant_ids: ['dave'] }),
    ]
    const results = computeNightsWeights(['dave'], events, tripStart, tripEnd)
    expect(results[0].nights).toBe(4) // 02 -> 06
  })

  it('clamps event dates outside the trip window to the trip bounds', () => {
    const events: TimelineEvent[] = [
      // Bad data: arrival logged a week before the trip even starts.
      makeEvent({ title: 'Arrival', category: 'flight', event_date: '2026-07-01', participant_ids: ['erin'] }),
    ]
    const results = computeNightsWeights(['erin'], events, tripStart, tripEnd)
    expect(results[0].nights).toBe(7) // clamped to full trip range
  })

  it('never returns fewer than 1 night even for a same-day visitor', () => {
    const events: TimelineEvent[] = [
      makeEvent({ title: 'Arrival', category: 'flight', event_date: '2026-08-08', participant_ids: ['fred'] }),
      makeEvent({ title: 'Departure', category: 'flight', event_date: '2026-08-08', participant_ids: ['fred'] }),
    ]
    const results = computeNightsWeights(['fred'], events, tripStart, tripEnd)
    expect(results[0].nights).toBeGreaterThanOrEqual(1)
  })

  it('ignores events not tagged to the participant (participant_ids present but excludes them)', () => {
    const events: TimelineEvent[] = [
      makeEvent({ title: 'Arrival', category: 'flight', event_date: '2026-08-04', participant_ids: ['someone-else'] }),
    ]
    const results = computeNightsWeights(['gina'], events, tripStart, tripEnd)
    expect(results[0].nights).toBe(7) // fallback to full trip since no matching event
    expect(results[0].derivedFromEvents).toBe(false)
  })

  it('treats an event with no participant_ids as applying to everyone', () => {
    const events: TimelineEvent[] = [
      makeEvent({ title: 'Group arrival', category: 'flight', event_date: '2026-08-03', participant_ids: null }),
    ]
    const results = computeNightsWeights(['hank'], events, tripStart, tripEnd)
    expect(results[0].nights).toBe(5) // 03 -> 08
    expect(results[0].derivedFromEvents).toBe(true)
  })

  it('composes with largestRemainderDistribute to produce exact-sum minor-unit shares', () => {
    const events: TimelineEvent[] = [
      makeEvent({ title: 'Bob arrives late', category: 'flight', event_date: '2026-08-06', participant_ids: ['bob'] }),
    ]
    const results = computeNightsWeights(['alice', 'bob', 'carol'], events, tripStart, tripEnd)
    const weights = nightsWeightsToWeightArray(results)
    // alice: 7, bob: 2 (06->08), carol: 7
    expect(weights).toEqual([7, 2, 7])

    const totalMinor = 100_000 // e.g. £1000.00 accommodation expense
    const shares = largestRemainderDistribute(totalMinor, weights)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(totalMinor)
    expect(shares.length).toBe(3)
    // Bob (fewer nights) should owe strictly less than Alice/Carol.
    expect(shares[1]).toBeLessThan(shares[0])
    expect(shares[1]).toBeLessThan(shares[2])
  })

  it('returns an empty array for an empty participant list', () => {
    expect(computeNightsWeights([], [], tripStart, tripEnd)).toEqual([])
  })
})
