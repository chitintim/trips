import { describe, expect, it } from 'vitest'
import type { TripStatus } from '../../../lib/tripStatus'
import {
  confirmationDeadlineDate,
  rsvpStanding,
  rsvpStandingLine,
  rsvpStandingTag,
  rsvpStandingWords,
  rsvpStatusWords,
  joinBlockedByWaitlist,
  placeAwaitingOffer,
  placeIsHeld,
  tripPlaces,
  type RsvpPersonInput,
  type RsvpStanding,
  type RsvpTripInput,
} from './rsvpStanding'

const TODAY = '2026-11-16'
const NOW = new Date(2026, 10, 16, 12, 0, 0)
const NAME = 'Japow'

const OPEN_DEADLINE = '2026-11-20T00:00:00.000Z'
const PASSED_DEADLINE = '2026-11-14T00:00:00.000Z'
const TODAY_DEADLINE = '2026-11-16T00:00:00.000Z'

interface Case {
  name: string
  status: string | null
  extra?: Partial<RsvpPersonInput>
  capacity?: number | null
  going?: number
  waitlisted?: number
  deadline?: string | null
  stage?: TripStatus
  enabled?: boolean
  expect: Partial<RsvpStanding>
  line?: string | null
  detail?: string | null
  tag?: string | null
  words?: string
}

const LATE = { variant: 'late', due: null } as const
const ask = (due: string | null) => ({ variant: 'ask', due }) as const

const HELD_LINE = "A place has come free and goes to the waitlist first. If nobody there takes it, we'll ask you here."
const FULL_DETAIL = "If a place comes free and nobody on the waitlist takes it, we'll ask you here."

const CASES: Case[] = [
  { name: 'G1 tracking off', status: 'pending', enabled: false, expect: { kind: 'off', todo: null, chaseable: false, blocksBooking: false } },
  { name: 'G2 inactive', status: 'pending', extra: { active: false }, expect: { kind: 'removed', todo: null } },
  { name: 'G3 confirmed', status: 'confirmed', expect: { kind: 'going', todo: null }, line: null },
  { name: 'G4 declined', status: 'declined', expect: { kind: 'out', todo: null } },
  { name: 'G4 cancelled', status: 'cancelled', expect: { kind: 'out', todo: null }, words: 'Not going' },
  {
    name: 'G5 waitlist, no offer',
    status: 'waitlist',
    expect: { kind: 'waitlist', todo: null, chaseable: false, blocksBooking: false },
    line: "You're on the waitlist for Japow. If a place is offered to you, you'll see it here.",
    words: 'On the waitlist',
  },
  {
    name: 'G5 waitlist, expired offer',
    status: 'waitlist',
    extra: { waitlist_offer_expires_at: new Date(2026, 10, 15).toISOString() },
    expect: { kind: 'waitlist', blocksBooking: false },
    line: "You're on the waitlist for Japow. If a place is offered to you, you'll see it here.",
  },
  {
    name: 'G6 waitlist, live offer',
    status: 'waitlist',
    extra: { waitlist_offer_expires_at: new Date(2026, 10, 17).toISOString() },
    expect: { kind: 'waitlist', todo: null, blocksBooking: true },
    line: null,
  },
  // Full by going
  {
    name: 'U1 interested, full, before deadline',
    status: 'interested',
    capacity: 8,
    going: 8,
    deadline: OPEN_DEADLINE,
    expect: { kind: 'no_place', todo: null, chaseable: false, noPlace: true, placeHeld: false, repliesClosed: false, blocksBooking: false },
    line: "Japow is full. You're down as not sure, so there's nothing you need to do.",
    detail: FULL_DETAIL,
    tag: 'Trip full',
    words: 'Not sure (trip full, no place)',
  },
  {
    name: 'U1 pending, full, no deadline',
    status: 'pending',
    capacity: 8,
    going: 8,
    expect: { kind: 'no_place', todo: null, noPlace: true },
    line: "Japow is full, so there's nothing you need to do.",
    detail: FULL_DETAIL,
    words: 'No reply yet (trip full, no place)',
  },
  {
    name: 'U1 NULL status counts as pending, full',
    status: null,
    capacity: 8,
    going: 8,
    expect: { kind: 'no_place', status: 'pending' },
    line: "Japow is full, so there's nothing you need to do.",
  },
  {
    name: 'U1 conditional (date arrived), full',
    status: 'conditional',
    extra: { conditional_type: 'date', conditional_date: '2026-11-10' },
    capacity: 8,
    going: 8,
    expect: { kind: 'no_place', todo: null },
    line: "Japow is full. You're down as not sure, so there's nothing you need to do.",
  },
  // Full by waitlist (U1b)
  {
    name: 'U1b free place being offered to the waitlist',
    status: 'interested',
    capacity: 8,
    going: 7,
    waitlisted: 1,
    deadline: OPEN_DEADLINE,
    expect: { kind: 'no_place', todo: null, noPlace: true, placeHeld: true },
    line: HELD_LINE,
    detail: null,
  },
  {
    name: 'U1b with the reply-by date passed',
    status: 'interested',
    capacity: 8,
    going: 7,
    waitlisted: 1,
    deadline: PASSED_DEADLINE,
    expect: { kind: 'no_place', todo: null, placeHeld: true, repliesClosed: true, chaseable: false },
    line: HELD_LINE,
  },
  {
    name: 'U1b where the only waitlister has an expired offer',
    status: 'pending',
    capacity: 8,
    going: 7,
    waitlisted: 1,
    expect: { kind: 'no_place', todo: null, placeHeld: true },
    line: HELD_LINE,
  },
  {
    name: 'U1b while the trip is under way shows nothing',
    status: 'pending',
    capacity: 8,
    going: 7,
    waitlisted: 1,
    stage: 'trip_ongoing',
    expect: { kind: 'no_place', placeHeld: true, underway: true },
    line: null,
  },
  {
    name: 'U1 capacity lowered below going',
    status: 'pending',
    capacity: 6,
    going: 8,
    expect: { kind: 'no_place', noPlace: true, placeHeld: false },
  },
  // U2 / U3
  {
    name: 'U2 maybe, full, deadline passed',
    status: 'interested',
    capacity: 8,
    going: 8,
    deadline: PASSED_DEADLINE,
    expect: { kind: 'no_place', todo: null, repliesClosed: true },
    line: "Japow is full and replies have closed. You're down as not sure, so there's nothing you need to do.",
    detail: FULL_DETAIL,
    tag: 'Trip full',
  },
  {
    name: 'U2 pending, full, deadline passed',
    status: 'pending',
    capacity: 8,
    going: 8,
    deadline: PASSED_DEADLINE,
    expect: { kind: 'no_place', repliesClosed: true },
    line: "Japow is full and replies have closed, so there's nothing you need to do.",
  },
  {
    name: 'U3 full and booked',
    status: 'interested',
    capacity: 8,
    going: 8,
    stage: 'booked_awaiting_departure',
    expect: { kind: 'no_place', todo: null, repliesClosed: true },
  },
  // U4 closed
  {
    name: 'U4 maybe, places free, booked',
    status: 'interested',
    capacity: 8,
    going: 3,
    stage: 'booked_awaiting_departure',
    expect: { kind: 'closed', todo: null, chaseable: false, repliesClosed: true, blocksBooking: false },
    line: "Replies for Japow have closed. You're down as not sure.",
    detail: "If you'd still like to come, say so here.",
    tag: 'Replies closed',
    words: 'Not sure (replies closed)',
  },
  {
    name: 'U4 pending, unlimited, ongoing',
    status: 'pending',
    stage: 'trip_ongoing',
    expect: { kind: 'closed', todo: null, underway: true },
    line: null,
    words: 'No reply yet (replies closed)',
  },
  {
    name: 'U4 booked with no deadline, capacity 0 means unlimited',
    status: 'pending',
    capacity: 0,
    stage: 'booked_awaiting_departure',
    expect: { kind: 'closed' },
  },
  // U5 / U6
  {
    name: 'U5 pending, no deadline',
    status: 'pending',
    expect: { kind: 'open', todo: ask(null), chaseable: true, blocksBooking: true, repliesClosed: false },
    line: null,
    tag: null,
    words: 'No reply yet',
  },
  {
    name: 'U6 pending, deadline in future',
    status: 'pending',
    deadline: OPEN_DEADLINE,
    capacity: 8,
    going: 5,
    expect: { kind: 'open', todo: ask('2026-11-20'), chaseable: true, blocksBooking: true },
  },
  {
    name: 'U6 pending, deadline today is not passed',
    status: 'pending',
    deadline: TODAY_DEADLINE,
    expect: { kind: 'open', todo: ask('2026-11-16'), chaseable: true },
  },
  {
    name: 'U6 pending, deadline a non-midnight instant uses its UTC date',
    status: 'pending',
    deadline: '2026-11-16T22:30:00.000Z',
    expect: { kind: 'open', todo: ask('2026-11-16') },
  },
  {
    name: 'U7 pending, deadline passed, places free',
    status: 'pending',
    deadline: PASSED_DEADLINE,
    capacity: 8,
    going: 5,
    expect: { kind: 'late', todo: LATE, chaseable: false, repliesClosed: true, blocksBooking: false },
    line: null,
    tag: 'Replies closed',
    words: 'No reply yet (replies closed)',
  },
  {
    name: 'U7 deadline yesterday (non-midnight)',
    status: 'pending',
    deadline: '2026-11-15T23:59:00.000Z',
    expect: { kind: 'late', todo: LATE },
  },
  // U8-U10
  { name: 'U8 interested, no deadline', status: 'interested', expect: { kind: 'thinking', todo: null, chaseable: false, blocksBooking: true } },
  { name: 'U9 interested, deadline not passed', status: 'interested', deadline: OPEN_DEADLINE, expect: { kind: 'open', todo: ask('2026-11-20'), chaseable: true } },
  { name: 'U10 interested, deadline passed', status: 'interested', deadline: PASSED_DEADLINE, expect: { kind: 'late', todo: LATE, chaseable: false } },
  { name: 'U8 interested, no deadline, closed by stage', status: 'interested', stage: 'booked_awaiting_departure', expect: { kind: 'closed' } },
  // U11-U13
  {
    name: 'U11 conditional, date in future',
    status: 'conditional',
    extra: { conditional_type: 'date', conditional_date: '2026-12-01' },
    expect: { kind: 'waiting_condition', todo: null, chaseable: false, blocksBooking: true },
  },
  {
    name: 'U11 conditional, users only',
    status: 'conditional',
    extra: { conditional_type: 'users', conditional_date: '2026-11-01' },
    expect: { kind: 'waiting_condition', todo: null },
  },
  {
    name: 'U11 conditional, no date',
    status: 'conditional',
    extra: { conditional_type: 'date' },
    expect: { kind: 'waiting_condition', todo: null },
  },
  {
    name: 'U11 conditional waiting stays waiting after the deadline',
    status: 'conditional',
    extra: { conditional_type: 'date', conditional_date: '2026-12-01' },
    deadline: PASSED_DEADLINE,
    expect: { kind: 'waiting_condition', todo: null, blocksBooking: false },
  },
  {
    name: 'U12 conditional, date today, no deadline',
    status: 'conditional',
    extra: { conditional_type: 'date', conditional_date: '2026-11-16' },
    expect: { kind: 'open', todo: ask(null), chaseable: true },
  },
  {
    name: 'U12 conditional both, date past, deadline ahead',
    status: 'conditional',
    extra: { conditional_type: 'both', conditional_date: '2026-11-10T00:00:00Z' },
    deadline: OPEN_DEADLINE,
    expect: { kind: 'open', todo: ask('2026-11-20') },
  },
  {
    name: 'U13 conditional, date arrived, deadline passed',
    status: 'conditional',
    extra: { conditional_type: 'date', conditional_date: '2026-11-10' },
    deadline: PASSED_DEADLINE,
    expect: { kind: 'late', todo: LATE, chaseable: false },
  },
  // Stages
  { name: 'stage gathering', status: 'pending', stage: 'gathering_interest', expect: { kind: 'open' } },
  { name: 'stage confirming', status: 'pending', stage: 'confirming_participants', expect: { kind: 'open' } },
  { name: 'stage booking_details', status: 'pending', stage: 'booking_details', expect: { kind: 'open', repliesClosed: false } },
  { name: 'stage booked', status: 'pending', stage: 'booked_awaiting_departure', expect: { kind: 'closed' } },
  { name: 'stage ongoing', status: 'pending', stage: 'trip_ongoing', expect: { kind: 'closed', todo: null } },
  // NULL status: keeps today's behaviour (no to-do), never chased
  { name: 'NULL status on a booked trip is closed', status: null, stage: 'booked_awaiting_departure', expect: { kind: 'closed', todo: null, status: 'pending' }, words: 'No reply yet (replies closed)' },
  { name: 'unknown status string is treated as out', status: 'mystery', expect: { kind: 'out', todo: null }, words: 'No reply yet' },
  { name: 'NULL status, places free', status: null, expect: { kind: 'thinking', status: 'pending', todo: null, chaseable: false } },
  { name: 'NULL status, deadline passed', status: null, deadline: PASSED_DEADLINE, expect: { kind: 'thinking', todo: null } },
]

describe('rsvpStanding truth table', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const trip: RsvpTripInput = {
        confirmation_enabled: c.enabled ?? true,
        confirmation_deadline: c.deadline ?? null,
        capacity_limit: c.capacity ?? null,
      }
      const me: RsvpPersonInput = { user_id: 'me', confirmation_status: c.status, ...c.extra }
      const others: RsvpPersonInput[] = [
        ...Array.from({ length: c.going ?? 0 }, (_, i) => ({ user_id: `g${i}`, confirmation_status: 'confirmed' })),
        ...Array.from({ length: c.waitlisted ?? 0 }, (_, i) => ({ user_id: `w${i}`, confirmation_status: 'waitlist' })),
      ]
      const places = tripPlaces(trip, [me, ...others])
      const s = rsvpStanding({ trip, stage: c.stage ?? 'confirming_participants', person: me, places, today: TODAY, now: NOW })
      expect(s).toMatchObject(c.expect)
      expect(s.chaseable).toBe(s.kind === 'open')
      if (c.line !== undefined) {
        const line = rsvpStandingLine(s, NAME)
        expect(line?.text ?? null).toBe(c.line)
        if (c.detail !== undefined) expect(line?.detail ?? null).toBe(c.detail)
      }
      if (c.tag !== undefined) expect(rsvpStandingTag(s)).toBe(c.tag)
      if (c.words !== undefined) expect(rsvpStandingWords(s)).toBe(c.words)
    })
  }
})

describe('tripPlaces', () => {
  const trip = (capacity_limit: number | null | undefined): RsvpTripInput => ({ confirmation_enabled: true, confirmation_deadline: null, capacity_limit })
  const crew: RsvpPersonInput[] = [
    { user_id: 'a', confirmation_status: 'confirmed' },
    { user_id: 'b', confirmation_status: 'confirmed', active: false },
    { user_id: 'c', confirmation_status: 'waitlist' },
    { user_id: 'd', confirmation_status: 'waitlist', active: false },
    { user_id: 'e', confirmation_status: 'interested' },
  ]

  it('counts active people only and subtracts the waitlist', () => {
    expect(tripPlaces(trip(4), crew)).toEqual({ capacity: 4, going: 1, waitlisted: 1, free: 2 })
  })
  it('null, 0 and undefined capacity mean unlimited', () => {
    for (const c of [null, 0, undefined, -1]) expect(tripPlaces(trip(c), crew)).toMatchObject({ capacity: null, free: null })
  })
  it('free goes negative when capacity is lowered', () => {
    expect(tripPlaces(trip(1), crew).free).toBe(-1)
  })
})

describe('confirmationDeadlineDate', () => {
  it('takes the first 10 characters', () => {
    expect(confirmationDeadlineDate('2026-11-18T00:00:00Z')).toBe('2026-11-18')
    expect(confirmationDeadlineDate('2026-11-18')).toBe('2026-11-18')
    expect(confirmationDeadlineDate(null)).toBeNull()
    expect(confirmationDeadlineDate(undefined)).toBeNull()
    expect(confirmationDeadlineDate('')).toBeNull()
  })
})

describe('blocksBooking', () => {
  const base: RsvpTripInput = { confirmation_enabled: true, confirmation_deadline: null, capacity_limit: null }
  const stand = (status: string, over: Partial<RsvpPersonInput> = {}, trip: RsvpTripInput = base) => {
    const person = { user_id: 'me', confirmation_status: status, ...over }
    return rsvpStanding({ trip, stage: 'confirming_participants', person, places: tripPlaces(trip, [person]), today: TODAY, now: NOW })
  }
  it('cancelled and plain waitlisters do not block, a live offer does', () => {
    expect(stand('cancelled').blocksBooking).toBe(false)
    expect(stand('waitlist').blocksBooking).toBe(false)
    expect(stand('waitlist', { waitlist_offer_expires_at: new Date(2026, 10, 18).toISOString() }).blocksBooking).toBe(true)
  })
  it('a late person does not block', () => {
    expect(stand('pending', {}, { ...base, confirmation_deadline: PASSED_DEADLINE }).blocksBooking).toBe(false)
  })
})

describe('inactive people', () => {
  it('an inactive confirmed person does not make a maybe no_place', () => {
    const trip: RsvpTripInput = { confirmation_enabled: true, confirmation_deadline: null, capacity_limit: 2 }
    const people: RsvpPersonInput[] = [
      { user_id: 'a', confirmation_status: 'confirmed' },
      { user_id: 'gone', confirmation_status: 'confirmed', active: false },
      { user_id: 'me', confirmation_status: 'interested' },
    ]
    const places = tripPlaces(trip, people)
    expect(places.going).toBe(1)
    const s = rsvpStanding({ trip, stage: 'confirming_participants', person: people[2], places, today: TODAY, now: NOW })
    expect(s.kind).toBe('thinking')
    expect(s.noPlace).toBe(false)
  })
})

describe('the place held for the waitlist', () => {
  const trip = (capacity_limit: number | null, enabled = true): RsvpTripInput => ({ confirmation_enabled: enabled, confirmation_deadline: null, capacity_limit })
  const going = (n: number) => Array.from({ length: n }, (_, i): RsvpPersonInput => ({ user_id: `g${i}`, confirmation_status: 'confirmed' }))
  const live = new Date(NOW.getTime() + 3600_000).toISOString()
  const expired = new Date(NOW.getTime() - 3600_000).toISOString()
  const waiter = (extra: Partial<RsvpPersonInput> = {}): RsvpPersonInput => ({ user_id: 'w', confirmation_status: 'waitlist', ...extra })

  it('placeAwaitingOffer: a waitlister without an offer, or with an expired one', () => {
    expect(placeAwaitingOffer(trip(8), [...going(7), waiter()], NOW)).toBe(true)
    expect(placeAwaitingOffer(trip(8), [...going(7), waiter({ waitlist_offer_expires_at: expired })], NOW)).toBe(true)
  })
  it('placeAwaitingOffer: not with a live offer, nobody waiting, a full trip, no capacity or tracking off', () => {
    expect(placeAwaitingOffer(trip(8), [...going(7), waiter({ waitlist_offer_expires_at: live })], NOW)).toBe(false)
    expect(placeAwaitingOffer(trip(8), [...going(7), waiter({ active: false })], NOW)).toBe(false)
    expect(placeAwaitingOffer(trip(8), going(7), NOW)).toBe(false)
    expect(placeAwaitingOffer(trip(8), [...going(8), waiter()], NOW)).toBe(false)
    expect(placeAwaitingOffer(trip(null), [...going(7), waiter()], NOW)).toBe(false)
    expect(placeAwaitingOffer(trip(8, false), [...going(7), waiter()], NOW)).toBe(false)
  })
  it('placeAwaitingOffer: one live offer among several waitlisters is enough', () => {
    const second = { ...waiter({ waitlist_offer_expires_at: live }), user_id: 'w2' }
    expect(placeAwaitingOffer(trip(8), [...going(6), waiter(), second], NOW)).toBe(false)
  })
  it('joinBlockedByWaitlist blocks everyone but the going and the queued, including declined and cancelled', () => {
    const places = tripPlaces(trip(8), [...going(7), waiter()])
    expect(placeIsHeld(places)).toBe(true)
    for (const status of ['declined', 'cancelled', 'pending', 'interested', 'conditional', null]) {
      expect(joinBlockedByWaitlist(status, places), String(status)).toBe(true)
    }
    expect(joinBlockedByWaitlist('confirmed', places)).toBe(false)
    expect(joinBlockedByWaitlist('waitlist', places)).toBe(false)
  })
  it('joinBlockedByWaitlist does not block when no place is held', () => {
    expect(joinBlockedByWaitlist('declined', tripPlaces(trip(8), going(5)))).toBe(false)
    expect(joinBlockedByWaitlist('declined', tripPlaces(trip(8), going(8)))).toBe(false) // full: the server queues them
    expect(joinBlockedByWaitlist('declined', tripPlaces(trip(null), going(3)))).toBe(false)
  })
})

describe('reply words', () => {
  it('say "On the waitlist" and fall back to "No reply yet"', () => {
    expect(rsvpStatusWords('waitlist')).toBe('On the waitlist')
    expect(rsvpStatusWords('mystery')).toBe('No reply yet')
    expect(rsvpStatusWords(null)).toBe('No reply yet')
    expect(rsvpStatusWords(undefined)).toBe('No reply yet')
  })
})
