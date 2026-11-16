/**
 * Pure rules behind the Decide sheet and the Mark booked sheet (proposal 5.6):
 * which toggles start on, what the single `decide_question` call is sent, the
 * validation that stops a bad submit, and the toast words. No React, no
 * Supabase; unit-tested.
 */
import type { BookTodo, DecideInput, DecideResult, PutOnPlan } from '../../../lib/queries/useDecide'
import type { MarkBookedBooking } from '../../../lib/queries/useBookings'
import type { Json } from '../../../types/database.types'

/** Question kinds where a "Book it" to-do makes sense by default. */
export const BOOKABLE_SECTION_TYPES: ReadonlyArray<string> = ['accommodation', 'flights', 'transport', 'activities', 'lessons']

export function isBookableSectionType(sectionType: string | null | undefined): boolean {
  return !!sectionType && BOOKABLE_SECTION_TYPES.includes(sectionType)
}

export interface OptionPlanDate {
  date: string
  startTime: string | null
  endTime: string | null
}

function metaObject(metadata: Json | null | undefined): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HH_MM = /^\d{2}:\d{2}/

/** The date an option already carries (`proposed_date` + times), or null. */
export function readOptionPlanDate(optionMetadata: Json | null | undefined, sectionMetadata?: Json | null): OptionPlanDate | null {
  for (const meta of [metaObject(optionMetadata), metaObject(sectionMetadata)]) {
    const d = meta.proposed_date
    if (typeof d === 'string' && ISO_DATE.test(d)) {
      const s = meta.proposed_start_time
      const e = meta.proposed_end_time
      return {
        date: d,
        startTime: typeof s === 'string' && HH_MM.test(s) ? s.slice(0, 5) : null,
        endTime: typeof e === 'string' && HH_MM.test(e) ? e.slice(0, 5) : null,
      }
    }
  }
  return null
}

export interface DecideDefaults {
  putOnPlan: boolean
  bookTodo: boolean
}

/** Starting positions of the two toggles: on the plan when the option has a date, a Book it to-do for bookable kinds. */
export function decideDefaults(args: { sectionType: string | null | undefined; optionDate: OptionPlanDate | null }): DecideDefaults {
  return { putOnPlan: !!args.optionDate, bookTodo: isBookableSectionType(args.sectionType) }
}

/** Timeline category for an event made from a question of this kind (mirrors the RPC). */
export function eventCategoryForSection(sectionType: string | null | undefined): 'accommodation' | 'flight' | 'transport' | 'activity' | 'other' {
  switch (sectionType) {
    case 'accommodation':
      return 'accommodation'
    case 'flights':
      return 'flight'
    case 'transport':
      return 'transport'
    case 'activities':
    case 'lessons':
      return 'activity'
    default:
      return 'other'
  }
}

export interface DecideFormState {
  sectionId: string
  /** Own choice: no winner is recorded. */
  own: boolean
  optionId: string | null
  putOnPlan: boolean
  date: string
  startTime: string
  bookTodo: boolean
  /** User id the to-do is for (the viewer for "Me"). */
  assignedTo: string | null
  dueDate: string
}

/** Why the Decide button must stay disabled, or null. */
export function decideBlocker(form: DecideFormState, tied = false): string | null {
  if (form.own) return null
  if (!form.optionId) return tied ? 'It is a tie. Choose the winner.' : 'Choose the winning option.'
  if (form.putOnPlan && !ISO_DATE.test(form.date)) return 'Pick a day for the plan.'
  if (form.bookTodo && form.dueDate && !ISO_DATE.test(form.dueDate)) return 'That due date is not valid.'
  return null
}

/** The ONE `decide_question` payload. Own choice sends only the section. */
export function buildDecideInput(form: DecideFormState): DecideInput {
  if (form.own) return { sectionId: form.sectionId }
  const putOnPlan: PutOnPlan | null = form.putOnPlan
    ? { date: form.date, ...(form.startTime ? { start_time: form.startTime, all_day: false } : { all_day: true }) }
    : null
  const bookTodo: BookTodo | null = form.bookTodo
    ? { ...(form.assignedTo ? { assigned_to: form.assignedTo } : {}), ...(form.dueDate ? { due_date: form.dueDate } : {}) }
    : null
  return { sectionId: form.sectionId, optionId: form.optionId, putOnPlan, bookTodo }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "17 Aug" from YYYY-MM-DD (no timezone surprises). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}`.trim()
}

/** Success toast: "Decided: Osaka Airbnb — it's on the plan for 17 Aug". */
export function decideToastMessage(args: { own: boolean; sectionTitle: string; optionTitle: string | null; planDate: string | null; result: Pick<DecideResult, 'event_id' | 'action_id' | 'already_decided'> }): {
  message: string
  description?: string
} {
  if (args.own) return { message: `Answers closed: ${args.sectionTitle}` }
  const title = args.optionTitle ?? args.sectionTitle
  const onPlan = !!args.result.event_id
  const message = onPlan && args.planDate ? `Decided: ${title} — it's on the plan for ${shortDate(args.planDate)}` : `Decided: ${title}`
  return { message, description: args.result.action_id ? 'A to-do to book it was added.' : undefined }
}

// ---------------------------------------------------------------------------
// Mark booked
// ---------------------------------------------------------------------------

export interface MarkBookedForm {
  optionTitle: string
  reference: string
  amount: string
  currency: string
}

/** Parsed amount > 0, else null. */
export function parsePaidAmount(raw: string): number | null {
  const n = parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The `booking` argument of mark_booked: null when no details were given (only the
 * flag is set and the Book it to-do completes), else the keys that were filled in.
 * An amount makes the booking 'paid'.
 */
export function buildMarkBookedBooking(form: MarkBookedForm): MarkBookedBooking | null {
  const ref = form.reference.trim()
  const amount = parsePaidAmount(form.amount)
  if (!ref && amount == null) return null
  return {
    title: form.optionTitle.slice(0, 120),
    ...(ref ? { confirmation_ref: ref.slice(0, 80) } : {}),
    ...(amount != null ? { amount, currency: form.currency.trim().toUpperCase() || undefined, status: 'paid' as const } : { status: 'reserved' as const }),
  }
}

/** True when, after Mark booked, the sheet should offer to log the amount as an expense. */
export function shouldOfferExpense(form: Pick<MarkBookedForm, 'amount'>, bookingId: string | null): boolean {
  return !!bookingId && parsePaidAmount(form.amount) != null
}
