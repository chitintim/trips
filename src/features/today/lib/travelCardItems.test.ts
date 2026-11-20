import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '../../../types'
import { buildTravelCard, travelDateLabel } from './travelCardItems'

const ME = 'user-me'
const START = '2026-12-10'
const END = '2026-12-14'

let n = 0
function ev(over: Partial<TimelineEvent> & { meta?: Record<string, unknown> }): TimelineEvent {
  n += 1
  const { meta, ...rest } = over
  return {
    id: `e${n}`,
    trip_id: 't',
    event_date: START,
    start_time: null,
    end_time: null,
    all_day: false,
    title: 'Something',
    description: null,
    category: 'flight',
    location: null,
    participant_ids: [ME],
    metadata: meta ?? { travel_details: true, direction: 'arrival', leg: 'extra' },
    sort_order: 0,
    source_option_id: null,
    created_by: ME,
    created_at: '',
    updated_at: '',
    place_id: null,
    ...rest,
  } as TimelineEvent
}

const base = {
  userId: ME,
  tripStart: START,
  tripEnd: END,
  today: '2026-12-05',
  effectiveStage: 'booked_awaiting_departure' as const,
  isComing: true,
  daysToStart: 5,
}

const mainArrival = () => ev({ meta: { travel_details: true, direction: 'arrival' } })

describe('travelDateLabel', () => {
  it('uses Today, Tomorrow, then a short en-GB date', () => {
    expect(travelDateLabel('2026-12-05', '2026-12-05')).toBe('Today')
    expect(travelDateLabel('2026-12-06', '2026-12-05')).toBe('Tomorrow')
    expect(travelDateLabel('2026-12-08', '2026-12-05')).toBe('Tue 8 Dec')
    expect(travelDateLabel('2027-01-01', '2026-12-31')).toBe('Tomorrow')
  })
})

describe('buildTravelCard', () => {
  it('shows own extra legs dated today to the day before the trip, in order', () => {
    const late = ev({ event_date: '2026-12-09', start_time: '09:00:00', title: 'Train' })
    const early = ev({ event_date: '2026-12-06', start_time: '10:00:00', title: 'Flight out' })
    const m = buildTravelCard({ ...base, events: [late, early] })
    expect(m).toEqual({
      kind: 'items',
      rows: [
        expect.objectContaining({ id: early.id, dateLabel: 'Tomorrow', detail: '10:00 local · Flight out' }),
        expect.objectContaining({ id: late.id, dateLabel: 'Wed 9 Dec' }),
      ],
    })
  })

  it('ignores past dates, in-trip dates, other people and anything not mine', () => {
    const events = [
      ev({ event_date: '2026-12-04' }),
      ev({ event_date: START }),
      ev({ event_date: '2026-12-08', participant_ids: ['someone'] }),
    ]
    expect(buildTravelCard({ ...base, events: [...events, mainArrival()] })).toEqual({ kind: 'none' })
  })

  it('caps at three rows', () => {
    const events = ['06', '07', '08', '09'].map((d) => ev({ event_date: `2026-12-${d}` }))
    const m = buildTravelCard({ ...base, events })
    expect(m.kind === 'items' && m.rows.map((r) => r.date)).toEqual(['2026-12-06', '2026-12-07', '2026-12-08'])
  })

  it('after the trip shows today..end+7 and nothing inside the trip', () => {
    const after = { ...base, effectiveStage: 'trip_completed' as const, today: '2026-12-15', daysToStart: -5 }
    const home = ev({ event_date: '2026-12-16', meta: { travel_details: true, direction: 'departure', leg: 'extra' } })
    const tooLate = ev({ event_date: '2026-12-22', meta: { travel_details: true, direction: 'departure', leg: 'extra' } })
    const inside = ev({ event_date: '2026-12-13' })
    const m = buildTravelCard({ ...after, events: [home, tooLate, inside] })
    expect(m.kind === 'items' && m.rows.map((r) => r.id)).toEqual([home.id])
    const edge = ev({ event_date: '2026-12-21', meta: { travel_details: true, direction: 'departure', leg: 'extra' } })
    expect(buildTravelCard({ ...after, events: [edge] }).kind).toBe('items')
  })

  it('shows nothing while the trip is on', () => {
    expect(buildTravelCard({ ...base, effectiveStage: 'trip_ongoing', daysToStart: -1, events: [] })).toEqual({ kind: 'none' })
  })

  describe('empty state', () => {
    it('shows for a coming viewer with no main legs within 90 days', () => {
      expect(buildTravelCard({ ...base, events: [], daysToStart: 90 })).toEqual({ kind: 'empty' })
    })
    it('not beyond 90 days', () => {
      expect(buildTravelCard({ ...base, events: [], daysToStart: 91 })).toEqual({ kind: 'none' })
    })
    it('not when the viewer is not coming', () => {
      expect(buildTravelCard({ ...base, events: [], isComing: false })).toEqual({ kind: 'none' })
    })
    it('not once the viewer has a main leg', () => {
      expect(buildTravelCard({ ...base, events: [mainArrival()] })).toEqual({ kind: 'none' })
    })
    it('not once the trip is finished', () => {
      expect(buildTravelCard({ ...base, effectiveStage: 'trip_completed', events: [], daysToStart: -9 })).toEqual({ kind: 'none' })
    })
    it('items win over the prompt', () => {
      const m = buildTravelCard({ ...base, events: [ev({ event_date: '2026-12-07' })] })
      expect(m.kind).toBe('items')
    })
  })
})
