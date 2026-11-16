/**
 * The organizer's one rough cost figure (`trips.estimated_accommodation_cost`
 * + `accommodation_cost_currency`) and how it is worded. One label for the
 * field wherever it is asked (Create trip, Confirmation settings); one line for
 * the "What 'I'm in' means" step, formatted by the one money formatter.
 */
import { formatMoney } from '../../../lib/money'

export const ROUGH_COST_LABEL = 'Rough cost per person (optional) — shown until the plan has real prices'
export const ROUGH_COST_HELP = 'People see this as an estimate, never a final price. It is saved even if confirmation tracking is off.'

/** Estimated cost for the RSVP terms: best available figure, always an estimate. */
export interface RsvpCostLine {
  /** 'your_cost' = computed from real option prices; 'organizer' = the organizer's rough figure. */
  source: 'your_cost' | 'organizer'
  /** Bold lead-in, e.g. "Your cost so far:". */
  label: string
  /** The figure, e.g. "≈£400 – £580" or "≈£500 per person". */
  figure: string
  /** Trailing words, always flagging the estimate. */
  note: string
}

/**
 * @param yourCostText  pre-formatted "Your cost" headline (yourCostHeadline(model)) when the plan has real prices; null/undefined otherwise.
 */
export function buildRsvpCostLine(
  trip: { estimated_accommodation_cost?: number | null; accommodation_cost_currency?: string | null } | null | undefined,
  yourCostText?: string | null
): RsvpCostLine | null {
  const text = yourCostText?.trim()
  if (text) {
    return { source: 'your_cost', label: 'Your cost so far:', figure: text, note: '(an estimate from the options in the plan, not a final price).' }
  }
  const amount = trip?.estimated_accommodation_cost
  if (amount != null && Number.isFinite(amount) && amount > 0) {
    const figure = `${formatMoney(amount, trip?.accommodation_cost_currency || 'GBP', { mode: 'estimate' })} per person`
    return { source: 'organizer', label: 'Rough cost from the organizer:', figure, note: '(an estimate, not a final price).' }
  }
  return null
}
