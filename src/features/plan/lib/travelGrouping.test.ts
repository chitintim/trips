import { describe, it, expect } from 'vitest'
import {
  groupTravelForDay,
  mergeDayEntries,
  formatTravelNameSummary,
  travelMemberDisplayName,
  travelMemberFirstName,
  type TravelEventLike,
  type TravelPlanItemLike,
  type TravelUserLike,
} from './travelGrouping'

interface TravelLeg {
  id: string
  direction?: 'arrival' | 'departure'
  time?: string | null
  flightRef?: string | null
  airportCode?: string | null
  userId?: string
  title?: string
  travel?: boolean
  allDay?: boolean
  category?: string | null
}

/** One person's travel-details leg as the (item, event) pair the board sees. */
function leg(overrides: TravelLeg): { item: TravelPlanItemLike; event: TravelEventLike } {
  const {
    id,
    direction = 'arrival',
    time = '15:55:00',
    flightRef = null,
    airportCode = null,
    userId = `user-${id}`,
    title = `${userId} ${direction === 'arrival' ? 'arrives' : 'departs'}`,
    travel = true,
    allDay = false,
    category = flightRef ? 'flight' : 'transfer',
  } = overrides
  return {
    item: {
      id,
      idKind: 'event',
      eventId: `event-${id}`,
      startTime: time,
      allDay,
      category,
      title,
    },
    event: {
      title,
      participant_ids: [userId],
      metadata: travel
        ? {
            travel_details: true,
            direction,
            ...(flightRef ? { flight_ref: flightRef } : {}),
            ...(airportCode ? { airport_code: airportCode } : {}),
          }
        : null,
    },
  }
}

function buildDay(legs: Array<{ item: TravelPlanItemLike; event: TravelEventLike }>) {
  const items = legs.map((l) => l.item)
  const eventsById = new Map(legs.map((l) => [l.item.eventId as string, l.event]))
  return { items, eventsById }
}

describe('groupTravelForDay', () => {
  it('consolidates same-flight and same-minute arrivals into one group (the Sailing Sicily Day 1 shape)', () => {
    // Four on EZY8287 + two off a Lufthansa connection landing the same minute.
    const { items, eventsById } = buildDay([
      leg({ id: 'a', flightRef: 'EZY8287', userId: 'tim' }),
      leg({ id: 'b', flightRef: 'EZY8287', userId: 'raine' }),
      leg({ id: 'c', flightRef: 'EZY8287', userId: 'leo' }),
      leg({ id: 'd', flightRef: 'EZY8287', userId: 'ana' }),
      leg({ id: 'e', flightRef: 'LH1954', userId: 'max' }),
      leg({ id: 'f', flightRef: 'LH1954', userId: 'zoe' }),
    ])
    const { groups, groupedItemIds } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(1)
    expect(groups[0].direction).toBe('arrival')
    expect(groups[0].startTime).toBe('15:55:00')
    expect(groups[0].members).toHaveLength(6)
    expect(groups[0].flightRefs).toEqual(['EZY8287', 'LH1954'])
    expect(groupedItemIds.size).toBe(6)
  })

  it('groups null-flight_ref legs by shared start time', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', flightRef: null, time: '10:00:00' }),
      leg({ id: 'b', flightRef: null, time: '10:00:00' }),
      leg({ id: 'c', flightRef: null, time: '12:00:00' }),
    ])
    const { groups, groupedItemIds } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map((m) => m.item.id)).toEqual(['a', 'b'])
    expect(groups[0].flightRefs).toEqual([])
    expect(groupedItemIds.has('c')).toBe(false)
  })

  it('passes singles through untouched', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', flightRef: 'BA123', time: '10:00:00' }),
      leg({ id: 'b', flightRef: 'BA456', time: '14:00:00' }),
    ])
    const { groups, groupedItemIds } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(0)
    expect(groupedItemIds.size).toBe(0)
  })

  it('never groups across directions, even at the same time with no flight ref', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', direction: 'arrival', flightRef: null, time: '13:20:00' }),
      leg({ id: 'b', direction: 'departure', flightRef: null, time: '13:20:00' }),
    ])
    const { groups, groupedItemIds } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(0)
    expect(groupedItemIds.size).toBe(0)
  })

  it('produces one consolidated row per departure moment (the 5 Sep morning: 13:20 x2, 15:05 x2, 16:30 x4)', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', direction: 'departure', flightRef: 'FR100', time: '13:20:00' }),
      leg({ id: 'b', direction: 'departure', flightRef: 'FR100', time: '13:20:00' }),
      leg({ id: 'c', direction: 'departure', flightRef: 'U2200', time: '15:05:00' }),
      leg({ id: 'd', direction: 'departure', flightRef: 'U2200', time: '15:05:00' }),
      leg({ id: 'e', direction: 'departure', flightRef: 'EZY8288', time: '16:30:00' }),
      leg({ id: 'f', direction: 'departure', flightRef: 'EZY8288', time: '16:30:00' }),
      leg({ id: 'g', direction: 'departure', flightRef: 'EZY8288', time: '16:30:00' }),
      leg({ id: 'h', direction: 'departure', flightRef: 'EZY8288', time: '16:30:00' }),
    ])
    const { groups, groupedItemIds } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(3)
    expect(groups.map((g) => g.startTime)).toEqual(['13:20:00', '15:05:00', '16:30:00'])
    expect(groups.map((g) => g.members.length)).toEqual([2, 2, 4])
    expect(groups.every((g) => g.direction === 'departure')).toBe(true)
    expect(groupedItemIds.size).toBe(8)
  })

  it('groups the same flight even when recorded times differ slightly, using the earliest time', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', flightRef: 'EZY8287', time: '15:50:00' }),
      leg({ id: 'b', flightRef: 'ezy 8287', time: '15:55:00' }),
    ])
    const { groups } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(1)
    expect(groups[0].startTime).toBe('15:50:00')
    // Both spellings are the same normalized ref — listed once, as first seen.
    expect(groups[0].flightRefs).toEqual(['EZY8287'])
  })

  it('ignores non-travel events and option-backed items entirely', () => {
    const dinner: TravelPlanItemLike = {
      id: 'dinner',
      idKind: 'event',
      eventId: 'event-dinner',
      startTime: '15:55:00',
      allDay: false,
      category: 'dining',
      title: 'Group dinner',
    }
    const proposal: TravelPlanItemLike = {
      id: 'opt',
      idKind: 'option',
      eventId: null,
      startTime: '15:55:00',
      allDay: false,
      category: null,
      title: 'Boat option',
    }
    const travelLeg = leg({ id: 'a' })
    const { items, eventsById } = buildDay([travelLeg])
    eventsById.set('event-dinner', { title: 'Group dinner', participant_ids: null, metadata: null })
    const { groups, groupedItemIds } = groupTravelForDay([...items, dinner, proposal], eventsById)
    expect(groups).toHaveLength(0)
    expect(groupedItemIds.size).toBe(0)
  })

  it('collects distinct airport codes across members', () => {
    const { items, eventsById } = buildDay([
      leg({ id: 'a', flightRef: 'EZY8287', airportCode: 'CTA' }),
      leg({ id: 'b', flightRef: 'EZY8287', airportCode: 'CTA' }),
      leg({ id: 'c', flightRef: 'LH1954', airportCode: 'PMO' }),
    ])
    const { groups } = groupTravelForDay(items, eventsById)
    expect(groups).toHaveLength(1)
    expect(groups[0].airportCodes).toEqual(['CTA', 'PMO'])
  })
})

describe('mergeDayEntries', () => {
  it('interleaves ungrouped items and consolidated rows in time order', () => {
    const legs = [
      leg({ id: 'a', flightRef: 'EZY8287', time: '15:55:00' }),
      leg({ id: 'b', flightRef: 'EZY8287', time: '15:55:00' }),
    ]
    const { items, eventsById } = buildDay(legs)
    const breakfast: TravelPlanItemLike = {
      id: 'bfast',
      idKind: 'event',
      eventId: 'event-bfast',
      startTime: '09:00:00',
      allDay: false,
      category: 'dining',
      title: 'Breakfast',
    }
    const lateDinner: TravelPlanItemLike = {
      id: 'dinner',
      idKind: 'event',
      eventId: 'event-dinner',
      startTime: '20:00:00',
      allDay: false,
      category: 'dining',
      title: 'Dinner',
    }
    const { groups, groupedItemIds } = groupTravelForDay([...items, breakfast, lateDinner], eventsById)
    const visible = [...items, breakfast, lateDinner].filter((i) => !groupedItemIds.has(i.id))
    const entries = mergeDayEntries(visible, groups)
    expect(entries.map((e) => (e.kind === 'item' ? e.item.id : 'group'))).toEqual(['bfast', 'group', 'dinner'])
  })
})

describe('name display helpers', () => {
  const usersById = new Map<string, TravelUserLike>([
    ['tim', { full_name: 'Tim Lam', email: 'tim@example.com' }],
    ['no-name', { full_name: null, email: 'raine.x@example.com' }],
  ])

  it('resolves a member name from the users map, preferring full name', () => {
    const member = leg({ id: 'a', userId: 'tim' })
    expect(travelMemberDisplayName({ event: member.event, userId: 'tim' }, usersById)).toBe('Tim Lam')
    expect(travelMemberFirstName({ event: member.event, userId: 'tim' }, usersById)).toBe('Tim')
  })

  it('falls back to email, then to the "X arrives" title with the verb stripped', () => {
    const emailOnly = leg({ id: 'a', userId: 'no-name' })
    expect(travelMemberDisplayName({ event: emailOnly.event, userId: 'no-name' }, usersById)).toBe('raine.x@example.com')
    expect(travelMemberFirstName({ event: emailOnly.event, userId: 'no-name' }, usersById)).toBe('raine.x')

    const unknown = leg({ id: 'b', userId: 'ghost', title: 'Leo arrives' })
    expect(travelMemberDisplayName({ event: unknown.event, userId: 'ghost' }, usersById)).toBe('Leo')
  })

  it('formats the compact name summary: 2 with &, 3 listed, more as +N', () => {
    expect(formatTravelNameSummary(['Tim', 'Raine'])).toBe('Tim & Raine')
    expect(formatTravelNameSummary(['Tim', 'Raine', 'Leo'])).toBe('Tim, Raine, Leo')
    expect(formatTravelNameSummary(['Tim', 'Raine', 'Leo', 'Ana', 'Max', 'Zoe'])).toBe('Tim, Raine, Leo +3')
  })
})
