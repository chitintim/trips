import { describe, expect, it } from 'vitest'
import { assembleSnapshot, summariseCounts } from './useTodos'
import type { TripSnapshot } from '../todos/types'

const trip: TripSnapshot['trip'] = {
  id: 't',
  name: 'T',
  status: 'confirming_participants',
  start_date: '2027-02-06',
  end_date: '2027-02-13',
  confirmation_enabled: true,
  confirmation_deadline: null,
  base_currency: 'GBP',
}

const full = {
  trip,
  participants: [],
  allParticipants: [],
  sections: [],
  votes: [],
  actions: [],
  checklists: [],
  expenses: [],
  settlements: [],
  travelEvents: [],
  bookings: [],
}

describe('assembleSnapshot: never built from partial data (D4)', () => {
  it('builds when every input has loaded (balances may be absent)', () => {
    expect(assembleSnapshot(full)).not.toBeNull()
  })

  for (const key of Object.keys(full) as Array<keyof typeof full>) {
    it(`returns null while ${key} is still loading`, () => {
      expect(assembleSnapshot({ ...full, [key]: undefined })).toBeNull()
    })
  }
})

describe('summariseCounts: loading is neither 0 nor a wrong number', () => {
  it('sums loaded trips', () => {
    expect(summariseCounts({ a: 2, b: 0 })).toEqual({ counts: { a: 2, b: 0 }, total: 2, isLoading: false })
  })
  it('a loading trip is absent from counts and makes total undefined', () => {
    expect(summariseCounts({ a: 2, b: undefined })).toEqual({ counts: { a: 2 }, total: undefined, isLoading: true })
  })
  it('nothing reported yet is a total of 0, not loading', () => {
    expect(summariseCounts({})).toEqual({ counts: {}, total: 0, isLoading: false })
  })
})
