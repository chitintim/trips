/**
 * Per-option cost impact + running per-person total (plan §7): "choosing
 * this adds ~£54/person", computed from price_type x confirmed count,
 * using the audited money module for the actual arithmetic (no float
 * splits) and a light Intl formatter for display.
 *
 * Tier-aware (UX_REDESIGN.md Part 5, shape 3 "tiered group pricing"): when
 * an option carries `metadata.price_tiers` (see decisionShapes.ts), those
 * headcount breakpoints take precedence over price/price_type for the
 * per-person figure — "≈£50/person at 9" instead of the flat total_split
 * math — with a sensitivity line ("£75/pp if 6 · £38/pp if 12") available
 * via getTierSensitivityLine for option cards to render underneath.
 */
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { readPriceTiers, applicableTier, perPersonAtTier, tierSensitivity } from './decisionShapes'
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
}

/** True when this option's metadata carries at least one price tier — tiered pricing takes over from price/price_type when present. */
export function isTieredCostImpact(metadata: Json | null | undefined): boolean {
  return readPriceTiers(metadata).length > 0
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
  const { price, currency, priceType, confirmedCount, metadata } = input

  if (currency) {
    const tiers = readPriceTiers(metadata)
    if (tiers.length > 0) {
      const resolution = applicableTier(tiers, confirmedCount)
      if (resolution) return perPersonAtTier(resolution.tier, confirmedCount, currency)
    }
  }

  if (price === null || price === undefined || !currency) return null

  if (priceType === 'total_split') {
    const divisor = Math.max(confirmedCount, 1)
    const minor = toMinorUnits(price, currency)
    // Per-person share for display purposes only (not a settlement split,
    // so ordinary division + round-trip through minor units is sufficient
    // precision — the actual expense split, if this option is later booked,
    // goes through the largest-remainder distributor in lib/money/distribute).
    return fromMinorUnits(Math.round(minor / divisor), currency)
  }

  // per_person_fixed | per_person_tiered
  return price
}

/**
 * Resolved tier info for an option (null when it has no price_tiers). Used
 * by option cards to know whether to render the "at N people" suffix and
 * the sensitivity line, and by the organizer to flag when a winning
 * option's headcount has grown past its top tier.
 */
export interface TierImpactInfo {
  aboveTop: boolean
  sensitivity: Array<{ headcount: number; perPerson: number }>
}

export function getTierImpactInfo(input: CostImpactInput): TierImpactInfo | null {
  if (!input.currency) return null
  const tiers = readPriceTiers(input.metadata)
  if (tiers.length === 0) return null
  const resolution = applicableTier(tiers, input.confirmedCount)
  if (!resolution) return null
  return { aboveTop: resolution.aboveTop, sensitivity: tierSensitivity(tiers, input.currency) }
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** Headline cost-impact string: "≈£50/person at 9 people" when tiered, "+£54/person" otherwise. */
export function formatCostImpact(input: CostImpactInput): string | null {
  const perPerson = getPerPersonCostImpact(input)
  if (perPerson === null || !input.currency) return null

  const tierInfo = getTierImpactInfo(input)
  if (tierInfo) {
    const count = input.confirmedCount
    const peopleLabel = count === 1 ? 'person' : 'people'
    return `≈${formatMoney(perPerson, input.currency)}/person${count > 0 ? ` at ${count} ${peopleLabel}` : ''}`
  }

  return `+${formatMoney(perPerson, input.currency)}/person`
}

/** Sensitivity line for a tiered option ("£75/pp if 6 · £38/pp if 12"), or null when the option isn't tiered. */
export function getTierSensitivityLine(input: CostImpactInput): string | null {
  const tierInfo = getTierImpactInfo(input)
  if (!tierInfo || !input.currency || tierInfo.sensitivity.length === 0) return null
  const currency = input.currency
  if (tierInfo.sensitivity.length === 1) {
    const point = tierInfo.sensitivity[0]
    return `${formatMoney(point.perPerson, currency)}/pp if ${point.headcount}`
  }
  const first = tierInfo.sensitivity[0]
  const last = tierInfo.sensitivity[tierInfo.sensitivity.length - 1]
  return `${formatMoney(first.perPerson, currency)}/pp if ${first.headcount} · ${formatMoney(last.perPerson, currency)}/pp if ${last.headcount}`
}

/**
 * Running per-person total for a section: sums the cost impact of every
 * "leading" option (currently: every option with a vote/selection, or if
 * none yet, every non-cancelled option — organizer can narrow this later).
 * Grouped by currency since a section can in principle mix currencies
 * (rare, but the plan doesn't rule it out).
 */
export function getSectionRunningTotal(
  options: Array<{ price: number | null; currency: string | null; price_type: PriceType; status: string; metadata?: Json | null }>,
  confirmedCount: number,
  leadingOptionIds: Set<string> | null,
  optionIds: string[]
): Record<string, number> {
  const totals: Record<string, number> = {}
  options.forEach((opt, i) => {
    if (opt.status === 'cancelled') return
    const id = optionIds[i]
    if (leadingOptionIds && leadingOptionIds.size > 0 && !leadingOptionIds.has(id)) return
    const impact = getPerPersonCostImpact({ price: opt.price, currency: opt.currency, priceType: opt.price_type, confirmedCount, metadata: opt.metadata })
    if (impact === null || !opt.currency) return
    totals[opt.currency] = (totals[opt.currency] || 0) + impact
  })
  return totals
}
