/**
 * Estimated per-person cost band for the trip brief (UX_REDESIGN.md Part 5
 * "Estimator integration"): accommodation share + the viewer's own personal
 * orders (shape 2) + a tier-aware share of already-decided group choices
 * (shape 1/3) + a min/max band across every still-open vote's cheapest vs
 * priciest option — "£680–840/person depending on open votes" rather than a
 * single misleadingly-precise number.
 */
import { getPerPersonCostImpact } from '../../decisions/lib/costImpact'
import {
  isPersonalOrderSection,
  readOptionPricing,
  readOrderItemMetadata,
  buildOrderLine,
  sumOrderLinesByCurrency,
  hasPriceTiers,
  type OrderLine,
} from '../../decisions/lib/decisionShapes'
import { tallyVotes, getWinner, type VotingMethod } from '../../decisions/lib/voting'
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
  const active = sectionActiveOptions(section)
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

/** Options that could still plausibly be the group's choice — a price or a tier schedule, and not cancelled. */
function sectionActiveOptions(section: SectionWithOptions): SectionWithOptions['options'] {
  return section.options.filter((o) => o.status !== 'cancelled' && (o.price != null || hasPriceTiers(o.metadata)))
}

/** A section counts as "decided" once its poll is closed with an actual winner — its cost becomes a fixed contribution rather than a min/max spread. */
function resolveSectionWinner(section: SectionWithOptions, votes: OptionVote[]): SectionWithOptions['options'][number] | null {
  if (section.status !== 'completed') return null
  const votingMethod = (section.voting_method as VotingMethod) || 'single'
  const optionIds = section.options.map((o) => o.id)
  const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))
  const tallies = tallyVotes(optionIds, sectionVotes, votingMethod)
  const winner = getWinner(tallies)
  if (!winner) return null
  return section.options.find((o) => o.id === winner.optionId) ?? null
}

/**
 * Sum of the viewer's own personal-order (shape 2) selections across every
 * personal-order section, in the option's own currency, grouped by
 * currency. Returns null when the viewer has no personal-order selections
 * at all (nothing to add).
 */
function computePersonalOrderTotals(sections: SectionWithOptions[], currentUserId: string | null): Record<string, number> | null {
  if (!currentUserId) return null
  const lines: OrderLine[] = []
  for (const section of sections) {
    if (!isPersonalOrderSection(section.metadata)) continue
    for (const option of section.options) {
      const pricing = readOptionPricing(option.metadata)
      if (!pricing) continue
      const mine = option.selections.filter((s) => s.user_id === currentUserId)
      for (const selection of mine) {
        const item = readOrderItemMetadata(selection.metadata)
        lines.push(buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, item, option.currency || 'GBP'))
      }
    }
  }
  if (lines.length === 0) return null
  return sumOrderLinesByCurrency(lines)
}

export function computeCostBand(
  trip: { estimated_accommodation_cost: number | null; accommodation_cost_currency: string | null },
  sections: SectionWithOptions[],
  votes: OptionVote[],
  confirmedCount: number,
  /** The viewer's own user id, to fold their personal-order (shape 2) totals into the estimate. Omit to skip that line entirely. */
  currentUserId: string | null = null
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
    // Shape 2 (personal order) sections aren't "options you vote on" — their
    // cost contribution comes from the viewer's own order total below, not
    // from a group-wide cheapest/priciest spread (nobody else's order is
    // "the" cost for you).
    if (isPersonalOrderSection(section.metadata)) continue

    const active = sectionActiveOptions(section)
    if (active.length === 0) continue

    const winner = resolveSectionWinner(section, votes)
    if (winner) {
      // Decided: a single fixed contribution (tier-aware), no more spread.
      const impact = getPerPersonCostImpact({
        price: winner.price,
        currency: winner.currency,
        priceType: winner.price_type,
        confirmedCount,
        metadata: winner.metadata,
      })
      if (impact !== null && winner.currency) {
        low += impact
        high += impact
        breakdown.push({ label: section.title, amount: impact, currency: winner.currency })
      }
      continue
    }

    // Still open: band = cheapest vs priciest option's tier-aware per-person impact.
    let sectionLow = Infinity
    let sectionHigh = -Infinity
    let sectionCurrency: string | null = null
    for (const opt of active) {
      const impact = getPerPersonCostImpact({
        price: opt.price,
        currency: opt.currency,
        priceType: opt.price_type,
        confirmedCount,
        metadata: opt.metadata,
      })
      if (impact === null) continue
      sectionLow = Math.min(sectionLow, impact)
      sectionHigh = Math.max(sectionHigh, impact)
      sectionCurrency = opt.currency || sectionCurrency
    }
    if (sectionLow === Infinity) continue
    low += sectionLow
    high += sectionHigh

    const leading = leadingOptionForSection(section, votes)
    const leadingImpact = leading
      ? getPerPersonCostImpact({ price: leading.price, currency: leading.currency, priceType: leading.price_type, confirmedCount, metadata: leading.metadata })
      : null
    breakdown.push({ label: section.title, amount: leadingImpact ?? 0, currency: leading?.currency || sectionCurrency || currency })
  }

  // Own personal orders (shape 2): folded into the numeric low/high only
  // when denominated in the band's own currency (the common case — catalog
  // items are usually priced in the trip's base currency). A different
  // currency still gets a breakdown line so it isn't silently dropped, just
  // not summed into a single cross-currency number (no live FX conversion
  // is wired into the estimator).
  const personalTotals = computePersonalOrderTotals(sections, currentUserId)
  if (personalTotals) {
    for (const [orderCurrency, amount] of Object.entries(personalTotals)) {
      if (amount <= 0) continue
      breakdown.push({ label: 'Your personal orders', amount, currency: orderCurrency })
      if (orderCurrency === currency) {
        low += amount
        high += amount
      }
    }
  }

  if (breakdown.length === 0) return null

  return { low, high, currency, breakdown }
}
