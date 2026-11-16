/**
 * Per-person amount an option adds, kept as a thin layer over
 * `src/lib/cost/optionPrice.ts` (`computeOptionPrice`), which owns the
 * arithmetic, the pricing basis and the certainty ladder. Everything the
 * screens print comes from `computeOptionPrice` rendered through PriceTag;
 * this stays only as the legacy-maths reference its test compares against.
 */
import { computeOptionPrice } from '../../../lib/cost/optionPrice'
import type { Enums, Json } from '../../../types/database.types'

type PriceType = Enums<'price_type'>

export interface CostImpactInput {
  price: number | null
  currency: string | null
  priceType: PriceType
  /** Number of confirmed participants the cost would be split across, for total_split options (or the relevant opted-in headcount for tiered options). */
  confirmedCount: number
  /** Option metadata — read for `price_tiers` (shape 3). Optional/omittable everywhere price_type-based pricing is all that's needed. */
  metadata?: Json | null
  /** Nights for a per-night price (metadata.price_basis 'per_night'). Omit to use `metadata.nights`, the option's date range, else 1. */
  nights?: number | null
  /** The trip, so a per-night price can derive its nights from the trip dates. Without it (or without dates) a per-night price assumes one night and is marked as an estimate. */
  trip?: { start_date?: string | null; end_date?: string | null } | null
  /** True when `confirmedCount` is an in-scope headcount estimate (RSVP tracking off, or nobody confirmed yet) rather than a real confirmed count. total_split figures then read "≈ £X per person (split across N people)". */
  isEstimate?: boolean
}

/**
 * Per-person amount this option would add, in major units of its own
 * currency. Returns null when there's no price to compute from.
 * - price_tiers present (metadata): the applicable tier's total, split
 *   across `confirmedCount` (shape 3 — takes precedence over price_type).
 * - per_person_fixed: the listed price *is* the per-person cost.
 * - total_split: the listed price is a total, divided across confirmed
 *   participants (at least 1, to avoid divide-by-zero before anyone's
 *   confirmed).
 * - per_person_tiered: same as per_person_fixed — the tiering (e.g. matrix
 *   row/column) is already baked into which option's price this is.
 */
export function getPerPersonCostImpact(input: CostImpactInput): number | null {
  const { price, currency, priceType, confirmedCount, metadata, nights, trip } = input
  if (!currency) return null
  const result = computeOptionPrice(
    { price, currency, price_type: priceType, metadata },
    trip ?? null,
    confirmedCount,
    { nights }
  )
  return result ? result.perPerson : null
}
