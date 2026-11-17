/**
 * Bookings can write an expense (log it, or remove the linked one when the booking is cancelled). While balances are frozen the database
 * refuses every expense write, so those two options are hidden and a save that still asks for one stops BEFORE it writes anything:
 * a booking must never be saved while its expense is refused (that would leave a booking with no expense, or a cancelled booking whose
 * expense is still counted).
 */
import { FROZEN_WRITE_MESSAGE } from '../../../lib/writeRefusals'

export const BOOKING_FROZEN_NOTE = "Balances are frozen, so expenses can't be added or removed. An organizer can unfreeze them in Settle up."

/** The message to show instead of saving, or null when the save may go ahead. */
export function bookingExpenseBlockedMessage(args: { frozen: boolean; wantsExpense: boolean; removesExpense: boolean }): string | null {
  return args.frozen && (args.wantsExpense || args.removesExpense) ? FROZEN_WRITE_MESSAGE : null
}

/** Cancelling asks what to remove only when there is something that can be removed (the expense cannot be while frozen). */
export function cancelStepNeeded(booking: { expense_id: string | null; timeline_event_id: string | null }, frozen: boolean): boolean {
  return (!frozen && !!booking.expense_id) || !!booking.timeline_event_id
}

/** A new booking on a frozen trip saves without an expense; the sheet says so in one line. */
export const BOOKING_FROZEN_NO_EXPENSE_NOTE = 'Balances are frozen, so no expense will be added.'

/** Whether a NEW booking should also create its expense (never while balances are frozen). */
export function newBookingWantsExpense(args: { createExpense: boolean; canCreateExpense: boolean; frozen: boolean }): boolean {
  return args.createExpense && args.canCreateExpense && !args.frozen
}
