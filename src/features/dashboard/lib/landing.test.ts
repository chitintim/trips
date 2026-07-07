import { describe, it, expect } from 'vitest'
import { resolveSingleActiveTripRedirect, orderDashboardTrips, isMyTrip } from './landing'
import type { TripStatus } from '../../../types'

const ME = 'user-1'
const OTHER = 'user-2'
const TODAY = '2026-07-07'

let seq = 0
const trip = (overrides: Partial<{ id: string; status: TripStatus; start_date: string; end_date: string; is_public: boolean; created_by: string }> = {}) => ({
  id: overrides.id ?? `trip-${++seq}`,
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

describe('resolveSingleActiveTripRedirect', () => {
  it('redirects into the single non-completed trip', () => {
    const only = trip({ id: 'the-one' })
    expect(resolveSingleActiveTripRedirect([only], ME, TODAY)).toBe('the-one')
  })

  it('ignores completed trips (stored status)', () => {
    const done = trip({ status: 'trip_completed' })
    const active = trip({ id: 'active' })
    expect(resolveSingleActiveTripRedirect([done, active], ME, TODAY)).toBe('active')
  })

  it('treats date-past trips as completed (effective stage)', () => {
    const datePast = trip({ start_date: '2026-01-01', end_date: '2026-01-05', status: 'trip_ongoing' })
    const active = trip({ id: 'active' })
    expect(resolveSingleActiveTripRedirect([datePast, active], ME, TODAY)).toBe('active')
  })

  it('returns null with zero or multiple active trips', () => {
    expect(resolveSingleActiveTripRedirect([], ME, TODAY)).toBeNull()
    expect(resolveSingleActiveTripRedirect([trip(), trip()], ME, TODAY)).toBeNull()
    expect(resolveSingleActiveTripRedirect([trip({ status: 'trip_completed' })], ME, TODAY)).toBeNull()
  })

  it("ignores other people's public trips", () => {
    const foreign = trip({ is_public: true, created_by: OTHER })
    const mine = trip({ id: 'mine' })
    expect(resolveSingleActiveTripRedirect([foreign, mine], ME, TODAY)).toBe('mine')
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
