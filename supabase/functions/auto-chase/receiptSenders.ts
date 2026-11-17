// Adapter between the daily job and the shared receipt notice senders (_shared/receiptNoticeSend.ts, written by the edge-functions slice).
// The senders enforce dedupe `notice:receipt:<expense>:<user>:<kind>`, the per-person cap and every email gate themselves; this file only
// binds the email sender + app URL, and converts the RPC's currency-unit amounts to the minor units the senders take.
import type { EmailSender } from '../_shared/emailSender.ts'
import { toMinorUnits } from '../_shared/money/minorUnits.ts'
import { sendReceiptReminderNotice, sendReceiptResultNotice } from '../_shared/receiptNoticeSend.ts'

// deno-lint-ignore no-explicit-any
export type AdminClient = any

export interface ReminderNoticeArgs { admin: AdminClient; expenseId: string; userId: string; deadline: string }
/** `amount` / `totalAfter` are what `apply_receipt_deadline` returned (currency units, `people[].amount` / `people[].total_after`). */
export interface ResultNoticeArgs { admin: AdminClient; expenseId: string; userId: string; amount: number; totalAfter: number | null; currency: string | null }
export interface NoticeOutcome { sent: boolean; reason?: string | null }

export interface ReceiptNoticeSenders {
  sendReceiptReminderNotice(args: ReminderNoticeArgs): Promise<NoticeOutcome | void>
  sendReceiptResultNotice(args: ResultNoticeArgs): Promise<NoticeOutcome | void>
}

/** The shared functions, injectable so tests can pass fakes. */
export interface SharedSenders {
  sendReceiptReminderNotice: typeof sendReceiptReminderNotice
  sendReceiptResultNotice: typeof sendReceiptResultNotice
}
const REAL: SharedSenders = { sendReceiptReminderNotice, sendReceiptResultNotice }

/**
 * Binds the shared senders to this run's email sender. Returns null when no email provider is configured: the passes then still APPLY
 * deadlines (money correctness never depends on email) and only skip the emails; result notices stay recoverable for 7 days.
 */
export function createReceiptSenders(sender: EmailSender, appBaseUrl: string, shared: SharedSenders = REAL): ReceiptNoticeSenders | null {
  if (!sender.available) return null
  return {
    sendReceiptReminderNotice: ({ admin, expenseId, userId }) => shared.sendReceiptReminderNotice(admin, sender, { expenseId, userId, appBaseUrl }),
    sendReceiptResultNotice: ({ admin, expenseId, userId, amount, totalAfter, currency }) => {
      const code = currency ?? 'GBP'
      const leftoverAmountMinor = toMinorUnits(amount, code)
      const totalMinor = toMinorUnits(totalAfter ?? amount, code)
      return shared.sendReceiptResultNotice(admin, sender, { expenseId, userId, leftoverAmountMinor, totalMinor, appBaseUrl })
    },
  }
}
