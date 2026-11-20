import { useMemo } from 'react'
import { effectiveTripStage } from '../../../lib/tripStage'
import { todayLocal } from '../../../lib/localDate'
import type { TripStatus } from '../../../lib/tripStatus'
import { rsvpStanding, tripPlaces, type RsvpPersonInput, type RsvpStanding, type RsvpTripInput } from './rsvpStanding'

interface StandingTrip extends RsvpTripInput {
  status: TripStatus
  start_date: string
  end_date: string
}

/**
 * The "Are you coming?" standing of every active person on the trip, keyed by
 * user id. Pure so it can be tested without React; the hooks below memoise it.
 */
export function computeRsvpStandings(
  trip: StandingTrip,
  participants: ReadonlyArray<RsvpPersonInput>,
  now: Date = new Date()
): Map<string, RsvpStanding> {
  const stage = effectiveTripStage(trip, now)
  const places = tripPlaces(trip, participants)
  const today = todayLocal(now)
  const map = new Map<string, RsvpStanding>()
  for (const person of participants) {
    if (person.active === false) continue
    map.set(person.user_id, rsvpStanding({ trip, stage, person, places, today, now }))
  }
  return map
}

/** Standings for everyone (organiser views). */
export function useRsvpStandings(
  trip: StandingTrip | null | undefined,
  participants: ReadonlyArray<RsvpPersonInput> | undefined
): Map<string, RsvpStanding> {
  return useMemo(
    () => (trip && participants ? computeRsvpStandings(trip, participants) : new Map<string, RsvpStanding>()),
    [trip, participants]
  )
}

/** The signed-in person's own standing, or null. */
export function useMyRsvpStanding(
  trip: StandingTrip | null | undefined,
  participants: ReadonlyArray<RsvpPersonInput> | undefined,
  userId: string | undefined
): RsvpStanding | null {
  const standings = useRsvpStandings(trip, participants)
  return userId ? (standings.get(userId) ?? null) : null
}
