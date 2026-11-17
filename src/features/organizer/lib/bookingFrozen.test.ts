import { describe, it, expect } from 'vitest'
import { BOOKING_FROZEN_NOTE, bookingExpenseBlockedMessage, cancelStepNeeded, newBookingWantsExpense, BOOKING_FROZEN_NO_EXPENSE_NOTE } from './bookingFrozen'

describe('booking flows while balances are frozen', () => {
  it('stops a save that logs or removes an expense, before anything is written', () => {
    expect(bookingExpenseBlockedMessage({ frozen: true, wantsExpense: true, removesExpense: false })).toMatch(/frozen/)
    expect(bookingExpenseBlockedMessage({ frozen: true, wantsExpense: false, removesExpense: true })).toMatch(/frozen/)
  })
  it('lets everything else through', () => {
    expect(bookingExpenseBlockedMessage({ frozen: true, wantsExpense: false, removesExpense: false })).toBeNull()
    expect(bookingExpenseBlockedMessage({ frozen: false, wantsExpense: true, removesExpense: true })).toBeNull()
  })
  it('cancel asks what to remove only when something can be removed', () => {
    expect(cancelStepNeeded({ expense_id: 'e', timeline_event_id: null }, false)).toBe(true)
    expect(cancelStepNeeded({ expense_id: 'e', timeline_event_id: null }, true)).toBe(false)
    expect(cancelStepNeeded({ expense_id: 'e', timeline_event_id: 'ev' }, true)).toBe(true)
    expect(cancelStepNeeded({ expense_id: null, timeline_event_id: null }, false)).toBe(false)
  })
  it('a new booking on a frozen trip saves without an expense instead of being refused', () => {
    expect(newBookingWantsExpense({ createExpense: true, canCreateExpense: true, frozen: true })).toBe(false)
    expect(newBookingWantsExpense({ createExpense: true, canCreateExpense: true, frozen: false })).toBe(true)
    expect(newBookingWantsExpense({ createExpense: true, canCreateExpense: false, frozen: false })).toBe(false)
    expect(BOOKING_FROZEN_NO_EXPENSE_NOTE).toBe('Balances are frozen, so no expense will be added.')
  })
  it('has a short note for the sheet', () => {
    expect(BOOKING_FROZEN_NOTE.length).toBeLessThan(160)
  })
})
