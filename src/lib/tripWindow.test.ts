import { describe, it, expect } from 'vitest'
import {
  TRAVEL_WINDOW_DAYS, addDays, travelWindow, placeDate, isBeyondTravelWindow,
  dayHeaderLabel, shortDayLabel, dateNote, boardDays,
} from './tripWindow'

const S = '2026-12-10'
const E = '2026-12-11'

describe('addDays / travelWindow', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })
  it('returns malformed input unchanged', () => {
    expect(addDays('nope', 2)).toBe('nope')
  })
  it('is 7 days either side, also for a one-day trip', () => {
    expect(TRAVEL_WINDOW_DAYS).toBe(7)
    expect(travelWindow(S, E)).toEqual({ start: '2026-12-03', end: '2026-12-18' })
    expect(travelWindow('2026-12-10', '2026-12-10')).toEqual({ start: '2026-12-03', end: '2026-12-17' })
  })
})

describe('placeDate', () => {
  it('is during on the trip days', () => {
    expect(placeDate(S, S, E)).toEqual({ place: 'during', daysOutside: 0, inWindow: true })
    expect(placeDate(E, S, E).place).toBe('during')
  })
  it('keeps 7 days before in the window and 8 beyond', () => {
    expect(placeDate('2026-12-03', S, E)).toEqual({ place: 'before', daysOutside: 7, inWindow: true })
    expect(placeDate('2026-12-02', S, E)).toEqual({ place: 'way_before', daysOutside: 8, inWindow: false })
  })
  it('keeps 7 days after in the window and 8 beyond', () => {
    expect(placeDate('2026-12-18', S, E)).toEqual({ place: 'after', daysOutside: 7, inWindow: true })
    expect(placeDate('2026-12-19', S, E)).toEqual({ place: 'way_after', daysOutside: 8, inWindow: false })
  })
  it('handles a one-day trip and a month boundary', () => {
    expect(placeDate('2026-11-30', '2026-12-01', '2026-12-01')).toEqual({ place: 'before', daysOutside: 1, inWindow: true })
    expect(placeDate('2026-12-09', '2026-12-01', '2026-12-01').place).toBe('way_after')
  })
  it('treats malformed input as during', () => {
    const during = { place: 'during', daysOutside: 0, inWindow: true }
    expect(placeDate('', S, E)).toEqual(during)
    expect(placeDate('2026-13-40', S, E)).toEqual(during)
    expect(placeDate('2026-12-05', 'x', E)).toEqual(during)
  })
})

describe('isBeyondTravelWindow', () => {
  it('is false for empty, in-window and trip dates', () => {
    expect(isBeyondTravelWindow(null, S, E)).toBe(false)
    expect(isBeyondTravelWindow(undefined, S, E)).toBe(false)
    expect(isBeyondTravelWindow('2026-12-03', S, E)).toBe(false)
    expect(isBeyondTravelWindow('2026-12-18', S, E)).toBe(false)
  })
  it('is true from 8 days out', () => {
    expect(isBeyondTravelWindow('2026-12-02', S, E)).toBe(true)
    expect(isBeyondTravelWindow('2026-12-19', S, E)).toBe(true)
  })
})

describe('labels', () => {
  it('names trip days, before and after', () => {
    expect(dayHeaderLabel(S, S, E)).toBe('Day 1')
    expect(dayHeaderLabel(E, S, E)).toBe('Day 2')
    expect(dayHeaderLabel('2026-12-05', S, E)).toBe('Before the trip')
    expect(dayHeaderLabel('2026-12-30', S, E)).toBe('After the trip')
    expect(shortDayLabel(E, S, E)).toBe('Day 2')
    expect(shortDayLabel('2026-12-05', S, E)).toBe('Before')
    expect(shortDayLabel('2026-12-30', S, E)).toBe('After')
  })
  it('numbers days across a month boundary', () => {
    expect(dayHeaderLabel('2027-01-02', '2026-12-30', '2027-01-03')).toBe('Day 4')
  })
})

describe('dateNote', () => {
  it('is null during the trip', () => {
    expect(dateNote(S, S, E)).toBeNull()
  })
  it('words in-window dates neutrally', () => {
    expect(dateNote('2026-12-09', S, E)).toEqual({ tone: 'neutral', text: 'The day before the trip starts.' })
    expect(dateNote('2026-12-05', S, E)).toEqual({ tone: 'neutral', text: '5 days before the trip starts.' })
    expect(dateNote('2026-12-12', S, E)).toEqual({ tone: 'neutral', text: 'The day after the trip ends.' })
    expect(dateNote('2026-12-15', S, E)).toEqual({ tone: 'neutral', text: '4 days after the trip ends.' })
  })
  it('asks for a check beyond the window', () => {
    expect(dateNote('2026-12-02', S, E)).toEqual({ tone: 'check', text: '8 days before the trip starts. Check the date is right.' })
    expect(dateNote('2026-12-28', S, E)).toEqual({ tone: 'check', text: '17 days after the trip ends. Check the date is right.' })
  })
})

describe('boardDays', () => {
  it('returns just the trip days with no items', () => {
    expect(boardDays([], S, E)).toEqual([S, E])
  })
  it('fills a continuous run to the furthest in-window item on each side', () => {
    expect(boardDays(['2026-12-07', '2026-12-13'], S, E)).toEqual([
      '2026-12-07', '2026-12-08', '2026-12-09', S, E, '2026-12-12', '2026-12-13',
    ])
  })
  it('adds beyond-window dates alone, without filling the gap', () => {
    expect(boardDays(['2026-12-25', '2026-11-20', '2026-12-25'], S, E)).toEqual(['2026-11-20', S, E, '2026-12-25'])
  })
  it('mixes in-window and beyond-window items, sorted and unique', () => {
    const out = boardDays(['2026-12-08', '2026-12-08', '2026-12-30'], S, E)
    expect(out).toEqual(['2026-12-08', '2026-12-09', S, E, '2026-12-30'])
  })
  it('ignores items inside the trip', () => {
    expect(boardDays([S, E], S, E)).toEqual([S, E])
  })
})
