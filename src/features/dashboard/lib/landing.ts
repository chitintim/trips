import { effectiveTripStage } from '../../../lib/tripStage'
import type { Trip } from '../../../types'

/**
 * Landing rules + dashboard card ordering (UX_REDESIGN.md Part 2):
 * - Exactly ONE non-completed trip → land straight in it.
 * - Otherwise dashboard, cards ordered: active-with-your-actions →
 *   active/ongoing → upcoming → past (collapsed).
 * Pure functions — unit-testable without React.
 */

type TripLike = Pick<Trip, 'id' | 'status' | 'start_date' | 'end_date' | 'is_public' | 'created_by'>

/**
 * Membership approximation used across the member dashboard: RLS already
 * scopes `trips` to own + public, so "mine" = everything that isn't someone
 * else's public trip.
 */
export function isMyTrip(trip: Pick<TripLike, 'is_public' | 'created_by'>, userId: string): boolean {
  return !trip.is_public || trip.created_by === userId
}

/**
 * If the user has exactly one trip whose EFFECTIVE stage isn't completed,
 * return its id — '/' should land there directly. Null otherwise.
 */
export function resolveSingleActiveTripRedirect<T extends TripLike>(
  trips: T[],
  userId: string,
  today: Date | string = new Date()
): string | null {
  const mine = trips.filter((t) => isMyTrip(t, userId))
  const active = mine.filter((t) => effectiveTripStage(t, today) !== 'trip_completed')
  return active.length === 1 ? active[0].id : null
}

export interface OrderedDashboardTrips<T> {
  /** Non-past cards, ordered: with-your-actions → ongoing → upcoming. */
  active: T[]
  /** Completed/past cards (collapsed section), most recent first. */
  past: T[]
}

/**
 * Order the dashboard grid. `attentionCounts` maps trip id → the user's
 * needs-attention count (0/undefined = none).
 */
export function orderDashboardTrips<T extends TripLike>(
  trips: T[],
  attentionCounts: Record<string, number>,
  today: Date | string = new Date()
): OrderedDashboardTrips<T> {
  const past: T[] = []
  const withActions: T[] = []
  const ongoing: T[] = []
  const upcoming: T[] = []

  for (const trip of trips) {
    const stage = effectiveTripStage(trip, today)
    if (stage === 'trip_completed') {
      past.push(trip)
    } else if ((attentionCounts[trip.id] ?? 0) > 0) {
      withActions.push(trip)
    } else if (stage === 'trip_ongoing') {
      ongoing.push(trip)
    } else {
      upcoming.push(trip)
    }
  }

  const byStartAsc = (a: T, b: T) => a.start_date.localeCompare(b.start_date)
  const byStartDesc = (a: T, b: T) => b.start_date.localeCompare(a.start_date)

  withActions.sort(byStartAsc)
  ongoing.sort(byStartAsc)
  upcoming.sort(byStartAsc)
  past.sort(byStartDesc)

  return { active: [...withActions, ...ongoing, ...upcoming], past }
}
