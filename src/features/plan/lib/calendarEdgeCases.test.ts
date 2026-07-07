import { describe, it, expect } from 'vitest'
import {
  isOutsideTripDates,
  longestCandidateRange,
  resolveBoardAnchorRange,
  isOvernightEvent,
  formatOvernightTimeRange,
  shouldSkipDayGroupingChrome,
  isLongTrip,
  chunkIntoWeeks,
  computeUserPresenceWindow,
  isWithinPresenceWindow,
  localTimeLabel,
} from './calendarEdgeCases'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'

describe('isOutsideTripDates', () => {
  it('is false for undated items', () => {
    expect(isOutsideTripDates({ date: null }, '2026-08-01', '2026-08-05')).toBe(false)
  })
  it('is false for dates within range (inclusive)', () => {
    expect(isOutsideTripDates({ date: '2026-08-01' }, '2026-08-01', '2026-08-05')).toBe(false)
    expect(isOutsideTripDates({ date: '2026-08-05' }, '2026-08-01', '2026-08-05')).toBe(false)
  })
  it('is true before start or after end', () => {
    expect(isOutsideTripDates({ date: '2026-07-31' }, '2026-08-01', '2026-08-05')).toBe(true)
    expect(isOutsideTripDates({ date: '2026-08-06' }, '2026-08-01', '2026-08-05')).toBe(true)
  })
})

function sectionWithRanges(ranges: Array<{ start: string; end: string } | null>): Pick<SectionWithOptions, 'options'> {
  return {
    options: ranges.map((range, i) => ({
      id: `opt-${i}`,
      metadata: range ? { date_range: range } : null,
    })) as unknown as SectionWithOptions['options'],
  }
}

describe('longestCandidateRange', () => {
  it('returns null when the section has no date-range options', () => {
    expect(longestCandidateRange(sectionWithRanges([null, null]))).toBeNull()
    expect(longestCandidateRange(null)).toBeNull()
  })

  it('picks the option with the most days', () => {
    const section = sectionWithRanges([
      { start: '2026-08-01', end: '2026-08-03' }, // 3 days
      { start: '2026-09-01', end: '2026-09-10' }, // 10 days
    ])
    expect(longestCandidateRange(section)).toEqual({ start: '2026-09-01', end: '2026-09-10' })
  })
})

describe('resolveBoardAnchorRange', () => {
  const trip = { start_date: '2026-01-01', end_date: '2026-01-02' }

  it('uses the trip dates directly when dates are not pending', () => {
    const section = sectionWithRanges([{ start: '2026-09-01', end: '2026-09-10' }])
    expect(resolveBoardAnchorRange(trip, false, section)).toEqual({ start: trip.start_date, end: trip.end_date })
  })

  it('anchors on the longest candidate when dates are pending', () => {
    const section = sectionWithRanges([{ start: '2026-09-01', end: '2026-09-10' }])
    expect(resolveBoardAnchorRange(trip, true, section)).toEqual({ start: '2026-09-01', end: '2026-09-10' })
  })

  it('falls back to trip placeholder dates when pending but no candidate exists', () => {
    expect(resolveBoardAnchorRange(trip, true, null)).toEqual({ start: trip.start_date, end: trip.end_date })
  })
})

describe('isOvernightEvent / formatOvernightTimeRange', () => {
  it('detects end < start as overnight', () => {
    expect(isOvernightEvent('19:00', '02:00')).toBe(true)
    expect(isOvernightEvent('09:00', '17:00')).toBe(false)
  })

  it('is false when either side is missing', () => {
    expect(isOvernightEvent(null, '02:00')).toBe(false)
    expect(isOvernightEvent('19:00', null)).toBe(false)
  })

  it('labels overnight ranges with "→ next day"', () => {
    const label = formatOvernightTimeRange('19:00', '02:00', (t) => t)
    expect(label).toBe('19:00 – 02:00 → next day')
  })

  it('does not label same-day ranges', () => {
    const label = formatOvernightTimeRange('09:00', '17:00', (t) => t)
    expect(label).toBe('09:00 – 17:00')
  })

  it('falls back to a single time when only one side is present', () => {
    expect(formatOvernightTimeRange('19:00', null, (t) => t)).toBe('19:00')
    expect(formatOvernightTimeRange(null, null, (t) => t)).toBeNull()
  })
})

describe('shouldSkipDayGroupingChrome / isLongTrip', () => {
  it('skips chrome for 0 or 1 day trips', () => {
    expect(shouldSkipDayGroupingChrome([])).toBe(true)
    expect(shouldSkipDayGroupingChrome(['2026-08-01'])).toBe(true)
    expect(shouldSkipDayGroupingChrome(['2026-08-01', '2026-08-02'])).toBe(false)
  })

  it('flags trips over 14 days as long', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`)
    const fourteen = fifteen.slice(0, 14)
    expect(isLongTrip(fifteen)).toBe(true)
    expect(isLongTrip(fourteen)).toBe(false)
  })
})

describe('chunkIntoWeeks', () => {
  it('chunks into 7-day windows and flags fully-empty weeks', () => {
    const dates = Array.from({ length: 15 }, (_, i) => `d${i + 1}`)
    const itemsByDate = new Map<string, unknown[]>([['d1', [{}]]])
    const chunks = chunkIntoWeeks(dates, itemsByDate)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].dates).toHaveLength(7)
    expect(chunks[0].isEmpty).toBe(false) // d1 has an item
    expect(chunks[1].isEmpty).toBe(true)
    expect(chunks[2].dates).toHaveLength(1) // 15 % 7 == 1
    expect(chunks[2].start).toBe('d15')
    expect(chunks[2].end).toBe('d15')
  })
})

describe('computeUserPresenceWindow / isWithinPresenceWindow', () => {
  it('returns an unbounded window when the user has no travel-details events', () => {
    const window = computeUserPresenceWindow([], 'user-1')
    expect(window).toEqual({ arrivalDate: null, departureDate: null })
    expect(isWithinPresenceWindow('2020-01-01', window)).toBe(true)
    expect(isWithinPresenceWindow('2099-01-01', window)).toBe(true)
  })

  it('derives arrival/departure from flight/transfer events tagged to the user', () => {
    const events = [
      { category: 'flight', event_date: '2026-08-03', participant_ids: ['user-1'] },
      { category: 'flight', event_date: '2026-08-08', participant_ids: ['user-1'] },
      { category: 'activity', event_date: '2026-08-01', participant_ids: null },
    ]
    const window = computeUserPresenceWindow(events, 'user-1')
    expect(window).toEqual({ arrivalDate: '2026-08-03', departureDate: '2026-08-08' })
  })

  it('ignores events tagged to other users only', () => {
    const events = [{ category: 'flight', event_date: '2026-08-03', participant_ids: ['someone-else'] }]
    const window = computeUserPresenceWindow(events, 'user-1')
    expect(window).toEqual({ arrivalDate: null, departureDate: null })
  })

  it('filters NOW/NEXT candidates by the presence window', () => {
    const window = { arrivalDate: '2026-08-03', departureDate: '2026-08-06' }
    expect(isWithinPresenceWindow('2026-08-01', window)).toBe(false) // before arrival
    expect(isWithinPresenceWindow('2026-08-04', window)).toBe(true)
    expect(isWithinPresenceWindow('2026-08-07', window)).toBe(false) // after departure
  })
})

describe('localTimeLabel', () => {
  it('appends "local"', () => {
    expect(localTimeLabel('19:00')).toBe('19:00 local')
  })
})
