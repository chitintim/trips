import { describe, expect, it } from 'vitest'
import { notAskingLine, notSureSummary } from './peopleSummary'
import { rsvpStanding, tripPlaces, type RsvpPersonInput, type RsvpStanding } from './rsvpStanding'
import { computeRsvpStandings } from './useRsvpStanding'
import { replyByEnd, formatReplyByDate } from './replyBy'

const NOW = new Date(2026, 10, 16, 12, 0, 0)
const trip = (over: Partial<Parameters<typeof computeRsvpStandings>[0]> = {}) => ({
  confirmation_enabled: true,
  confirmation_deadline: null,
  capacity_limit: 2,
  status: 'confirming_participants' as const,
  start_date: '2027-03-01',
  end_date: '2027-03-08',
  ...over,
})
const people = (...statuses: string[]): RsvpPersonInput[] =>
  statuses.map((s, i) => ({ user_id: `u${i}`, active: true, confirmation_status: s }))

describe('notSureSummary', () => {
  it('adds (trip full) when every maybe is down as not sure only because the trip is full', () => {
    const standings = computeRsvpStandings(trip(), people('confirmed', 'confirmed', 'interested'), NOW)
    expect(notSureSummary(1, standings)).toBe('1 not sure (trip full)')
  })
  it('stays plain when there is room', () => {
    const standings = computeRsvpStandings(trip({ capacity_limit: 5 }), people('confirmed', 'interested'), NOW)
    expect(notSureSummary(1, standings)).toBe('1 not sure')
  })
})

describe('a place held for the waitlist', () => {
  const held = () => {
    const t = trip()
    const list = people('confirmed', 'waitlist', 'interested')
    return rsvpStanding({ trip: t, stage: t.status, person: list[2], places: tripPlaces(t, list), today: '2026-11-16', now: NOW })
  }
  it('is not described as the trip being full', () => {
    expect(held().placeHeld).toBe(true)
    expect(notAskingLine([{ name: 'Tim', standing: held() }])).toBe('Not asking: Tim — not sure, a free place goes to the waitlist first.')
    const standings = computeRsvpStandings(trip(), people('confirmed', 'waitlist', 'interested'), NOW)
    expect(notSureSummary(1, standings)).toBe('1 not sure')
  })
})

describe('notAskingLine', () => {
  const standing = (status: string, over: Partial<ReturnType<typeof trip>> = {}): RsvpStanding => {
    const t = trip(over)
    const list = people('confirmed', 'confirmed', status)
    return rsvpStanding({ trip: t, stage: t.status, person: list[2], places: tripPlaces(t, list), today: '2026-11-16', now: NOW })
  }
  it('explains who is not being asked and why', () => {
    expect(notAskingLine([{ name: 'Tim', standing: standing('interested') }])).toBe('Not asking: Tim — not sure, but the trip is full.')
    expect(notAskingLine([{ name: 'Sam', standing: standing('pending') }])).toBe('Not asking: Sam — no reply, but the trip is full.')
  })
  it('says replies have closed when places are free but the trip is booked', () => {
    const s = standing('interested', { capacity_limit: 9, status: 'booked_awaiting_departure' })
    expect(notAskingLine([{ name: 'Tim', standing: s }])).toBe('Not asking: Tim — not sure, and replies have closed.')
  })
  it('is null when everyone is asked as normal', () => {
    expect(notAskingLine([{ name: 'Tim', standing: standing('interested', { capacity_limit: 9 }) }])).toBeNull()
  })
})

describe('computeRsvpStandings', () => {
  it('skips removed people and uses the effective stage (an ongoing trip has closed replies)', () => {
    const t = trip({ capacity_limit: 9, start_date: '2026-11-10', end_date: '2026-11-20' })
    const list: RsvpPersonInput[] = [...people('pending'), { user_id: 'gone', active: false, confirmation_status: 'pending' }]
    const map = computeRsvpStandings(t, list, NOW)
    expect(map.has('gone')).toBe(false)
    expect(map.get('u0')?.kind).toBe('closed')
  })
})

describe('reply-by display', () => {
  it('shows the deadline as the end of its calendar day', () => {
    expect(replyByEnd('2026-11-18T00:00:00.000Z')).toBe('2026-11-18T23:59:59')
    expect(replyByEnd(null)).toBeNull()
  })
  it('formats the date from the date part only', () => {
    expect(formatReplyByDate('2026-11-18T00:00:00.000Z')).toBe('18 November 2026')
  })
})
