import { describe, it, expect } from 'vitest'
import type { TimelineEvent } from '../../../types'
import {
  buildTravelMetadata,
  earliestOwnTravelDate,
  getMyExtraTravelLegs,
  getMyTravelEvents,
  isExtraTravelLeg,
  isMainTravelLeg,
  travelLegOtherEnd,
  travelLegSummary,
} from './travelDetails'

function ev(over: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    trip_id: 't',
    title: 'Sam arrives',
    category: 'transfer',
    event_date: '2026-12-08',
    start_time: null,
    participant_ids: ['sam'],
    metadata: { travel_details: true, direction: 'arrival' },
    ...over,
  } as TimelineEvent
}

describe('main and extra legs', () => {
  it('treats rows with no leg as main', () => {
    expect(isMainTravelLeg(ev({ id: 'a' }))).toBe(true)
    expect(isExtraTravelLeg(ev({ id: 'a' }))).toBe(false)
    const extra = ev({ id: 'b', metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } })
    expect(isExtraTravelLeg(extra)).toBe(true)
    expect(isMainTravelLeg(extra)).toBe(false)
  })

  it('getMyTravelEvents returns main legs only, latest duplicate winning', () => {
    const extra = ev({ id: 'x', metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } })
    const first = ev({ id: 'a1' })
    const second = ev({ id: 'a2' })
    const r = getMyTravelEvents([first, extra, second], 'sam')
    expect(r.arrival?.id).toBe('a2')
    expect(r.departure).toBeNull()
  })

  it('prefers the most recently updated duplicate, then the higher id', () => {
    const a = ev({ id: 'a', updated_at: '2026-02-01' } as never)
    const b = ev({ id: 'b', updated_at: '2026-01-01' } as never)
    expect(getMyTravelEvents([a, b], 'sam').arrival?.id).toBe('a')
    expect(getMyTravelEvents([b, a], 'sam').arrival?.id).toBe('a')
    expect(getMyTravelEvents([ev({ id: 'a' }), ev({ id: 'b' })], 'sam').arrival?.id).toBe('b')
  })

  it('getMyExtraTravelLegs splits by direction and sorts', () => {
    const meta = (direction: string) => ({ travel_details: true, direction, leg: 'extra' })
    const r = getMyExtraTravelLegs(
      [
        ev({ id: 'b2', event_date: '2026-12-05', metadata: meta('arrival') }),
        ev({ id: 'b1', event_date: '2026-12-02', metadata: meta('arrival') }),
        ev({ id: 'a1', event_date: '2026-12-14', metadata: meta('departure') }),
        ev({ id: 'o', participant_ids: ['other'], metadata: meta('arrival') }),
      ],
      'sam',
    )
    expect(r.before.map((e) => e.id)).toEqual(['b1', 'b2'])
    expect(r.after.map((e) => e.id)).toEqual(['a1'])
  })
})

describe('other end', () => {
  const arrival = ev({
    id: 'a',
    event_date: '2026-12-22',
    metadata: { travel_details: true, direction: 'arrival', set_off_date: '2026-12-21', set_off_time: '21:00' },
  })

  it('reads the fields', () => {
    expect(travelLegOtherEnd(arrival)).toEqual({ setOffDate: '2026-12-21', setOffTime: '21:00', homeDate: null, homeTime: null })
  })

  it('summarises an overnight arrival', () => {
    expect(travelLegSummary(arrival)).toBe('Sets off Mon 21 Dec 21:00 · lands next day')
    const two = ev({ id: 'b', event_date: '2026-12-22', metadata: { travel_details: true, direction: 'arrival', set_off_date: '2026-12-20' } })
    expect(travelLegSummary(two)).toBe('Sets off Sun 20 Dec · lands 2 days later')
  })

  it('summarises getting home and returns null when there is nothing', () => {
    const dep = ev({ id: 'd', metadata: { travel_details: true, direction: 'departure', home_date: '2027-01-06' } })
    expect(travelLegSummary(dep)).toBe('Gets home Wed 6 Jan')
    expect(travelLegSummary(ev({ id: 'z' }))).toBeNull()
  })
})

describe('earliestOwnTravelDate', () => {
  it('uses the set-off day, then extra legs before the trip', () => {
    const arrival = ev({ id: 'a', event_date: '2026-12-08', metadata: { travel_details: true, direction: 'arrival', set_off_date: '2026-12-07' } })
    expect(earliestOwnTravelDate([arrival], 'sam')).toBe('2026-12-07')
    const early = ev({ id: 'e', event_date: '2026-12-05', metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } })
    expect(earliestOwnTravelDate([arrival, early], 'sam')).toBe('2026-12-05')
    expect(earliestOwnTravelDate([], 'sam')).toBeNull()
    expect(earliestOwnTravelDate([arrival], undefined)).toBeNull()
  })
})

describe('buildTravelMetadata', () => {
  it('stays backward compatible and drops empty fields', () => {
    expect(buildTravelMetadata('arrival', ' BA1 ', 'lhr')).toEqual({ travel_details: true, direction: 'arrival', flight_ref: 'BA1', airport_code: 'LHR' })
    expect(buildTravelMetadata('arrival', '')).toEqual({ travel_details: true, direction: 'arrival' })
    expect(buildTravelMetadata('departure', '', '', { leg: 'main', homeDate: '2027-01-06', homeTime: null })).toEqual({
      travel_details: true,
      direction: 'departure',
      leg: 'main',
      home_date: '2027-01-06',
    })
  })
})
