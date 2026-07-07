import type { TimelineEvent } from '../../../types'
import type { Json } from '../../../types/database.types'

/**
 * Self-service travel details (UX_REDESIGN.md Part 2 "People additions"):
 * each participant's arrival/departure lives as ordinary
 * trip_timeline_events rows (category transfer/flight,
 * participant_ids=[self], metadata.travel_details=true) so they appear on
 * the Plan board and feed nights-weighting automatically — no new tables.
 */

export type TravelDirection = 'arrival' | 'departure'

export interface TravelDetailsMetadata {
  travel_details: true
  direction: TravelDirection
  flight_ref?: string
}

export function isTravelDetailsEvent(event: Pick<TimelineEvent, 'metadata'>): boolean {
  const m = event.metadata
  return !!m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).travel_details === true
}

export function travelEventDirection(event: Pick<TimelineEvent, 'metadata' | 'title'>): TravelDirection | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const dir = (m as Record<string, unknown>).direction
    if (dir === 'arrival' || dir === 'departure') return dir
  }
  if (/arriv/i.test(event.title)) return 'arrival'
  if (/depart/i.test(event.title)) return 'departure'
  return null
}

export function travelEventFlightRef(event: Pick<TimelineEvent, 'metadata'>): string | null {
  const m = event.metadata
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const ref = (m as Record<string, unknown>).flight_ref
    if (typeof ref === 'string' && ref.trim()) return ref
  }
  return null
}

export interface MyTravelEvents {
  arrival: TimelineEvent | null
  departure: TimelineEvent | null
}

/** The user's own travel-details events (one per direction; latest wins if duplicated). */
export function getMyTravelEvents(events: TimelineEvent[], userId: string | undefined): MyTravelEvents {
  const result: MyTravelEvents = { arrival: null, departure: null }
  if (!userId) return result
  for (const event of events) {
    if (!isTravelDetailsEvent(event)) continue
    if (!(event.participant_ids ?? []).includes(userId)) continue
    const direction = travelEventDirection(event)
    if (direction) result[direction] = event
  }
  return result
}

export function buildTravelMetadata(direction: TravelDirection, flightRef: string): Json {
  const metadata: TravelDetailsMetadata = { travel_details: true, direction }
  if (flightRef.trim()) metadata.flight_ref = flightRef.trim()
  return metadata as unknown as Json
}
