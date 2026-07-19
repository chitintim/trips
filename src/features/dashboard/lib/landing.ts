import { dateDerivedStage, effectiveTripStage } from '../../../lib/tripStage'
import type { Trip } from '../../../types'

/**
 * Landing rules + dashboard card ordering (UX_REDESIGN.md Part 2, revised):
 * - First dashboard landing of a session → a 5s countdown prompt offering
 *   to jump into the "closest" trip (ongoing beats upcoming, nearest start
 *   wins), once per session. Supersedes the old instant
 *   single-active-trip redirect.
 * - Cards ordered: active-with-your-actions → active/ongoing → upcoming →
 *   past (collapsed).
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

type LandingTripLike = TripLike & Pick<Trip, 'name'>

/**
 * The trip the landing-redirect prompt should offer: an ONGOING trip first
 * (today inside its dates; soonest to end wins a tie), else the trip with
 * the nearest future start_date. Null when the user has no ongoing or
 * upcoming trips — then there's no prompt at all. Trips whose effective
 * stage is completed never qualify.
 */
export function selectLandingTrip<T extends LandingTripLike>(
  trips: T[],
  userId: string,
  today: Date | string = new Date()
): T | null {
  const candidates = trips.filter((t) => isMyTrip(t, userId) && effectiveTripStage(t, today) !== 'trip_completed')
  const ongoing = candidates
    .filter((t) => dateDerivedStage(t, today) === 'trip_ongoing')
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  if (ongoing.length > 0) return ongoing[0]
  const upcoming = candidates
    .filter((t) => dateDerivedStage(t, today) === null) // dates fully in the future
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
  return upcoming[0] ?? null
}

// ---------------------------------------------------------------------------
// Once-per-session guard for the landing-redirect prompt. The redirect is a
// landing convenience, not a trap: navigating back to the dashboard later in
// the session must never re-trigger it. Storage failures degrade to "never
// prompt" rather than prompting on every visit.
// ---------------------------------------------------------------------------

const REDIRECT_PROMPT_KEY = 'trips.landing.redirect-prompted'

type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>

function sessionStore(): PromptStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function hasSeenLandingRedirectPrompt(storage: PromptStorage | null = sessionStore()): boolean {
  if (!storage) return true
  try {
    return storage.getItem(REDIRECT_PROMPT_KEY) === '1'
  } catch {
    return true
  }
}

export function markLandingRedirectPromptSeen(storage: PromptStorage | null = sessionStore()): void {
  try {
    storage?.setItem(REDIRECT_PROMPT_KEY, '1')
  } catch {
    // Ignore: hasSeenLandingRedirectPrompt already fails closed.
  }
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
