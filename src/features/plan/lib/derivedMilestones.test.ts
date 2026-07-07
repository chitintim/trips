import { describe, it, expect } from 'vitest'
import {
  deriveMilestones,
  groupDerivedMilestones,
  spanCoversDate,
  dayNofM,
  tripProgressFraction,
  readDerivedKey,
  materializedDerivedKeys,
  bookingLooksLikeAccommodation,
  bookingLooksLikeFlight,
  type DeriveMilestonesInput,
} from './derivedMilestones'
import type { Booking } from '../../../lib/queries/useBookings'
import type { TimelineEvent } from '../../../types'

function booking(overrides: Partial<Booking> & { id: string; title: string }): Booking {
  return {
    trip_id: 'trip-1',
    amount: null,
    booked_by: 'user-1',
    booking_date: null,
    cancellation_deadline: null,
    confirmation_ref: null,
    created_at: '',
    currency: null,
    document_url: null,
    expense_id: null,
    notes: null,
    option_id: null,
    place_id: null,
    refundable: null,
    status: 'reserved',
    timeline_event_id: null,
    updated_at: '',
    vendor: null,
    ...overrides,
  }
}

function event(metadata: TimelineEvent['metadata']): Pick<TimelineEvent, 'metadata'> {
  return { metadata }
}

const trip = { start_date: '2026-08-01', end_date: '2026-08-05' }

describe('bookingLooksLikeAccommodation / bookingLooksLikeFlight', () => {
  it('detects accommodation vocabulary in title/vendor/notes', () => {
    expect(bookingLooksLikeAccommodation(booking({ id: 'b1', title: 'Chalet Rosalp' }))).toBe(true)
    expect(bookingLooksLikeAccommodation(booking({ id: 'b2', title: 'Dinner', vendor: 'Hotel Ibis restaurant' }))).toBe(true)
    expect(bookingLooksLikeAccommodation(booking({ id: 'b3', title: 'Airport transfer' }))).toBe(false)
  })

  it('detects flight vocabulary', () => {
    expect(bookingLooksLikeFlight(booking({ id: 'b1', title: 'BA 456 flight to Geneva' }))).toBe(true)
    expect(bookingLooksLikeFlight(booking({ id: 'b2', title: 'Easyjet booking', vendor: 'EasyJet Airways' }))).toBe(true)
    expect(bookingLooksLikeFlight(booking({ id: 'b3', title: 'Chalet Rosalp' }))).toBe(false)
  })
})

describe('readDerivedKey / materializedDerivedKeys', () => {
  it('reads the derived_key field from event metadata', () => {
    expect(readDerivedKey({ derived_key: 'arrival_day:trip' })).toBe('arrival_day:trip')
    expect(readDerivedKey(null)).toBeNull()
    expect(readDerivedKey({})).toBeNull()
    expect(readDerivedKey('not an object' as unknown as TimelineEvent['metadata'])).toBeNull()
  })

  it('collects all derived keys already materialized', () => {
    const events = [event({ derived_key: 'arrival_day:trip' }), event({ derived_key: 'flight_day:b1' }), event(null)]
    const keys = materializedDerivedKeys(events)
    expect(keys.has('arrival_day:trip')).toBe(true)
    expect(keys.has('flight_day:b1')).toBe(true)
    expect(keys.size).toBe(2)
  })
})

describe('deriveMilestones', () => {
  it('always includes arrival and departure day markers for a multi-day trip', () => {
    const input: DeriveMilestonesInput = { trip, bookings: [], events: [] }
    const milestones = deriveMilestones(input)
    expect(milestones.find((m) => m.kind === 'arrival_day')?.date).toBe('2026-08-01')
    expect(milestones.find((m) => m.kind === 'departure_day')?.date).toBe('2026-08-05')
  })

  it('skips a separate departure marker for a 1-day trip (start === end)', () => {
    const oneDay = { start_date: '2026-08-01', end_date: '2026-08-01' }
    const milestones = deriveMilestones({ trip: oneDay, bookings: [], events: [] })
    expect(milestones.filter((m) => m.kind === 'departure_day')).toHaveLength(0)
    expect(milestones.filter((m) => m.kind === 'arrival_day')).toHaveLength(1)
  })

  it('produces an accommodation span banner from a booking that looks like lodging', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    const milestones = deriveMilestones({ trip, bookings, events: [] })
    const span = milestones.find((m) => m.kind === 'accommodation_span')
    expect(span).toBeTruthy()
    expect(span!.date).toBe('2026-08-01')
    expect(span!.endDate).toBe('2026-08-05')
    expect(span!.isSpan).toBe(true)
    expect(span!.sourceBookingId).toBe('b1')
  })

  it('produces a flight day marker (not a span) from a booking that looks like a flight', () => {
    const bookings = [booking({ id: 'b2', title: 'BA456 flight', booking_date: '2026-08-01' })]
    const milestones = deriveMilestones({ trip, bookings, events: [] })
    const flight = milestones.find((m) => m.kind === 'flight_day')
    expect(flight).toBeTruthy()
    expect(flight!.isSpan).toBe(false)
    expect(flight!.date).toBe(flight!.endDate)
  })

  it('ignores bookings with no booking_date (nothing to anchor the row to)', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: null })]
    const milestones = deriveMilestones({ trip, bookings, events: [] })
    expect(milestones.find((m) => m.kind === 'accommodation_span')).toBeUndefined()
  })

  it('hides a derived row once a real event carries its derived_key (materialized)', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    const events = [event({ derived_key: 'accommodation_span:b1' }), event({ derived_key: 'arrival_day:trip' })]
    const milestones = deriveMilestones({ trip, bookings, events })
    expect(milestones.find((m) => m.kind === 'accommodation_span')).toBeUndefined()
    expect(milestones.find((m) => m.kind === 'arrival_day')).toBeUndefined()
    // Departure day was NOT materialized, so it still renders.
    expect(milestones.find((m) => m.kind === 'departure_day')).toBeTruthy()
  })
})

describe('groupDerivedMilestones', () => {
  it('separates single-day markers (grouped by date) from span banners', () => {
    const milestones = deriveMilestones({
      trip,
      bookings: [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })],
      events: [],
    })
    const { byDate, spans } = groupDerivedMilestones(milestones)
    expect(spans).toHaveLength(1)
    expect(byDate.get('2026-08-01')?.some((m) => m.kind === 'arrival_day')).toBe(true)
    expect(byDate.get('2026-08-05')?.some((m) => m.kind === 'departure_day')).toBe(true)
  })
})

describe('spanCoversDate', () => {
  it('is true for every date within [date, endDate] inclusive', () => {
    const span = { date: '2026-08-01', endDate: '2026-08-05' } as Parameters<typeof spanCoversDate>[0]
    expect(spanCoversDate(span, '2026-08-01')).toBe(true)
    expect(spanCoversDate(span, '2026-08-03')).toBe(true)
    expect(spanCoversDate(span, '2026-08-05')).toBe(true)
    expect(spanCoversDate(span, '2026-07-31')).toBe(false)
    expect(spanCoversDate(span, '2026-08-06')).toBe(false)
  })
})

describe('dayNofM', () => {
  it('computes 1-indexed day-of-trip and total days', () => {
    expect(dayNofM('2026-08-01', trip.start_date, trip.end_date)).toEqual({ n: 1, m: 5 })
    expect(dayNofM('2026-08-03', trip.start_date, trip.end_date)).toEqual({ n: 3, m: 5 })
    expect(dayNofM('2026-08-05', trip.start_date, trip.end_date)).toEqual({ n: 5, m: 5 })
  })

  it('returns null outside the trip range', () => {
    expect(dayNofM('2026-07-31', trip.start_date, trip.end_date)).toBeNull()
    expect(dayNofM('2026-08-06', trip.start_date, trip.end_date)).toBeNull()
  })
})

describe('tripProgressFraction', () => {
  it('is 0 on the first day and 1 on the last day', () => {
    expect(tripProgressFraction('2026-08-01', trip.start_date, trip.end_date)).toBe(0)
    expect(tripProgressFraction('2026-08-05', trip.start_date, trip.end_date)).toBe(1)
  })

  it('is 1 for a single-day trip (avoids divide-by-zero)', () => {
    expect(tripProgressFraction('2026-08-01', '2026-08-01', '2026-08-01')).toBe(1)
  })

  it('is null outside the trip range', () => {
    expect(tripProgressFraction('2026-07-31', trip.start_date, trip.end_date)).toBeNull()
  })
})
