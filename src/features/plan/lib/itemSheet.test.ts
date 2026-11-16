import { describe, it, expect } from 'vitest'
import { notScheduledHeading, planItemStatus, bookingSummaryText, liveBookedOptionIds, itemMenuActions, sheetBody, localDateIso } from './itemSheet'

const base = { date: null, optionId: 'o1', sectionId: 's1' }

describe('planItemStatus from the real question state', () => {
  const winner = { ...base, stage: 'proposal' as const, isUnscheduledWinner: true, vote: { sectionStatus: 'completed' } }
  it('a decided winner is Decided, not Open', () => {
    expect(planItemStatus(winner, '2026-08-01')?.label).toBe('Decided')
    expect(planItemStatus(winner, '2026-08-01', { tripFinished: true })?.label).toBe('Decided')
  })
  it('an undecided question on a finished trip is Closed, never Open', () => {
    const open = { ...base, stage: 'proposal' as const, vote: { sectionStatus: 'in_progress' } }
    expect(planItemStatus(open, '2026-08-01', { tripFinished: true })?.label).toBe('Closed')
    expect(planItemStatus(open, '2026-08-01')?.label).toBe('Open')
  })
  it('quiet heading on finished trips', () => {
    expect(notScheduledHeading(true, 3)).toBe('Decided, not scheduled (3)')
    expect(notScheduledHeading(false, 3)).toBe('Not scheduled yet (3)')
  })
})

describe('planItemStatus', () => {
  it('uses only the approved statuses', () => {
    expect(planItemStatus({ ...base, stage: 'proposal' }, '2026-08-01')?.label).toBe('Open')
    expect(planItemStatus({ ...base, stage: 'idea' }, '2026-08-01')?.label).toBe('Open')
    expect(planItemStatus({ ...base, stage: 'decided' }, '2026-08-01')?.label).toBe('Decided')
    expect(planItemStatus({ ...base, stage: 'booked' }, '2026-08-01')?.label).toBe('Booked')
  })
  it('shows no chip for a plain event, and Done once its date has passed', () => {
    const plain = { date: '2026-08-05', optionId: null, sectionId: null }
    expect(planItemStatus({ ...plain, stage: 'decided' }, '2026-08-01')).toBeNull()
    expect(planItemStatus({ ...plain, stage: 'decided' }, '2026-08-06')?.label).toBe('Done')
    expect(planItemStatus({ ...base, date: '2026-08-05', stage: 'booked' }, '2026-08-06')?.label).toBe('Done')
  })
  it('formats local dates', () => {
    expect(localDateIso(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('booking helpers', () => {
  it('summarises a booking and skips missing parts', () => {
    expect(bookingSummaryText(null)).toBeNull()
    expect(bookingSummaryText({ amount: null, currency: null, confirmationRef: 'HMX42', vendor: null })).toBe('Booked · ref HMX42')
    expect(bookingSummaryText({ amount: 100, currency: 'GBP', confirmationRef: null, vendor: 'Hotel' })).toMatch(/^Booked · .*100.* · Hotel$/)
  })
  it('ignores cancelled bookings', () => {
    const ids = liveBookedOptionIds([
      { option_id: 'a', status: 'confirmed' },
      { option_id: 'b', status: 'cancelled' },
      { option_id: null, status: 'confirmed' },
    ])
    expect([...ids]).toEqual(['a'])
  })
})

describe('itemMenuActions', () => {
  it('gives participants nothing', () => {
    expect(itemMenuActions({ isOrganizer: false, editTarget: null, hasBooking: true, canSchedule: true })).toEqual([])
  })
  it('lists organiser item actions, delete last', () => {
    expect(itemMenuActions({ isOrganizer: true, editTarget: 'option', hasBooking: true, canSchedule: true })).toEqual(['edit_option', 'edit_booking', 'schedule', 'delete'])
    expect(itemMenuActions({ isOrganizer: true, editTarget: 'event', hasBooking: false, canSchedule: false })).toEqual(['edit_event', 'delete'])
    expect(itemMenuActions({ isOrganizer: true, editTarget: 'option', hasBooking: false, canSchedule: true, canMarkBooked: true })).toEqual(['edit_option', 'schedule', 'mark_booked', 'delete'])
    expect(itemMenuActions({ isOrganizer: false, editTarget: null, hasBooking: false, canSchedule: true, canMarkBooked: true })).toEqual([])
  })
})

describe('sheetBody', () => {
  it('shows the question for option-backed items', () => {
    expect(sheetBody({ item: { optionId: 'o', stage: 'proposal' }, section: { options: [{ id: 'o' }] } })).toBe('question')
  })
  it('is plain without a question or live options', () => {
    expect(sheetBody({ item: { optionId: null, stage: 'decided' }, section: undefined })).toBe('plain')
    expect(sheetBody({ item: { optionId: 'o', stage: 'decided' }, section: { options: [{ id: 'o', status: 'cancelled' }] } })).toBe('plain')
  })
})
