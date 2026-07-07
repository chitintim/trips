import { describe, it, expect } from 'vitest'
import {
  suggestTransfers,
  suggestAccommodationEvents,
  detectTimeClashes,
  clashedItemIds,
  detectBookingDateMismatches,
} from './companions'
import type { PlanItem } from './planItems'
import type { Booking } from '../../../lib/queries/useBookings'

function item(overrides: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    idKind: 'event',
    stage: 'decided',
    title: 'Item',
    description: null,
    date: null,
    startTime: null,
    endTime: null,
    allDay: false,
    placeId: null,
    category: null,
    optionId: null,
    eventId: overrides.id,
    bookingId: null,
    expenseId: null,
    sectionId: null,
    sectionTitle: null,
    sectionType: null,
    isMatrixSection: false,
    isPersonalOrder: false,
    vote: null,
    costImpact: null,
    booking: null,
    selections: [],
    isUnscheduledWinner: false,
    ...overrides,
  }
}

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

describe('suggestTransfers', () => {
  it('suggests a transfer for a flight with no nearby transport item', () => {
    const bookings = [booking({ id: 'b1', title: 'BA456 flight', booking_date: '2026-08-01' })]
    const suggestions = suggestTransfers(bookings, [], new Map())
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].kind).toBe('suggest_transfer')
    expect(suggestions[0].sourceBookingId).toBe('b1')
  })

  it('does not suggest when a transfer/transport item already exists that day', () => {
    const bookings = [booking({ id: 'b1', title: 'BA456 flight', booking_date: '2026-08-01' })]
    const items = [item({ id: 'e1', category: 'transfer', date: '2026-08-01', startTime: '14:00' })]
    const suggestions = suggestTransfers(bookings, items, new Map([['b1', '12:00']]))
    expect(suggestions).toHaveLength(0)
  })

  it('ignores bookings that do not look like flights', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    expect(suggestTransfers(bookings, [], new Map())).toHaveLength(0)
  })

  it('ignores bookings with no booking_date', () => {
    const bookings = [booking({ id: 'b1', title: 'BA456 flight', booking_date: null })]
    expect(suggestTransfers(bookings, [], new Map())).toHaveLength(0)
  })

  it('still suggests a transfer beyond the 3h window on the same day', () => {
    const bookings = [booking({ id: 'b1', title: 'BA456 flight', booking_date: '2026-08-01' })]
    // Transport item at 20:00, flight landed 12:00 -> outside 3h window (15:00 cutoff).
    const items = [item({ id: 'e1', category: 'transfer', date: '2026-08-01', startTime: '20:00' })]
    const suggestions = suggestTransfers(bookings, items, new Map([['b1', '12:00']]))
    expect(suggestions).toHaveLength(1)
  })
})

describe('suggestAccommodationEvents', () => {
  it('suggests check-in and check-out when neither exists', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    const suggestions = suggestAccommodationEvents(bookings, [], new Set(), '2026-08-05')
    expect(suggestions.map((s) => s.kind).sort()).toEqual(['suggest_checkin', 'suggest_checkout'])
  })

  it('skips check-in when already materialized as a derived milestone', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    const suggestions = suggestAccommodationEvents(bookings, [], new Set(['accommodation_span:b1']), '2026-08-05')
    expect(suggestions.find((s) => s.kind === 'suggest_checkin')).toBeUndefined()
    expect(suggestions.find((s) => s.kind === 'suggest_checkout')).toBeTruthy()
  })

  it('skips check-in when a real accommodation item already exists that day', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet Rosalp', booking_date: '2026-08-01' })]
    const items = [item({ id: 'e1', category: 'accommodation', date: '2026-08-01', stage: 'decided' })]
    const suggestions = suggestAccommodationEvents(bookings, items, new Set(), '2026-08-05')
    expect(suggestions.find((s) => s.kind === 'suggest_checkin')).toBeUndefined()
  })

  it('ignores non-accommodation bookings', () => {
    const bookings = [booking({ id: 'b1', title: 'BA456 flight', booking_date: '2026-08-01' })]
    expect(suggestAccommodationEvents(bookings, [], new Set(), '2026-08-05')).toHaveLength(0)
  })
})

describe('detectTimeClashes / clashedItemIds', () => {
  it('flags two overlapping timed items on the same day', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01', startTime: '19:00', endTime: '21:00' }),
      item({ id: 'b', date: '2026-08-01', startTime: '20:00', endTime: '22:00' }),
    ]
    const flags = detectTimeClashes(items)
    expect(flags).toHaveLength(1)
    expect(flags[0].itemIds.sort()).toEqual(['a', 'b'])
    expect(clashedItemIds(flags).has('a')).toBe(true)
    expect(clashedItemIds(flags).has('b')).toBe(true)
  })

  it('does not flag non-overlapping items', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01', startTime: '19:00', endTime: '20:00' }),
      item({ id: 'b', date: '2026-08-01', startTime: '20:00', endTime: '22:00' }),
    ]
    expect(detectTimeClashes(items)).toHaveLength(0)
  })

  it('ignores all-day and undated items', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01', allDay: true }),
      item({ id: 'b', date: null, startTime: '20:00' }),
      item({ id: 'c', date: '2026-08-01', startTime: '20:00', endTime: '21:00' }),
    ]
    expect(detectTimeClashes(items)).toHaveLength(0)
  })

  it('treats overnight items (end < start) as extending to end-of-day for overlap purposes', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01', startTime: '22:00', endTime: '02:00' }), // overnight
      item({ id: 'b', date: '2026-08-01', startTime: '23:00', endTime: '23:30' }),
    ]
    const flags = detectTimeClashes(items)
    expect(flags).toHaveLength(1)
  })

  it('does not flag items on different days', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01', startTime: '19:00', endTime: '21:00' }),
      item({ id: 'b', date: '2026-08-02', startTime: '19:00', endTime: '21:00' }),
    ]
    expect(detectTimeClashes(items)).toHaveLength(0)
  })
})

describe('detectBookingDateMismatches', () => {
  it('flags a booking dated outside the trip range', () => {
    const bookings = [booking({ id: 'b1', title: 'Pre-trip hotel', booking_date: '2026-07-30' })]
    const flags = detectBookingDateMismatches(bookings, '2026-08-01', '2026-08-05')
    expect(flags).toHaveLength(1)
    expect(flags[0].bookingId).toBe('b1')
  })

  it('does not flag bookings within range', () => {
    const bookings = [booking({ id: 'b1', title: 'Chalet', booking_date: '2026-08-02' })]
    expect(detectBookingDateMismatches(bookings, '2026-08-01', '2026-08-05')).toHaveLength(0)
  })

  it('ignores bookings with no date', () => {
    const bookings = [booking({ id: 'b1', title: 'TBD', booking_date: null })]
    expect(detectBookingDateMismatches(bookings, '2026-08-01', '2026-08-05')).toHaveLength(0)
  })
})
