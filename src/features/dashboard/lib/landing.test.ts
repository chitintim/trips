import { describe, it, expect } from 'vitest'
import {
  selectLandingTrip,
  hasSeenLandingRedirectPrompt,
  markLandingRedirectPromptSeen,
  orderDashboardTrips,
  isMyTrip,
} from './landing'
import type { TripStatus } from '../../../types'

const ME = 'user-1'
const OTHER = 'user-2'
const TODAY = '2026-07-07'

let seq = 0
const trip = (overrides: Partial<{ id: string; status: TripStatus; start_date: string; end_date: string; is_public: boolean; created_by: string }> = {}) => ({
  id: overrides.id ?? `trip-${++seq}`,
  name: overrides.id ?? `Trip ${seq}`,
  status: overrides.status ?? ('booking_details' as TripStatus),
  start_date: overrides.start_date ?? '2026-09-01',
  end_date: overrides.end_date ?? '2026-09-05',
  is_public: overrides.is_public ?? false,
  created_by: overrides.created_by ?? ME,
})

describe('isMyTrip', () => {
  it('counts private trips and own public trips as mine', () => {
    expect(isMyTrip(trip({ is_public: false, created_by: OTHER }), ME)).toBe(true)
    expect(isMyTrip(trip({ is_public: true, created_by: ME }), ME)).toBe(true)
    expect(isMyTrip(trip({ is_public: true, created_by: OTHER }), ME)).toBe(false)
  })
})

describe('selectLandingTrip', () => {
  it('picks an ongoing trip (today within its dates) over any upcoming trip', () => {
    const ongoing = trip({ id: 'ongoing', start_date: '2026-07-05', end_date: '2026-07-10' })
    const upcoming = trip({ id: 'upcoming', start_date: '2026-07-08', end_date: '2026-07-12' })
    expect(selectLandingTrip([upcoming, ongoing], ME, TODAY)?.id).toBe('ongoing')
  })

  it('breaks an ongoing tie by soonest end date', () => {
    const endsLater = trip({ id: 'later', start_date: '2026-07-01', end_date: '2026-07-20' })
    const endsSooner = trip({ id: 'sooner', start_date: '2026-07-06', end_date: '2026-07-09' })
    expect(selectLandingTrip([endsLater, endsSooner], ME, TODAY)?.id).toBe('sooner')
  })

  it('otherwise picks the nearest future start_date', () => {
    const far = trip({ id: 'far', start_date: '2026-12-01', end_date: '2026-12-05' })
    const near = trip({ id: 'near', start_date: '2026-08-01', end_date: '2026-08-05' })
    expect(selectLandingTrip([far, near], ME, TODAY)?.id).toBe('near')
  })

  it('returns null when there are no ongoing or upcoming trips → no prompt at all', () => {
    expect(selectLandingTrip([], ME, TODAY)).toBeNull()
    const past = trip({ start_date: '2026-01-01', end_date: '2026-01-05' })
    const storedCompleted = trip({ status: 'trip_completed', start_date: '2026-08-01', end_date: '2026-08-05' })
    expect(selectLandingTrip([past, storedCompleted], ME, TODAY)).toBeNull()
  })

  it("ignores other people's public trips", () => {
    const foreign = trip({ id: 'foreign', is_public: true, created_by: OTHER, start_date: '2026-07-08', end_date: '2026-07-12' })
    const mine = trip({ id: 'mine', start_date: '2026-09-01', end_date: '2026-09-05' })
    expect(selectLandingTrip([foreign, mine], ME, TODAY)?.id).toBe('mine')
  })
})

describe('landing redirect prompt session guard', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('prompts once per session: unseen until marked, then seen', () => {
    const storage = fakeStorage()
    expect(hasSeenLandingRedirectPrompt(storage)).toBe(false)
    markLandingRedirectPromptSeen(storage)
    expect(hasSeenLandingRedirectPrompt(storage)).toBe(true)
  })

  it('fails closed (never prompts) when session storage is unavailable or throwing', () => {
    expect(hasSeenLandingRedirectPrompt(null)).toBe(true)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(hasSeenLandingRedirectPrompt(throwing)).toBe(true)
    expect(() => markLandingRedirectPromptSeen(throwing)).not.toThrow()
  })
})

describe('orderDashboardTrips', () => {
  it('orders with-actions → ongoing → upcoming, past separated', () => {
    const withActions = trip({ id: 'actions', start_date: '2026-10-01', end_date: '2026-10-05' })
    const ongoing = trip({ id: 'ongoing', start_date: '2026-07-05', end_date: '2026-07-10' })
    const upcoming = trip({ id: 'upcoming', start_date: '2026-08-01', end_date: '2026-08-05' })
    const past = trip({ id: 'past', status: 'trip_completed', start_date: '2026-01-01', end_date: '2026-01-05' })

    const result = orderDashboardTrips([past, upcoming, ongoing, withActions], { actions: 2 }, TODAY)
    expect(result.active.map((t) => t.id)).toEqual(['actions', 'ongoing', 'upcoming'])
    expect(result.past.map((t) => t.id)).toEqual(['past'])
  })

  it('puts date-past trips into past even when stored status lags', () => {
    const datePast = trip({ id: 'over', status: 'trip_ongoing', start_date: '2026-06-01', end_date: '2026-06-05' })
    const result = orderDashboardTrips([datePast], {}, TODAY)
    expect(result.past.map((t) => t.id)).toEqual(['over'])
    expect(result.active).toEqual([])
  })

  it('sorts upcoming by soonest start and past by most recent', () => {
    const a = trip({ id: 'a', start_date: '2026-09-01', end_date: '2026-09-03' })
    const b = trip({ id: 'b', start_date: '2026-08-01', end_date: '2026-08-03' })
    const p1 = trip({ id: 'p1', status: 'trip_completed', start_date: '2026-01-01', end_date: '2026-01-03' })
    const p2 = trip({ id: 'p2', status: 'trip_completed', start_date: '2026-03-01', end_date: '2026-03-03' })
    const result = orderDashboardTrips([a, b, p1, p2], {}, TODAY)
    expect(result.active.map((t) => t.id)).toEqual(['b', 'a'])
    expect(result.past.map((t) => t.id)).toEqual(['p2', 'p1'])
  })
})
