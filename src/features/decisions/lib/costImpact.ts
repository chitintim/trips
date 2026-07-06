/**
 * Per-option cost impact + running per-person total (plan §7): "choosing
 * this adds ~£54/person", computed from price_type x confirmed count,
 * using the audited money module for the actual arithmetic (no float
 * splits) and a light Intl formatter for display.
 */
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import type { Enums } from '../../../types/database.types'

type PriceType = Enums<'price_type'>

export interface CostImpactInput {
  price: number | null
  currency: string | null
  priceType: PriceType
  /** Number of confirmed participants the cost would be split across, for total_split options. */
  confirmedCount: number
}

/**
 * Per-person amount this option would add, in major units of its own
 * currency. Returns null when there's no price to compute from.
 * - per_person_fixed: the listed price *is* the per-person cost.
 * - total_split: the listed price is a total, divided across confirmed
 *   participants (at least 1, to avoid divide-by-zero before anyone's
 *   confirmed).
 * - per_person_tiered: same as per_person_fixed — the tiering (e.g. matrix
 *   row/column) is already baked into which option's price this is.
 */
export function getPerPersonCostImpact(input: CostImpactInput): number | null {
  const { price, currency, priceType, confirmedCount } = input
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

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export function formatCostImpact(input: CostImpactInput): string | null {
  const perPerson = getPerPersonCostImpact(input)
  if (perPerson === null || !input.currency) return null
  return `+${formatMoney(perPerson, input.currency)}/person`
}

/**
 * Running per-person total for a section: sums the cost impact of every
 * "leading" option (currently: every option with a vote/selection, or if
 * none yet, every non-cancelled option — organizer can narrow this later).
 * Grouped by currency since a section can in principle mix currencies
 * (rare, but the plan doesn't rule it out).
 */
export function getSectionRunningTotal(
  options: Array<{ price: number | null; currency: string | null; price_type: PriceType; status: string }>,
  confirmedCount: number,
  leadingOptionIds: Set<string> | null,
  optionIds: string[]
): Record<string, number> {
  const totals: Record<string, number> = {}
  options.forEach((opt, i) => {
    if (opt.status === 'cancelled') return
    const id = optionIds[i]
    if (leadingOptionIds && leadingOptionIds.size > 0 && !leadingOptionIds.has(id)) return
    const impact = getPerPersonCostImpact({ price: opt.price, currency: opt.currency, priceType: opt.price_type, confirmedCount })
    if (impact === null || !opt.currency) return
    totals[opt.currency] = (totals[opt.currency] || 0) + impact
  })
  return totals
}
