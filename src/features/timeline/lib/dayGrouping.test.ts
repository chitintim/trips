import { describe, it, expect } from 'vitest'
import {
  formatLocalDate,
  generateDateRange,
  formatDayHeader,
  computeTimelineDateRange,
  groupEventsByDate,
  computeDefaultCollapsedDays,
  classifyDay,
  findNextUpEvent,
} from './dayGrouping'
import type { TimelineEvent } from '../../../types'

function event(overrides: Partial<TimelineEvent> & { id: string; event_date: string }): TimelineEvent {
  return {
    trip_id: 'trip-1',
    title: 'Event',
    category: 'other',
    created_by: 'user-1',
    created_at: null,
    updated_at: null,
    description: null,
    end_time: null,
    location: null,
    metadata: null,
    participant_ids: null,
    place_id: null,
    sort_order: 0,
    source_option_id: null,
    start_time: null,
    all_day: false,
    ...overrides,
  } as TimelineEvent
}

describe('formatLocalDate', () => {
  it('formats a Date as local YYYY-MM-DD without UTC shifting', () => {
    expect(formatLocalDate(new Date(2026, 6, 6))).toBe('2026-07-06') // month is 0-indexed
  })
})

describe('generateDateRange', () => {
  it('includes both endpoints', () => {
    expect(generateDateRange('2026-07-01', '2026-07-03')).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('returns a single date when start === end', () => {
    expect(generateDateRange('2026-07-01', '2026-07-01')).toEqual(['2026-07-01'])
  })
})

describe('formatDayHeader', () => {
  const start = '2026-07-05'
  const end = '2026-07-10'

  it('labels a date before the trip start as Pre-trip', () => {
    const info = formatDayHeader('2026-07-04', start, end)
    expect(info.dayLabel).toBe('Pre-trip')
    expect(info.dayNumber).toBeNull()
  })

  it('labels a date after the trip end as Post-trip', () => {
    const info = formatDayHeader('2026-07-11', start, end)
    expect(info.dayLabel).toBe('Post-trip')
    expect(info.dayNumber).toBeNull()
  })

  it('labels the first day of the trip as Day 1', () => {
    const info = formatDayHeader(start, start, end)
    expect(info.dayLabel).toBe('Day 1')
    expect(info.dayNumber).toBe(1)
  })

  it('numbers subsequent days correctly', () => {
    const info = formatDayHeader('2026-07-07', start, end)
    expect(info.dayLabel).toBe('Day 3')
    expect(info.dayNumber).toBe(3)
  })
})

describe('computeTimelineDateRange', () => {
  it('covers exactly the trip dates when no events fall outside them', () => {
    const range = computeTimelineDateRange([event({ id: '1', event_date: '2026-07-06' })], '2026-07-05', '2026-07-07')
    expect(range).toEqual(['2026-07-05', '2026-07-06', '2026-07-07'])
  })

  it('expands to include an early-arrival event before trip start', () => {
    const range = computeTimelineDateRange([event({ id: '1', event_date: '2026-07-03' })], '2026-07-05', '2026-07-07')
    expect(range[0]).toBe('2026-07-03')
  })

  it('expands to include a late-departure event after trip end', () => {
    const range = computeTimelineDateRange([event({ id: '1', event_date: '2026-07-09' })], '2026-07-05', '2026-07-07')
    expect(range[range.length - 1]).toBe('2026-07-09')
  })
})

describe('groupEventsByDate', () => {
  it('groups events under their event_date preserving order', () => {
    const events = [
      event({ id: '1', event_date: '2026-07-06', sort_order: 0 }),
      event({ id: '2', event_date: '2026-07-06', sort_order: 1 }),
      event({ id: '3', event_date: '2026-07-07', sort_order: 0 }),
    ]
    const grouped = groupEventsByDate(events)
    expect(grouped.get('2026-07-06')?.map((e) => e.id)).toEqual(['1', '2'])
    expect(grouped.get('2026-07-07')?.map((e) => e.id)).toEqual(['3'])
  })

  it('returns an empty map for no events', () => {
    expect(groupEventsByDate([]).size).toBe(0)
  })
})

describe('computeDefaultCollapsedDays', () => {
  it('collapses only past days, leaving today and future expanded', () => {
    const allDates = ['2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07']
    const collapsed = computeDefaultCollapsedDays(allDates, '2026-07-06')
    expect(collapsed.has('2026-07-04')).toBe(true)
    expect(collapsed.has('2026-07-05')).toBe(true)
    expect(collapsed.has('2026-07-06')).toBe(false)
    expect(collapsed.has('2026-07-07')).toBe(false)
  })

  it('collapses nothing when every date is today or in the future (pre-trip)', () => {
    const allDates = ['2026-07-06', '2026-07-07']
    const collapsed = computeDefaultCollapsedDays(allDates, '2026-07-01')
    expect(collapsed.size).toBe(0)
  })

  it('collapses everything when every date is in the past (post-trip)', () => {
    const allDates = ['2026-07-01', '2026-07-02']
    const collapsed = computeDefaultCollapsedDays(allDates, '2026-07-10')
    expect(collapsed.size).toBe(2)
  })
})

describe('classifyDay', () => {
  it('classifies past/today/future correctly', () => {
    expect(classifyDay('2026-07-05', '2026-07-06')).toEqual({ dateStr: '2026-07-05', isToday: false, isPast: true, isFuture: false })
    expect(classifyDay('2026-07-06', '2026-07-06')).toEqual({ dateStr: '2026-07-06', isToday: true, isPast: false, isFuture: false })
    expect(classifyDay('2026-07-07', '2026-07-06')).toEqual({ dateStr: '2026-07-07', isToday: false, isPast: false, isFuture: true })
  })
})

describe('findNextUpEvent', () => {
  it('finds the next timed event later today', () => {
    const events = [
      event({ id: 'past', event_date: '2026-07-06', start_time: '08:00' }),
      event({ id: 'next', event_date: '2026-07-06', start_time: '14:00' }),
      event({ id: 'later', event_date: '2026-07-06', start_time: '18:00' }),
    ]
    const next = findNextUpEvent(events, '2026-07-06', '12:00')
    expect(next?.id).toBe('next')
  })

  it('skips events that have already started today and looks to future days', () => {
    const events = [
      event({ id: 'started', event_date: '2026-07-06', start_time: '08:00' }),
      event({ id: 'tomorrow', event_date: '2026-07-07', start_time: '09:00' }),
    ]
    const next = findNextUpEvent(events, '2026-07-06', '20:00')
    expect(next?.id).toBe('tomorrow')
  })

  it('treats an all-day event today as still upcoming', () => {
    const events = [event({ id: 'allday', event_date: '2026-07-06', all_day: true })]
    const next = findNextUpEvent(events, '2026-07-06', '23:00')
    expect(next?.id).toBe('allday')
  })

  it('returns null when there is nothing left to do', () => {
    const events = [event({ id: 'past', event_date: '2026-07-05', start_time: '08:00' })]
    expect(findNextUpEvent(events, '2026-07-06', '09:00')).toBeNull()
  })

  it('orders by sort_order when date and time tie', () => {
    const events = [
      event({ id: 'b', event_date: '2026-07-06', start_time: '10:00', sort_order: 1 }),
      event({ id: 'a', event_date: '2026-07-06', start_time: '10:00', sort_order: 0 }),
    ]
    const next = findNextUpEvent(events, '2026-07-06', '09:00')
    expect(next?.id).toBe('a')
  })
})
