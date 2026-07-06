/**
 * Estimated per-person cost band for the trip brief (plan §6): composed
 * from trips.estimated_accommodation_cost plus the leading (highest-vote,
 * or first if unvoted) option in each planning section — "~£730/person if
 * you join" at the gather-interest stage, before anything is booked.
 */
import { getPerPersonCostImpact } from '../../decisions/lib/costImpact'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { OptionVote } from '../../../lib/queries/usePlanning'

export interface CostBand {
  /** Low/high estimate in the trip's accommodation currency (or first section currency if no accommodation cost set). */
  low: number
  high: number
  currency: string
  /** Human breakdown lines for a "what's included" disclosure. */
  breakdown: Array<{ label: string; amount: number; currency: string }>
}

function leadingOptionForSection(
  section: SectionWithOptions,
  votes: OptionVote[]
): SectionWithOptions['options'][number] | null {
  const active = section.options.filter((o) => o.status !== 'cancelled' && o.price != null)
  if (active.length === 0) return null

  const voteCounts = new Map<string, number>()
  for (const v of votes) {
    if (active.some((o) => o.id === v.option_id)) {
      voteCounts.set(v.option_id, (voteCounts.get(v.option_id) || 0) + 1)
    }
  }

  if (voteCounts.size > 0) {
    return active.slice().sort((a, b) => (voteCounts.get(b.id) || 0) - (voteCounts.get(a.id) || 0))[0]
  }

  // No votes yet: use the cheapest as "low" signal, most expensive as "high" signal is handled by caller.
  return active[0]
}

export function computeCostBand(
  trip: { estimated_accommodation_cost: number | null; accommodation_cost_currency: string | null },
  sections: SectionWithOptions[],
  votes: OptionVote[],
  confirmedCount: number
): CostBand | null {
  const currency = trip.accommodation_cost_currency || sections.find((s) => s.options[0]?.currency)?.options[0]?.currency || 'GBP'
  const breakdown: Array<{ label: string; amount: number; currency: string }> = []
  let low = 0
  let high = 0

  if (trip.estimated_accommodation_cost) {
    breakdown.push({ label: 'Accommodation (estimate)', amount: trip.estimated_accommodation_cost, currency })
    low += trip.estimated_accommodation_cost
    high += trip.estimated_accommodation_cost
  }

  for (const section of sections) {
    const active = section.options.filter((o) => o.status !== 'cancelled' && o.price != null)
    if (active.length === 0) continue

    const leading = leadingOptionForSection(section, votes)
    if (!leading) continue

    const cheapest = active.reduce((min, o) => ((o.price ?? Infinity) < (min.price ?? Infinity) ? o : min), active[0])
    const priciest = active.reduce((max, o) => ((o.price ?? -Infinity) > (max.price ?? -Infinity) ? o : max), active[0])

    const lowImpact = getPerPersonCostImpact({ price: cheapest.price, currency: cheapest.currency, priceType: cheapest.price_type, confirmedCount })
    const highImpact = getPerPersonCostImpact({ price: priciest.price, currency: priciest.currency, priceType: priciest.price_type, confirmedCount })

    if (lowImpact !== null) low += lowImpact
    if (highImpact !== null) high += highImpact

    breakdown.push({ label: section.title, amount: getPerPersonCostImpact({ price: leading.price, currency: leading.currency, priceType: leading.price_type, confirmedCount }) || 0, currency: leading.currency || currency })
  }

  if (breakdown.length === 0) return null

  return { low, high, currency, breakdown }
}
