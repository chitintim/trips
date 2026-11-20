import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TimelineEvent } from '../../../types'

const rpc = vi.fn()
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }))

import { legsFromEvents, ownTravelRowIds, setMyTravel, travelSaveErrorMessage, validateTravelLegs, travelLegErrors } from './myTravel'
import type { TravelLegInput } from './myTravel'

const leg = (over: Partial<TravelLegInput> = {}): TravelLegInput => ({
  id: null,
  direction: 'arrival',
  leg: 'main',
  title: null,
  date: '2026-12-08',
  time: null,
  flightRef: null,
  airportCode: null,
  setOffDate: null,
  setOffTime: null,
  homeDate: null,
  homeTime: null,
  ...over,
})

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

beforeEach(() => rpc.mockReset())

describe('legsFromEvents', () => {
  it('returns one main per direction (latest wins), then extras, and reads old rows as main', () => {
    const legs = legsFromEvents(
      [
        ev({ id: 'a1' }),
        ev({ id: 'a2', start_time: '10:00:00', metadata: { travel_details: true, direction: 'arrival', flight_ref: 'JL044', set_off_date: '2026-12-07', set_off_time: '21:00' } }),
        ev({ id: 'x', title: 'Flight to Tokyo', event_date: '2026-12-05', metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } }),
        ev({ id: 'other', participant_ids: ['kim'] }),
      ],
      'sam',
    )
    expect(legs.map((l) => [l.id, l.leg, l.direction])).toEqual([
      ['a2', 'main', 'arrival'],
      ['x', 'extra', 'arrival'],
    ])
    expect(legs[0]).toMatchObject({ time: '10:00', flightRef: 'JL044', setOffDate: '2026-12-07', setOffTime: '21:00', title: null })
    expect(legs[1].title).toBe('Flight to Tokyo')
  })
})

describe('ownership and duplicates', () => {
  it('uses the strict rule: only rows for the caller alone', () => {
    const events = [
      ev({ id: 'mine' }),
      ev({ id: 'shared', participant_ids: ['sam', 'kim'] }),
      ev({ id: 'opt', source_option_id: 'o1' } as never),
      ev({ id: 'plain', metadata: null }),
    ]
    expect(ownTravelRowIds(events, 'sam')).toEqual(['mine'])
    expect(legsFromEvents(events, 'sam').map((l) => l.id)).toEqual(['mine'])
  })

  it('picks the most recently updated duplicate but lists every id as known', () => {
    const events = [ev({ id: 'old', updated_at: '2026-01-01T00:00:00Z' }), ev({ id: 'new', updated_at: '2026-02-01T00:00:00Z' })]
    expect(legsFromEvents(events, 'sam').map((l) => l.id)).toEqual(['new'])
    expect(ownTravelRowIds(events, 'sam')).toEqual(['new', 'old'])
  })

  it('sends HH:MM on the wire for a seeded HH:MM:SS time', async () => {
    rpc.mockResolvedValue({ data: { legs: [] }, error: null })
    const legs = legsFromEvents([ev({ id: 'a', start_time: '19:00:00', metadata: { travel_details: true, direction: 'arrival', set_off_time: '21:00:00', set_off_date: '2026-12-07' } })], 'sam')
    await setMyTravel('t', legs, ['a'])
    const sent = rpc.mock.calls[0][1].p_legs[0]
    expect(sent.time).toBe('19:00')
    expect(sent.set_off_time).toBe('21:00')
  })

  it('shows the server message for a stale refusal', () => {
    expect(travelSaveErrorMessage({ hint: 'stale', message: 'Your travel has changed since you opened this. Close it, open it again and check.' })).toBe(
      'Your travel has changed since you opened this. Close it, open it again and check.',
    )
  })
})

describe('validateTravelLegs', () => {
  it('accepts a good set, including dates outside the trip', () => {
    expect(validateTravelLegs([leg(), leg({ direction: 'departure', date: '2027-01-30' })])).toBeNull()
  })

  it('blocks a leg with a field but no date', () => {
    expect(validateTravelLegs([leg({ date: '', time: '10:00' })])).toBe('Add the date, or clear this journey.')
    expect(travelLegErrors([leg({ date: '', flightRef: 'BA1' })])[0]).toMatchObject({ index: 0, field: 'date' })
  })

  it('checks the year against the trip start when given', () => {
    expect(validateTravelLegs([leg({ date: '2036-12-08' })], '2026-12-10')).toBe('That date looks wrong. Check the year.')
    expect(validateTravelLegs([leg({ date: '2026-02-30' })])).toBe('That date looks wrong. Check the year.')
  })

  it('checks time, ref, airport and titles with the server wording', () => {
    expect(validateTravelLegs([leg({ time: '25:00' })])).toBe("That time doesn't look right. Use hours and minutes, like 21:30.")
    expect(validateTravelLegs([leg({ flightRef: 'x'.repeat(13) })])).toBe('The flight or train number is too long (12 characters at most).')
    expect(validateTravelLegs([leg({ airportCode: 'LH' })])).toBe('The airport code should be three letters, like LHR.')
    expect(validateTravelLegs([leg({ leg: 'extra', title: null })])).toBe('Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.')
    expect(validateTravelLegs([leg({ title: 'Oops' })])).toBe('Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.')
  })

  it('checks set-off and get-home windows', () => {
    expect(validateTravelLegs([leg({ setOffDate: '2026-12-04' })])).toBe('Setting off must be on or up to 3 days before arriving.')
    expect(validateTravelLegs([leg({ setOffDate: '2026-12-09' })])).toBe('Setting off must be on or up to 3 days before arriving.')
    expect(validateTravelLegs([leg({ setOffDate: '2026-12-07', setOffTime: '21:00' })])).toBeNull()
    const dep = leg({ direction: 'departure', date: '2026-12-13' })
    expect(validateTravelLegs([{ ...dep, homeDate: '2026-12-17' }])).toBe('Getting home must be on or up to 3 days after leaving.')
    expect(validateTravelLegs([{ ...dep, homeDate: '2026-12-14' }])).toBeNull()
  })

  it('limits the counts', () => {
    expect(validateTravelLegs([leg(), leg()])).toBe('You can have one arrival, one departure and up to 3 extra journeys each way.')
    const x = (i: number) => leg({ leg: 'extra', title: `T${i}` })
    expect(validateTravelLegs([x(1), x(2), x(3), x(4)])).toBe('You can have one arrival, one departure and up to 3 extra journeys each way.')
    expect(validateTravelLegs([x(1), x(2), x(3)])).toBeNull()
  })
})

describe('setMyTravel', () => {
  it('sends snake_case and replaces the whole set', async () => {
    rpc.mockResolvedValue({ data: { legs: [{ id: 'n1', direction: 'arrival', leg: 'main' }] }, error: null })
    const r = await setMyTravel('trip1', [leg({ airportCode: 'lhr', flightRef: ' JL044 ', setOffDate: '2026-12-07' })], ['k1'])
    expect(rpc).toHaveBeenCalledWith('set_my_travel', {
      p_trip_id: 'trip1',
      p_known_ids: ['k1'],
      p_legs: [
        {
          id: null,
          direction: 'arrival',
          leg: 'main',
          title: null,
          date: '2026-12-08',
          time: null,
          flight_ref: 'JL044',
          airport_code: 'LHR',
          set_off_date: '2026-12-07',
          set_off_time: null,
          home_date: null,
          home_time: null,
        },
      ],
    })
    expect(r.legs).toHaveLength(1)
  })

  it('sends an empty array to clear everything', async () => {
    rpc.mockResolvedValue({ data: { legs: [] }, error: null })
    await setMyTravel('trip1', [], ['k1', 'k2'])
    expect(rpc).toHaveBeenCalledWith('set_my_travel', { p_trip_id: 'trip1', p_legs: [], p_known_ids: ['k1', 'k2'] })
  })

  it('throws the error object as is', async () => {
    const error = { code: '22023', message: 'That date looks wrong. Check the year.', hint: 'bad_date', details: null }
    rpc.mockResolvedValue({ data: null, error })
    await expect(setMyTravel('t', [leg()], [])).rejects.toBe(error)
  })
})

describe('travelSaveErrorMessage', () => {
  it('passes the message through only for a known hint', () => {
    expect(travelSaveErrorMessage({ code: '22023', message: 'That date looks wrong. Check the year.', hint: 'bad_date' })).toBe('That date looks wrong. Check the year.')
    expect(travelSaveErrorMessage({ message: 'new row violates row-level security policy', hint: null })).toBe("Couldn't save your travel. Check your connection and try again.")
    expect(travelSaveErrorMessage({ message: 'secret', hint: 'something_else' })).toBe("Couldn't save your travel. Check your connection and try again.")
    expect(travelSaveErrorMessage(new Error('boom'))).toBe("Couldn't save your travel. Check your connection and try again.")
    expect(travelSaveErrorMessage(null)).toBe("Couldn't save your travel. Check your connection and try again.")
  })
})
