/**
 * Display-level consolidation of per-person travel-details events
 * (UX_REDESIGN.md Part 2 "People additions" rows): when several people land
 * or leave on the same flight — or at the same minute — the Plan board's
 * day list shows ONE row ("3:55 PM · ✈️ Tim, Raine, Leo +3 arrive ·
 * EZY8287") instead of six near-identical "X arrives" cards. Pure logic
 * only (no React, no Supabase): the DB rows are never merged — each person
 * keeps their own trip_timeline_events row (and their own edit rights via
 * the existing item sheet); grouping happens at render time here.
 *
 * Grouping rules:
 *  1. Only travel-details events group (metadata.travel_details === true,
 *     see people/lib/travelDetails.ts). Ordinary events, proposals, and
 *     derived-milestone rows are untouched.
 *  2. First pass buckets by (direction, flight_ref): the same flight
 *     groups even when two people typed times a few minutes apart, and
 *     refs are normalized ("EZY 8287" == "ezy8287"). Events with no
 *     flight_ref bucket by (direction, exact start_time) instead.
 *  3. Second pass merges buckets that share (direction, effective start
 *     time) — two different flights landing the same minute still read as
 *     one arrival moment (the row lists both refs).
 *  4. Only merged buckets with >= 2 people become a consolidated row;
 *     singles fall through and render exactly as today.
 *  5. Directions never mix: a 1:20 PM arrival and a 1:20 PM departure are
 *     separate rows.
 */
import type { TimelineEvent } from '../../../types'
import {
  isTravelDetailsEvent,
  travelEventAirportCode,
  travelEventDirection,
  travelEventFlightRef,
  type TravelDirection,
} from '../../people/lib/travelDetails'
import type { PlanItem } from './planItems'

/** The slice of a PlanItem the grouping logic needs — generic so tests don't have to build full PlanItems and callers get their real items back in `member.item`. */
export type TravelPlanItemLike = Pick<PlanItem, 'id' | 'idKind' | 'eventId' | 'startTime' | 'allDay' | 'category' | 'title'>

/** The slice of a TimelineEvent the grouping logic reads. */
export type TravelEventLike = Pick<TimelineEvent, 'metadata' | 'title' | 'participant_ids'>

export interface TravelGroupMember<T extends TravelPlanItemLike = PlanItem> {
  item: T
  event: TravelEventLike
  direction: TravelDirection
  flightRef: string | null
  airportCode: string | null
  /** The traveller (participant_ids=[self] per the travel-details convention). */
  userId: string | null
}

export interface TravelGroup<T extends TravelPlanItemLike = PlanItem> {
  /** Stable render key (direction + time + member event ids). */
  key: string
  direction: TravelDirection
  /** Earliest member start_time ("HH:MM[:SS]"), or null when nobody gave one. */
  startTime: string | null
  /** Distinct flight refs across members, in first-seen order. */
  flightRefs: string[]
  /** Distinct airport codes across members, in first-seen order. */
  airportCodes: string[]
  members: TravelGroupMember<T>[]
}

export interface DayTravelGrouping<T extends TravelPlanItemLike = PlanItem> {
  /** Consolidated rows (>= 2 people each), ordered by start time. */
  groups: TravelGroup<T>[]
  /** Item ids consumed by a group — the caller filters these out of its normal per-item rendering. */
  groupedItemIds: Set<string>
}

const EMPTY_GROUPING: DayTravelGrouping<never> = { groups: [], groupedItemIds: new Set() }

function normalizeFlightRef(ref: string): string {
  return ref.replace(/\s+/g, '').toUpperCase()
}

/**
 * Consolidate one day's travel-details items. `eventsById` is the raw
 * timeline-event lookup (PlanItems don't carry metadata/participants, so
 * the underlying rows are consulted for direction/flight/traveller).
 */
export function groupTravelForDay<T extends TravelPlanItemLike>(
  dayItems: T[],
  eventsById: Map<string, TravelEventLike>
): DayTravelGrouping<T> {
  const members: TravelGroupMember<T>[] = []
  for (const item of dayItems) {
    if (item.idKind !== 'event' || !item.eventId) continue
    const event = eventsById.get(item.eventId)
    if (!event || !isTravelDetailsEvent(event)) continue
    const direction = travelEventDirection(event)
    if (!direction) continue
    members.push({
      item,
      event,
      direction,
      flightRef: travelEventFlightRef(event),
      airportCode: travelEventAirportCode(event),
      userId: (event.participant_ids ?? [])[0] ?? null,
    })
  }
  if (members.length < 2) return EMPTY_GROUPING as DayTravelGrouping<T>

  // Pass 1 (rule 2): same flight together; no-ref events by exact time.
  const buckets = new Map<string, TravelGroupMember<T>[]>()
  for (const member of members) {
    const key = member.flightRef
      ? `${member.direction}|ref:${normalizeFlightRef(member.flightRef)}`
      : `${member.direction}|time:${member.item.startTime ?? ''}`
    const bucket = buckets.get(key) ?? []
    bucket.push(member)
    buckets.set(key, bucket)
  }

  // Pass 2 (rule 3): merge buckets sharing (direction, effective time).
  const merged = new Map<string, TravelGroupMember<T>[]>()
  for (const bucket of buckets.values()) {
    const time = earliestStartTime(bucket)
    const key = `${bucket[0].direction}|${time ?? ''}`
    const target = merged.get(key) ?? []
    target.push(...bucket)
    merged.set(key, target)
  }

  const groups: TravelGroup<T>[] = []
  const groupedItemIds = new Set<string>()
  for (const bucket of merged.values()) {
    if (bucket.length < 2) continue // rule 4: singles pass through untouched
    const flightRefs: string[] = []
    const seenRefs = new Set<string>()
    const airportCodes: string[] = []
    for (const member of bucket) {
      if (member.flightRef && !seenRefs.has(normalizeFlightRef(member.flightRef))) {
        seenRefs.add(normalizeFlightRef(member.flightRef))
        flightRefs.push(member.flightRef)
      }
      if (member.airportCode && !airportCodes.includes(member.airportCode)) {
        airportCodes.push(member.airportCode)
      }
      groupedItemIds.add(member.item.id)
    }
    const startTime = earliestStartTime(bucket)
    groups.push({
      key: `travel:${bucket[0].direction}:${startTime ?? 'untimed'}:${bucket.map((m) => m.item.id).join('+')}`,
      direction: bucket[0].direction,
      startTime,
      flightRefs,
      airportCodes,
      members: bucket,
    })
  }
  groups.sort((a, b) => (a.startTime ?? '') < (b.startTime ?? '') ? -1 : (a.startTime ?? '') > (b.startTime ?? '') ? 1 : 0)
  return { groups, groupedItemIds }
}

function earliestStartTime(members: TravelGroupMember<TravelPlanItemLike>[]): string | null {
  let min: string | null = null
  for (const member of members) {
    const t = member.item.allDay ? null : member.item.startTime
    if (t && (min === null || t < min)) min = t
  }
  return min
}

// ---------------------------------------------------------------------------
// Display helpers (kept here so they're unit-testable without mounting the
// row component).
// ---------------------------------------------------------------------------

/** The slice of a `users` row name resolution needs. */
export interface TravelUserLike {
  full_name: string | null
  email: string | null
}

/**
 * A member's display name: the traveller's profile name (or email), falling
 * back to the event title with its " arrives"/" departs" suffix stripped
 * (TravelDetailsSheet writes titles in exactly that shape).
 */
export function travelMemberDisplayName(
  member: Pick<TravelGroupMember<TravelPlanItemLike>, 'event' | 'userId'>,
  usersById: Map<string, TravelUserLike>
): string {
  const user = member.userId ? usersById.get(member.userId) : undefined
  const profileName = user?.full_name?.trim() || user?.email?.trim()
  if (profileName) return profileName
  const fromTitle = member.event.title.replace(/\s+(arrives|departs)\s*$/i, '').trim()
  return fromTitle || 'Someone'
}

/** First name only, for the compact consolidated line. */
export function travelMemberFirstName(
  member: Pick<TravelGroupMember<TravelPlanItemLike>, 'event' | 'userId'>,
  usersById: Map<string, TravelUserLike>
): string {
  return travelMemberDisplayName(member, usersById).split(/[\s@]+/)[0]
}

/** "Tim & Raine" / "Tim, Raine, Leo" / "Tim, Raine, Leo +3" — first 3 names, then a count. */
export function formatTravelNameSummary(names: string[]): string {
  if (names.length <= 2) return names.join(' & ')
  const shown = names.slice(0, 3)
  const extra = names.length - shown.length
  return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ')
}

/** One entry in a day's settled list: either a normal item or a consolidated travel row. */
export type DayListEntry<T extends TravelPlanItemLike = PlanItem> =
  | { kind: 'item'; item: T }
  | { kind: 'group'; group: TravelGroup<T> }

/**
 * Interleave ungrouped items with consolidated rows in time order (all-day
 * and untimed first, matching groupPlanItemsByDate's day sort). The caller
 * passes `items` already filtered of `groupedItemIds`.
 */
export function mergeDayEntries<T extends TravelPlanItemLike>(items: T[], groups: TravelGroup<T>[]): DayListEntry<T>[] {
  const entries: Array<{ entry: DayListEntry<T>; time: string; label: string }> = [
    ...items.map((item) => ({
      entry: { kind: 'item' as const, item },
      time: item.allDay ? '' : item.startTime ?? '',
      label: item.title,
    })),
    ...groups.map((group) => ({
      entry: { kind: 'group' as const, group },
      time: group.startTime ?? '',
      label: group.key,
    })),
  ]
  entries.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1
    return a.label.localeCompare(b.label)
  })
  return entries.map((e) => e.entry)
}
