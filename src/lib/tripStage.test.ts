import { describe, it, expect } from 'vitest'
import { effectiveTripStage, dateDerivedStage, tripStageRank, TRIP_STAGE_ORDER } from './tripStage'
import type { TripStatus } from '../types'

const trip = (status: TripStatus, start = '2026-07-10', end = '2026-07-14') => ({
  status,
  start_date: start,
  end_date: end,
})

describe('dateDerivedStage', () => {
  it('is null before the trip starts', () => {
    expect(dateDerivedStage(trip('booking_details'), '2026-07-09')).toBeNull()
  })

  it('is trip_ongoing on the start day (boundary)', () => {
    expect(dateDerivedStage(trip('booking_details'), '2026-07-10')).toBe('trip_ongoing')
  })

  it('is trip_ongoing on the end day (boundary)', () => {
    expect(dateDerivedStage(trip('booking_details'), '2026-07-14')).toBe('trip_ongoing')
  })

  it('is trip_completed the day after end', () => {
    expect(dateDerivedStage(trip('booking_details'), '2026-07-15')).toBe('trip_completed')
  })

  it('accepts Date objects and compares by local date-only', () => {
    // Late evening of the end day is still ongoing, not completed.
    expect(dateDerivedStage(trip('booking_details'), new Date(2026, 6, 14, 23, 59))).toBe('trip_ongoing')
    expect(dateDerivedStage(trip('booking_details'), new Date(2026, 6, 15, 0, 1))).toBe('trip_completed')
  })
})

describe('effectiveTripStage', () => {
  it('returns the stored status before the trip starts', () => {
    expect(effectiveTripStage(trip('gathering_interest'), '2026-07-01')).toBe('gathering_interest')
    expect(effectiveTripStage(trip('booked_awaiting_departure'), '2026-07-09')).toBe('booked_awaiting_departure')
  })

  it('upgrades to trip_ongoing when today is within the dates', () => {
    expect(effectiveTripStage(trip('gathering_interest'), '2026-07-10')).toBe('trip_ongoing')
    expect(effectiveTripStage(trip('booking_details'), '2026-07-12')).toBe('trip_ongoing')
    expect(effectiveTripStage(trip('booked_awaiting_departure'), '2026-07-14')).toBe('trip_ongoing')
  })

  it('upgrades to trip_completed when today is past end_date', () => {
    expect(effectiveTripStage(trip('booking_details'), '2026-07-15')).toBe('trip_completed')
    expect(effectiveTripStage(trip('trip_ongoing'), '2026-08-01')).toBe('trip_completed')
  })

  it('never downgrades a stored status ahead of the dates', () => {
    // Stored completed, dates say ongoing → stays completed.
    expect(effectiveTripStage(trip('trip_completed'), '2026-07-12')).toBe('trip_completed')
    // Stored completed before the trip even starts → stays completed.
    expect(effectiveTripStage(trip('trip_completed'), '2026-07-01')).toBe('trip_completed')
    // Stored ongoing while dates say ongoing → unchanged.
    expect(effectiveTripStage(trip('trip_ongoing'), '2026-07-12')).toBe('trip_ongoing')
  })
})

describe('tripStageRank', () => {
  it('orders the full lifecycle', () => {
    const ranks = TRIP_STAGE_ORDER.map(tripStageRank)
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5])
    expect(tripStageRank('trip_completed')).toBeGreaterThan(tripStageRank('trip_ongoing'))
  })
})
