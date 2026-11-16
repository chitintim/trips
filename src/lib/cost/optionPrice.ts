/**
 * ONE function that prices an option (redesign proposal 4.1-4.4):
 *
 *   computeOptionPrice(option, trip, headcount, context?) -> OptionPrice | null
 *
 * given the option's price fields, the trip (for nights), the in-scope
 * headcount (people/lib/inScopePeople) and what we know about its lifecycle,
 * it returns the per-person figure, the total, the basis, the headcount used,
 * the certainty word, whether it is an estimate, and the human line printed
 * under the price ("£2,000 total · 9 going · est.").
 *
 * Pure: no React, no Supabase. All arithmetic is in integer minor units via
 * the audited money module; the result matches the previous
 * `getPerPersonCostImpact` for every option that has no per-night basis.
 *
 * Certainty ladder (always the most certain number available):
 *   est.     the option sits on an open question
 *   decided  the option is the winner of a decided question
 *   booked   a live (non-cancelled) booking with an amount exists, OR the
 *            option carries the legacy `status = 'booked'` flag (`ctx.booked`);
 *            a flagged option is priced at its listed price and never reads est.
 *   paid     a real expense is matched to it (its amount and your share win)
 */
import { fromMinorUnits, toMinorUnits } from '../money/minorUnits'
import { formatMoney } from '../money/format'
import {
  applicableTier,
  perPersonAtTier,
  readPriceTiers,
  tierSensitivity,
} from '../../features/decisions/lib/decisionShapes'
import { deriveNights, isDividedBasis, readPriceBasis, type PriceBasis } from './priceBasis'
import type { InScopeHeadcount } from '../../features/people/lib/inScopePeople'
import type { Json } from '../../types/database.types'

export type Certainty = 'est' | 'decided' | 'booked' | 'paid'

/** Ordered least to most certain. */
export const CERTAINTY_ORDER: readonly Certainty[] = ['est', 'decided', 'booked', 'paid']

/** The word printed for each rung. */
export const CERTAINTY_WORD: Record<Certainty, string> = {
  est: 'est.',
  decided: 'decided',
  booked: 'booked',
  paid: 'paid',
}

export function certaintyRank(c: Certainty): number {
  return CERTAINTY_ORDER.indexOf(c)
}

/** The least certain of several rungs (a total is only as certain as its weakest part). */
export function weakestCertainty(list: Certainty[]): Certainty {
  if (list.length === 0) return 'est'
  return list.reduce((min, c) => (certaintyRank(c) < certaintyRank(min) ? c : min))
}

export interface PriceableOption {
  price: number | null | undefined
  currency: string | null | undefined
  /** options.price_type; per_person_tiered is read as 'each'. */
  price_type?: string | null
  metadata?: Json | null
}

export interface PriceTrip {
  start_date?: string | null
  end_date?: string | null
}

export interface PriceBooking {
  /** Booking amount: a TOTAL for the whole group. */
  amount: number | null | undefined
  currency?: string | null
  /** bookings.status: reserved | paid | cancelled. Cancelled bookings are ignored. */
  status?: string | null
}

export interface PriceActual {
  /** Total of the matched real expense(s), in `currency`. */
  total: number
  currency: string
  /** The person's own share, when known (their expense split). Otherwise total / headcount. */
  perPerson?: number
  /**
   * The viewer's own share of the matched expense(s). A number when they are on the expense; `null` when they are
   * not (the expense is not shared with them). Omit when unknown (no viewer): the old "total / headcount" rule applies.
   */
  viewerShare?: number | null
  /** How many people the expense(s) were actually split between (never the trip headcount). */
  splitCount?: number
}

export interface PriceContext {
  /** The option is the winner of a decided (closed) question. */
  decided?: boolean
  booking?: PriceBooking | null
  actual?: PriceActual | null
  /** Override the derived nights (per_night basis). */
  nights?: number | null
  /** The option carries the legacy `options.status = 'booked'` flag (live `bookings` is empty). Certainty 'booked' at the listed price. */
  booked?: boolean
  /** trips.confirmation_enabled. With tracking OFF everyone active is in scope, so the label says "going", never "invited". Omit to keep the old wording (isEstimate decides). */
  confirmationEnabled?: boolean
  /** Replace the "going"/"invited" noun (e.g. 'in' for an opt-in cost divided by the people who opted in: "4 in"). */
  headcountNoun?: string
}

export interface TierSensitivityInfo {
  aboveTop: boolean
  points: Array<{ headcount: number; perPerson: number }>
  /** "£75 each if 6 · £38 each if 12". */
  line: string | null
}

export interface OptionPrice {
  /** What it costs ONE person, major units of `currency`. */
  perPerson: number
  /** What the whole group pays, major units of `currency`. */
  total: number
  currency: string
  basis: PriceBasis
  /** People the figure is divided across (in-scope headcount). */
  headcount: number
  /** True when `headcount` is a guess (nobody has confirmed / tracking is off). */
  headcountIsEstimate: boolean
  certainty: Certainty
  /** Certainty is "est." OR the figure depends on a guessed headcount. */
  isEstimate: boolean
  /** Print a leading "≈" on the headline: a divided figure on a guessed headcount, or anything on the est. rung that is divided. Never for an `each` price. */
  approximate: boolean
  /** True when perPerson is a total divided by the headcount. */
  dividedByHeadcount: boolean
  /** The price as entered (per person, per night or total, per the basis), before any booking/expense override. */
  unitPrice: number | null
  /** per_night only. */
  nights: number | null
  nightsSource: 'option_nights' | 'option_dates' | 'trip' | 'default' | null
  /** per_night with no nights anywhere (option, option dates, trip dates): the figure assumes ONE night and is marked as an estimate. */
  nightsAssumed: boolean
  /** The bold line: "≈£222 each". */
  headline: string
  /** The line under it: "£2,000 total · 9 going · est.". */
  basisLine: string
  /** by_group_size only. */
  sensitivity: TierSensitivityInfo | null
  /** Set when the figure comes from a real expense that knows who it was split between. `viewerShare` null = viewer not on it. */
  actualSplit: { viewerShare: number | null; splitCount: number } | null
  /** The quiet "listed at £248.70" line, only when a real expense replaced a different listed price. */
  listedLine: string | null
}

function normaliseHeadcount(headcount: InScopeHeadcount | number): { count: number; isEstimate: boolean } {
  if (typeof headcount === 'number') return { count: Math.max(0, Math.floor(headcount)), isEstimate: false }
  return { count: Math.max(0, Math.floor(headcount.count)), isEstimate: headcount.isEstimate }
}

function splitMinor(totalMinor: number, divisor: number): number {
  return Math.round(totalMinor / Math.max(divisor, 1))
}

/**
 * "going" or "invited", following the in-scope rule (people/lib/inScopePeople):
 * tracking OFF -> everyone active is "going"; tracking ON -> "going" once at
 * least one person has confirmed, "invited" until then. `confirmationEnabled`
 * undefined keeps the old rule (estimate = invited).
 */
export function countNoun(isEstimate: boolean, confirmationEnabled?: boolean): 'invited' | 'going' {
  if (confirmationEnabled === false) return 'going'
  return isEstimate ? 'invited' : 'going'
}

/** "9 going" / "9 invited". */
export function headcountLabel(count: number, isEstimate: boolean, confirmationEnabled?: boolean): string {
  return `${count} ${countNoun(isEstimate, confirmationEnabled)}`
}

/** "£75 each if 6 · £38 each if 12" from sensitivity points (ends only), or null. */
export function tierSensitivityLine(points: Array<{ headcount: number; perPerson: number }>, currency: string): string | null {
  if (points.length === 0) return null
  // Whole-unit headline rounding on both ends ("£75 each if 6 · £38 each if 12"), the same rounding as the "≈£222" headline.
  const part = (p: { headcount: number; perPerson: number }) =>
    `${formatMoney(p.perPerson, currency, { estimate: true }).replace('≈', '')} each if ${p.headcount}`
  if (points.length === 1) return part(points[0])
  return `${part(points[0])} · ${part(points[points.length - 1])}`
}

/**
 * Price an option. Returns null when there is nothing to compute from (no
 * currency, or no price and no tiers).
 *
 * @param trip     for the per-night basis (nights default to the trip's); may be null.
 * @param headcount `inScopeHeadcount(...)`; a bare number counts as confirmed.
 */
export function computeOptionPrice(
  option: PriceableOption,
  trip: PriceTrip | null | undefined,
  headcount: InScopeHeadcount | number,
  context: PriceContext = {}
): OptionPrice | null {
  const { count, isEstimate: headcountIsEstimate } = normaliseHeadcount(headcount)
  const basis = readPriceBasis(option)
  const entered = option.price == null ? null : Number(option.price)
  const tiers = basis === 'by_group_size' ? readPriceTiers(option.metadata) : []

  // The currency the figures are in: a live booking or matched expense can differ from the option's.
  const bookingLive =
    !!context.booking && context.booking.amount != null && Number.isFinite(Number(context.booking.amount)) && context.booking.status !== 'cancelled'
  const optionCurrency = option.currency || null
  const currency =
    context.actual?.currency || (bookingLive ? context.booking?.currency || optionCurrency : optionCurrency)
  if (!currency) return null

  const hasListedPrice = entered != null && Number.isFinite(entered)
  if (!hasListedPrice && tiers.length === 0 && !bookingLive && !context.actual) return null

  const divisor = Math.max(count, 1)
  let nights: number | null = null
  let nightsSource: OptionPrice['nightsSource'] = null
  let totalMinor = 0
  let perPersonMinor = 0
  let sensitivity: TierSensitivityInfo | null = null
  let actualSplit: OptionPrice['actualSplit'] = null
  let listedTotalMinor: number | null = null

  const listedCurrency = optionCurrency ?? currency
  if (hasListedPrice || tiers.length > 0) {
    const priceMinor = hasListedPrice ? toMinorUnits(entered as number, listedCurrency) : 0
    if (basis === 'each') {
      perPersonMinor = priceMinor
      totalMinor = priceMinor * count
    } else if (basis === 'total_split') {
      totalMinor = priceMinor
      perPersonMinor = splitMinor(totalMinor, divisor)
    } else if (basis === 'per_night') {
      const derived =
        context.nights != null && context.nights >= 1
          ? { nights: Math.round(context.nights), source: 'option_nights' as const }
          : deriveNights(option.metadata, trip)
      nights = derived.nights
      nightsSource = derived.source
      totalMinor = priceMinor * nights
      perPersonMinor = splitMinor(totalMinor, divisor)
    } else {
      const resolution = applicableTier(tiers, count)
      if (resolution) {
        totalMinor = toMinorUnits(resolution.tier.total, listedCurrency)
        perPersonMinor = toMinorUnits(perPersonAtTier(resolution.tier, count, listedCurrency), listedCurrency)
        const points = tierSensitivity(tiers, listedCurrency)
        sensitivity = { aboveTop: resolution.aboveTop, points, line: tierSensitivityLine(points, listedCurrency) }
      }
    }
  }

  let certainty: Certainty = context.decided ? 'decided' : 'est'
  // Legacy status flag: booked at the listed price (a live booking below overrides the amount).
  if (context.booked) certainty = 'booked'

  if (bookingLive) {
    totalMinor = toMinorUnits(Number(context.booking?.amount), currency)
    perPersonMinor = splitMinor(totalMinor, divisor)
    certainty = 'booked'
    sensitivity = null
  }
  if (context.actual) {
    listedTotalMinor = totalMinor
    totalMinor = toMinorUnits(context.actual.total, currency)
    const a = context.actual
    if (a.viewerShare !== undefined && a.splitCount != null && a.splitCount > 0) {
      // A real expense knows who it was split between: never divide it by the trip headcount.
      actualSplit = { viewerShare: a.viewerShare, splitCount: a.splitCount }
      perPersonMinor = a.viewerShare != null ? toMinorUnits(a.viewerShare, currency) : splitMinor(totalMinor, a.splitCount)
    } else {
      perPersonMinor = a.perPerson != null ? toMinorUnits(a.perPerson, currency) : splitMinor(totalMinor, divisor)
    }
    certainty = 'paid'
    sensitivity = null
  }

  const effectiveBasis: PriceBasis = basis
  const divided = isDividedBasis(effectiveBasis) || bookingLive || !!context.actual
  // An `each` price is the listed price verbatim (no minor-unit round trip), as the old cost-impact maths returned it.
  const perPerson =
    effectiveBasis === 'each' && !bookingLive && !context.actual && hasListedPrice
      ? (entered as number)
      : fromMinorUnits(perPersonMinor, currency)
  const total = fromMinorUnits(totalMinor, currency)
  // Paid figures are real and exact; everything else is an estimate while the question is open or the headcount is a guess.
  const guessedHeadcount = divided && headcountIsEstimate && certainty !== 'paid'
  // A per-night price with no nights anywhere assumed one night: never presented as exact.
  const nightsAssumed = effectiveBasis === 'per_night' && !bookingLive && !context.actual && nightsSource === 'default'
  const isEstimate = certainty === 'est' || guessedHeadcount || nightsAssumed
  const approximate = certainty !== 'paid' && ((divided && (guessedHeadcount || certainty === 'est')) || nightsAssumed)

  const word = CERTAINTY_WORD[certainty]
  const money = (v: number) => formatMoney(v, currency, { mode: certainty === 'paid' ? 'exact' : 'headline' })
  const hc = context.headcountNoun ? `${count} ${context.headcountNoun}` : headcountLabel(count, headcountIsEstimate, context.confirmationEnabled)
  let basisLine: string
  if (certainty === 'paid' && actualSplit) {
    basisLine = `${money(total)} total · split between ${actualSplit.splitCount} · ${word}`
  } else if (certainty === 'paid') {
    basisLine = `${money(total)} total · ${hc} · ${word}`
  } else if (effectiveBasis === 'each' && !bookingLive) {
    basisLine = `per person · ${word}`
  } else if (nightsAssumed) {
    basisLine = `${money(Number(entered))}/night · nights not set · ${hc} · ${word === 'est.' ? word : `${word} · est.`}`
  } else if (effectiveBasis === 'per_night' && !bookingLive && nights != null) {
    basisLine = `${money(Number(entered))}/night · ${nights} ${nights === 1 ? 'night' : 'nights'} · ${money(total)} total · ${hc} · ${word}`
  } else {
    basisLine = `${money(total)} total · ${hc} · ${word}`
  }

  // The listed estimate stays as a quiet secondary line when a real expense replaced a different figure.
  let listedLine: string | null = null
  if (context.actual && hasListedPrice && listedTotalMinor != null && listedTotalMinor !== totalMinor && optionCurrency === currency) {
    const unit = formatMoney(entered as number, currency, { mode: 'headline' })
    listedLine = `listed at ${effectiveBasis === 'each' ? `${unit} each` : effectiveBasis === 'per_night' ? `${unit}/night` : unit}`
    basisLine = `${basisLine} · ${listedLine}`
  }
  // Not on the expense: the headline already says total, split and paid; keep only the quiet listed line.
  if (actualSplit && actualSplit.viewerShare == null) basisLine = listedLine ?? ''

  const exactMoney = (v: number) => formatMoney(v, currency, { mode: 'exact' })
  const headline = actualSplit
    ? actualSplit.viewerShare != null
      ? `${exactMoney(perPerson)} — your share`
      : `${exactMoney(total)} total · split between ${actualSplit.splitCount} · paid`
    : `${formatMoney(perPerson, currency, approximate ? { estimate: true } : { mode: certainty === 'paid' ? 'exact' : 'headline' })} each`

  return {
    perPerson,
    total,
    currency,
    basis: effectiveBasis,
    headcount: count,
    headcountIsEstimate,
    certainty,
    isEstimate,
    approximate,
    dividedByHeadcount: divided,
    unitPrice: hasListedPrice ? (entered as number) : null,
    nights,
    nightsSource,
    nightsAssumed,
    headline,
    basisLine,
    sensitivity,
    actualSplit,
    listedLine,
  }
}
