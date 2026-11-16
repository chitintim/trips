/**
 * Pure derivations behind PlanItemSheet / PlanItemCard (slice 2C): which one of
 * the approved statuses an item shows, what the booking line says, which
 * organiser actions the single item menu offers, and which bookings make an
 * option "Booked". No React, no Supabase.
 *
 * Approved statuses (proposal 2.2): Open / Decided / Booked / Done. "Decided"
 * is only ever stamped on a question's option; a plain timeline event shows no
 * chip until its date has passed (then Done).
 */
import { formatMoney } from '../../../lib/money'
import type { PlanItem, PlanItemBookingInfo, PlanItemEditTarget } from './planItems'

export type ItemStatusLabel = 'Open' | 'Decided' | 'Booked' | 'Done' | 'Closed'
export type ItemStatusVariant = 'neutral' | 'success' | 'info'

export interface ItemStatus {
  label: ItemStatusLabel
  variant: ItemStatusVariant
}

type StatusInput = Pick<PlanItem, 'stage' | 'date' | 'optionId' | 'sectionId'> & {
  isUnscheduledWinner?: boolean
  vote?: { sectionStatus?: string | null } | null
}

/** Local YYYY-MM-DD (the plan's dates are calendar days, not instants). */
export function localDateIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/**
 * The status comes from the question's real state, not from the option's
 * display stage: the winner of a completed question is Decided (its stage stays
 * 'proposal' until it is booked or scheduled); a question nobody decided on a
 * finished trip is Closed, never Open.
 */
export function planItemStatus(item: StatusInput, today: string = localDateIso(), opts: { tripFinished?: boolean } = {}): ItemStatus | null {
  if (item.stage === 'idea' || item.stage === 'proposal') {
    if (item.isUnscheduledWinner && item.vote?.sectionStatus === 'completed') return { label: 'Decided', variant: 'success' }
    if (opts.tripFinished) return { label: 'Closed', variant: 'neutral' }
    return { label: 'Open', variant: 'info' }
  }
  if (item.date && item.date < today) return { label: 'Done', variant: 'neutral' }
  if (item.stage === 'booked') return { label: 'Booked', variant: 'success' }
  if (item.optionId || item.sectionId) return { label: 'Decided', variant: 'success' }
  return null
}

/** Days lens heading for decided items with no event yet. Quiet wording once the trip is over (nothing is pending). */
export function notScheduledHeading(tripFinished: boolean, count: number): string {
  return `${tripFinished ? 'Decided, not scheduled' : 'Not scheduled yet'} (${count})`
}

/** "Booked · £1,989.60 · ref HMX42" (parts that are missing are left out). */
export function bookingSummaryText(booking: Pick<PlanItemBookingInfo, 'amount' | 'currency' | 'confirmationRef' | 'vendor'> | null): string | null {
  if (!booking) return null
  const parts = ['Booked']
  if (booking.amount != null && booking.currency) parts.push(formatMoney(booking.amount, booking.currency, { mode: 'exact' }))
  if (booking.vendor) parts.push(booking.vendor)
  if (booking.confirmationRef) parts.push(`ref ${booking.confirmationRef}`)
  return parts.join(' · ')
}

/** Option ids that have a live (non-cancelled) booking row. */
export function liveBookedOptionIds(bookings: ReadonlyArray<{ option_id: string | null; status: string }>): Set<string> {
  const ids = new Set<string>()
  for (const b of bookings) if (b.option_id && b.status !== 'cancelled') ids.add(b.option_id)
  return ids
}

export type ItemMenuAction = 'edit_event' | 'edit_option' | 'edit_booking' | 'schedule' | 'delete'

export interface ItemMenuInput {
  isOrganizer: boolean
  editTarget: PlanItemEditTarget
  hasBooking: boolean
  /** Undated decided/booked item that can be put on a day. */
  canSchedule: boolean
}

/** Item-level organiser actions for the one "⋯" menu. Participants get none. */
export function itemMenuActions(input: ItemMenuInput): ItemMenuAction[] {
  if (!input.isOrganizer) return []
  const out: ItemMenuAction[] = []
  if (input.editTarget === 'event') out.push('edit_event')
  if (input.editTarget === 'option') out.push('edit_option')
  if (input.hasBooking) out.push('edit_booking')
  if (input.canSchedule) out.push('schedule')
  out.push('delete')
  return out
}

export interface SheetViewInput {
  item: Pick<PlanItem, 'optionId' | 'stage'>
  /** The question that owns this item's option, if any. */
  section: { options: ReadonlyArray<{ id: string; status?: string | null }> } | null | undefined
}

export type SheetBody = 'question' | 'plain'

/**
 * A question card (open answer control, decided outcome or booked state) shows
 * whenever the item's option belongs to a question that still has live options;
 * a plain event or a question with nothing left shows the item's own details only.
 */
export function sheetBody(input: SheetViewInput): SheetBody {
  const { section, item } = input
  if (!section || !item.optionId) return 'plain'
  const live = section.options.filter((o) => o.status !== 'cancelled')
  return live.length > 0 ? 'question' : 'plain'
}
