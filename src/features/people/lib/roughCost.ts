/**
 * The organizer's one rough cost figure (`trips.estimated_accommodation_cost`
 * + `accommodation_cost_currency`) and how it is worded. One label for the
 * field wherever it is asked (Create trip, Confirmation settings); one line for
 * the "What 'I'm in' means" step, formatted by the one money formatter.
 */
import { formatMoney } from '../../../lib/money'

export const ROUGH_COST_LABEL = 'Rough cost per person (optional) — shown until the plan has real prices'
export const ROUGH_COST_HELP = 'People see this as an estimate, never a final price. It is saved even if confirmation tracking is off.'

/**
 * The organizer's rough figure, worded identically on Today and in the RSVP step: the entered figure first,
 * converted second when currencies differ, headline rounding (no pence on an estimate).
 *   same currency / no rate:  "≈¥246,795 each"
 *   rate known:               "≈¥246,795 each (about £1,139)"
 * @param convertedBase  the amount in the trip's base currency at the same rate Your cost uses, or null when there is no rate.
 */
export function formatRoughEstimate(
  amount: number,
  currency: string,
  baseCurrency: string,
  convertedBase?: number | null
): string {
  const entered = `${formatMoney(amount, currency, { mode: 'estimate' })} each`
  if (!baseCurrency || currency === baseCurrency || convertedBase == null || !Number.isFinite(convertedBase)) return entered
  return `${entered} (about ${formatMoney(convertedBase, baseCurrency, { mode: 'estimate' }).replace('≈', '')})`
}

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
  yourCostText?: string | null,
  /** Base currency + the rough figure converted into it (from the Your-cost model's estimate line). */
  conversion?: { baseCurrency: string; convertedBase: number | null } | null
): RsvpCostLine | null {
  const text = yourCostText?.trim()
  if (text) {
    return { source: 'your_cost', label: 'Your cost so far:', figure: text, note: '(an estimate from the options in the plan, not a final price).' }
  }
  const amount = trip?.estimated_accommodation_cost
  if (amount != null && Number.isFinite(amount) && amount > 0) {
    const figure = formatRoughEstimate(amount, trip?.accommodation_cost_currency || 'GBP', conversion?.baseCurrency ?? '', conversion?.convertedBase ?? null)
    return { source: 'organizer', label: 'Rough cost from the organizer:', figure, note: '(an estimate, not a final price).' }
  }
  return null
}
