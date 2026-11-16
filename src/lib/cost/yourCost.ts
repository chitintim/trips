/**
 * "Your cost for this trip" (redesign proposal 4.5): ONE pure model that
 * answers "what does this trip cost ME?", replacing the old CostBand and
 * "Decided so far" maths. No React, no Supabase.
 *
 * Rules (numbers refer to proposal 4.5):
 *  1. Per question.
 *     - DECIDED: contributes the winner's price (resolveWinner), divided by
 *       the in-scope headcount for totals; a live booking replaces it with
 *       the booking amount / headcount ("booked").
 *     - OPEN and a shared cost (`section.metadata.cost_scope = 'everyone'`;
 *       legacy default: section_type accommodation / flights / transport /
 *       insurance): a min-max range across its priced options.
 *     - OPEN and an opt-in cost (everything else): only the options YOU
 *       answered. An opt-in activity you have not chosen adds nothing (it is
 *       counted in `optionalNotChosen`).
 *     - OWN CHOICE (decision_shape 'personal'): your own picks, with
 *       quantities, dates and variants (existing catalog order maths).
 *  2. Plan entries with a cost (`trip_timeline_events.metadata.cost`, see
 *     `EventCost`). An event created from a priced option is not counted
 *     twice.
 *  3. The organiser's rough figure (`trips.estimated_accommodation_cost`) is
 *     used ONLY while no accommodation question has a priced option.
 *  4. Reconciliation with real expenses. An expense linked to the WINNER
 *     (decided) or to a BOOKED option (open) (`expenses.option_id`,
 *     `expenses.booking_id`, or `bookings.expense_id`) is matched to that
 *     option only: while the expenses add up to less than the booking / listed
 *     total the line stays the larger of your paid split and the estimate and
 *     reads "£X paid of ≈£Y"; once they cover it the line is "paid" at your
 *     split. A deposit on a losing option never rewrites a line. "Already
 *     spent" is your share of every expense, from `computeBalances`; money
 *     maths is never re-implemented here. Once the trip is finished AND you
 *     appear in at least one expense the model switches to mode 'share'
 *     ("Your share") with the estimate kept for comparison; otherwise it stays
 *     the estimate with an honest note.
 *
 *     Booked means a live booking OR the legacy `options.status = 'booked'`
 *     flag. An open question with several booked options (two consecutive
 *     stays) sums them: one line per booked option. A decided question whose
 *     cost scope is opt-in counts only for people who answered with the winner;
 *     opt-in totals divide by the people who opted in ("4 in"), not everyone.
 *  5. Currency. Totals are in the trip base currency. A line in another
 *     currency is converted with the rate you pass in `fxRates` (base per 1
 *     unit; the app's latest cached rate via `getFXRate` in lib/currency),
 *     is marked "≈", and keeps its own currency in `native`. A currency with
 *     no rate is left out of the totals and listed in `missingRates`.
 *
 * Money is converted via integer minor units (lib/money).
 */
import { fromMinorUnits, toMinorUnits } from '../money/minorUnits'
import { formatMoney, formatMoneyRange } from '../money/format'
import {
  computeOptionPrice,
  countNoun,
  weakestCertainty,
  type Certainty,
  type OptionPrice,
  type PriceContext,
  type PriceTrip,
} from './optionPrice'
import {
  buildOrderLine,
  withTripDays,
  hasPriceTiers,
  isPersonalOrderSection,
  readOptionPricing,
  readOrderItemMetadata,
} from '../../features/decisions/lib/decisionShapes'
import { resolveWinner } from '../../features/decisions/lib/resolveDecision'
import { computeBalances } from '../../features/expenses/lib/balances'
import { isTripFinished } from '../answers/answers'
import type { InScopeHeadcount } from '../../features/people/lib/inScopePeople'
import type { ExpenseWithDetails } from '../queries/useExpenses'
import type { Json } from '../../types/database.types'
import type { TripStatus } from '../../types'

// ---------------------------------------------------------------------------
// Metadata conventions
// ---------------------------------------------------------------------------

/** Who a question's cost lands on: everyone (shared) or only the people who opt in. */
export type CostScope = 'everyone' | 'opt_in'

const SHARED_SECTION_TYPES = new Set(['accommodation', 'flights', 'transport', 'insurance'])

/** `planning_sections.metadata.cost_scope`, else the legacy default by section_type. */
export function readCostScope(section: { section_type?: string | null; metadata?: Json | null }): CostScope {
  const meta = section.metadata && typeof section.metadata === 'object' && !Array.isArray(section.metadata) ? (section.metadata as Record<string, unknown>) : {}
  if (meta.cost_scope === 'everyone' || meta.cost_scope === 'opt_in') return meta.cost_scope
  return SHARED_SECTION_TYPES.has(section.section_type ?? '') ? 'everyone' : 'opt_in'
}

/**
 * `trip_timeline_events.metadata.cost`: what a plan entry costs. Written by
 * the event editor / Add to plan (slice 3D); no migration (metadata jsonb).
 *  - basis 'each': every person who is in pays `amount`.
 *  - basis 'total_split': `amount` is a total shared between the people in.
 */
export interface EventCost {
  amount: number
  currency: string
  basis: 'each' | 'total_split'
}

export function readEventCost(metadata: Json | null | undefined): EventCost | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const c = (metadata as Record<string, unknown>).cost
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const { amount, currency, basis } = c as Record<string, unknown>
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN
  if (!Number.isFinite(n) || n <= 0 || typeof currency !== 'string' || currency.length === 0) return null
  return { amount: n, currency: currency.toUpperCase(), basis: basis === 'total_split' ? 'total_split' : 'each' }
}

/** New event metadata with `cost` set (or removed when `cost` is null / not a positive amount). Other keys are kept. */
export function withEventCost(metadata: Json | null | undefined, cost: EventCost | null): Json {
  const base: Record<string, unknown> =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {}
  if (cost && Number.isFinite(cost.amount) && cost.amount > 0 && cost.currency) {
    base.cost = { amount: cost.amount, currency: cost.currency.toUpperCase(), basis: cost.basis }
  } else {
    delete base.cost
  }
  return base as Json
}

// ---------------------------------------------------------------------------
// Inputs (structural: query rows fit as-is)
// ---------------------------------------------------------------------------

export interface CostOptionInput {
  id: string
  title: string
  price: number | null
  currency: string | null
  price_type?: string | null
  status?: string | null
  metadata?: Json | null
  order_index?: number | null
  created_at?: string | null
  selections?: ReadonlyArray<{ user_id: string; metadata?: Json | null }> | null
}

export interface CostSectionInput {
  id: string
  title: string
  section_type?: string | null
  status: string
  metadata?: Json | null
  voting_method?: string | null
  options: ReadonlyArray<CostOptionInput>
}

export interface CostVoteInput {
  option_id: string
  user_id: string
  rank?: number | null
}

export interface CostEventInput {
  id: string
  title: string
  metadata?: Json | null
  participant_ids?: string[] | null
  source_option_id?: string | null
}

export interface CostBookingInput {
  id?: string
  option_id: string | null
  amount: number | null
  currency?: string | null
  status?: string | null
  expense_id?: string | null
}

export interface YourCostInput {
  trip: {
    start_date: string
    end_date: string
    status: TripStatus
    base_currency?: string | null
    estimated_accommodation_cost?: number | null
    accommodation_cost_currency?: string | null
  }
  /** The viewer. Null (signed out) yields only shared-cost lines. */
  userId: string | null
  headcount: InScopeHeadcount | number
  sections: ReadonlyArray<CostSectionInput>
  votes?: ReadonlyArray<CostVoteInput>
  events?: ReadonlyArray<CostEventInput>
  bookings?: ReadonlyArray<CostBookingInput>
  /** Real expenses (useExpenses). Needed for "paid" lines and "already spent". */
  expenses?: ReadonlyArray<ExpenseWithDetails>
  /** Active trip participant ids (so the ledger includes the viewer). */
  participantUserIds?: ReadonlyArray<string>
  /** Base-currency units per ONE unit of the key currency, e.g. { JPY: 0.0052 } on a GBP trip. */
  fxRates?: Readonly<Record<string, number>>
  /** For "Rough estimate from Tim". */
  organizerName?: string | null
  /** trips.confirmation_enabled. Decides "going" vs "invited" in every headcount label. */
  confirmationEnabled?: boolean
  /** Whether the viewer is in scope (going / not declined). `false` + no expense of theirs: the card says so instead of estimating. Default true. */
  viewerInScope?: boolean
  now?: Date | string
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type YourCostLineKind = 'question' | 'own_picks' | 'event' | 'estimate'

/** What the right-hand note says: booked / paid / decided are certainty words; the rest say how the line arose. */
export type YourCostQualifier = 'paid' | 'booked' | 'decided' | 'open' | 'your_pick' | 'your_picks' | 'on_plan' | 'rough_estimate'

export type YourCostDeepLink =
  | { type: 'question'; sectionId: string; optionId: string | null }
  | { type: 'event'; eventId: string }
  | { type: 'trip_settings' }

export interface YourCostLine {
  /** Stable React key. */
  id: string
  kind: YourCostLineKind
  label: string
  sectionType: string | null
  /** Where tapping the row goes. */
  deepLink: YourCostDeepLink
  /** Base-currency per-person range. Null when the currency has no rate (then the line is left out of totals). low === high for a single figure. */
  low: number | null
  high: number | null
  isRange: boolean
  /** The same range in the line's own currency (the first currency when figures mix currencies; never a range across currencies). */
  native: { low: number; high: number; currency: string }
  /** One range per currency the line's figures are in (one entry unless the options use different currencies). */
  nativeByCurrency: Array<{ currency: string; low: number; high: number }>
  /** Some figures had no exchange rate and were left out of low/high (the line is partly priced). */
  partial: boolean
  /** The line was converted from another currency (print "≈"). */
  converted: boolean
  certainty: Certainty
  /** Print a leading "≈" (estimate, or converted). */
  approx: boolean
  qualifier: YourCostQualifier
  /** Human note for the row: "booked", "open: 2 options", "your picks", "you're in", "Rough estimate from Tim". */
  note: string
  /** Options considered (ranges). */
  optionCount: number
  /** "£2,000 total · 9 going · est." for single priced options. */
  basisLine: string | null
  /** At least one figure is a total divided by the headcount (so "N going/invited" matters). */
  dividedByHeadcount: boolean
  /** A real expense is linked to this item but the viewer is not on it: shown as "Not shared with you", never in the totals. */
  notShared: boolean
}

export interface YourCostTotals {
  low: number
  high: number
  isRange: boolean
  /** Any line is an estimate or converted. */
  approx: boolean
  /** The weakest rung among the lines. */
  certainty: Certainty
  /** Ready to print: "≈£1,150 – £1,310". */
  text: string
}

export interface YourCostModel {
  /** 'estimate' while planning/travelling; 'share' once the trip is finished. */
  mode: 'estimate' | 'share'
  /** "Your cost for this trip" | "Your share". */
  title: string
  currency: string
  headcount: number
  headcountIsEstimate: boolean
  lines: YourCostLine[]
  /** Totals of the lines (the estimate), always present. */
  totals: YourCostTotals
  /** Your share of every real expense so far, base currency (from computeBalances). Null when no expenses were passed. */
  alreadySpent: number | null
  /** mode 'share': the headline figure (= alreadySpent). Null in estimate mode. */
  share: number | null
  /** mode 'share': the faded estimate under it. Null in estimate mode. */
  estimateForComparison: YourCostTotals | null
  /** What the figure leaves out ("flights you book yourself", ...). */
  notIncluded: string[]
  /** Opt-in questions with a price that you have not chosen yet. */
  optionalNotChosen: number
  /** Currencies that had no rate and were left out of the totals. */
  missingRates: string[]
  /** Expense ids with no FX rate (excluded from "already spent"; surface a warning). */
  expensesMissingRate: string[]
  /** Labels of lines that could not be priced because their data was unusable; they are left out (with a console warning), never thrown. */
  failedLines: string[]
  /** "going" or "invited", following the in-scope rule incl. the confirmation-tracking flag. */
  headcountNoun: 'going' | 'invited'
  /** An honest sentence about the figure (finished trip without your expenses, ...), else null. */
  note: string | null
  /** The viewer's share of each real expense (base currency, > 0), biggest first. Powers the "what's in it" list on a finished trip. */
  expenseShares: Array<{ id: string; title: string; share: number }>
  /** 'no_costs': finished trip and the viewer is on no expense. 'not_going': the viewer is not in scope. */
  emptyReason: 'no_costs' | 'not_going' | null
  isEmpty: boolean
}

export const YOUR_COST_NOT_INCLUDED: readonly string[] = ['flights you book yourself', 'food & drink on the day']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liveOptions(section: CostSectionInput): CostOptionInput[] {
  return section.options.filter((o) => o.status !== 'cancelled')
}

function isPriced(o: CostOptionInput): boolean {
  return (o.price != null && Number.isFinite(Number(o.price))) || hasPriceTiers(o.metadata)
}

function isLiveBooking(b: CostBookingInput): boolean {
  return b.status !== 'cancelled' && b.amount != null && Number.isFinite(Number(b.amount))
}

interface Converter {
  base: string
  missing: Set<string>
  toBase(amount: number, currency: string): { amount: number | null; converted: boolean }
}

function makeConverter(base: string, fxRates: Readonly<Record<string, number>> | undefined): Converter {
  const missing = new Set<string>()
  return {
    base,
    missing,
    toBase(amount, currency) {
      if (!currency || currency === base) return { amount, converted: false }
      const rate = fxRates?.[currency]
      if (rate == null || !Number.isFinite(rate) || rate <= 0) {
        missing.add(currency)
        return { amount: null, converted: true }
      }
      return { amount: fromMinorUnits(toMinorUnits(amount * rate, base), base), converted: true }
    },
  }
}

function sumMinor(values: number[], currency: string): number {
  return fromMinorUnits(values.reduce((acc, v) => acc + toMinorUnits(v, currency), 0), currency)
}

interface Figure {
  /** Own-currency amount. */
  amount: number
  currency: string
  certainty: Certainty
  approximate: boolean
  divided: boolean
  basisLine: string | null
}

function figureOf(p: OptionPrice): Figure {
  return { amount: p.perPerson, currency: p.currency, certainty: p.certainty, approximate: p.approximate, divided: p.dividedByHeadcount, basisLine: p.basisLine }
}

/**
 * What a plan entry's cost is for ONE person. The single function behind both
 * Today's "Your cost" and Plan's price tag, so the same event never shows two
 * numbers: a cost split between an event's attendees divides by the attendees
 * when the event has them, else by the in-scope headcount.
 */
export function computeEventPrice(
  event: { metadata?: Json | null; participant_ids?: string[] | null },
  trip: PriceTrip | null | undefined,
  headcount: InScopeHeadcount | number,
  ctx: PriceContext = {}
): OptionPrice | null {
  const cost = readEventCost(event.metadata)
  if (!cost) return null
  const attendees = event.participant_ids ?? []
  const hasAttendees = attendees.length > 0
  return computeOptionPrice(
    { price: cost.amount, currency: cost.currency, price_type: cost.basis === 'total_split' ? 'total_split' : 'per_person_fixed', metadata: null },
    trip,
    hasAttendees ? { count: attendees.length, isEstimate: false } : headcount,
    { decided: true, ...(hasAttendees ? { headcountNoun: 'in' } : {}), ...ctx }
  )
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * The real expenses that belong to an option: by `expenses.option_id`, by the
 * option's live booking (`expenses.booking_id`) or by `bookings.expense_id`.
 * The one matching rule for Your cost, Plan and the item sheet.
 */
export function matchOptionExpenses(
  optionId: string,
  bookings: ReadonlyArray<CostBookingInput>,
  expenses: ReadonlyArray<ExpenseWithDetails>
): ExpenseWithDetails[] {
  const own = bookings.filter((b) => b.option_id === optionId && isLiveBooking(b))
  const bookingIds = new Set(own.map((b) => b.id).filter(Boolean) as string[])
  const expenseIds = new Set(own.map((b) => b.expense_id).filter(Boolean) as string[])
  return expenses.filter((e) => e.option_id === optionId || expenseIds.has(e.id) || (!!e.booking_id && bookingIds.has(e.booking_id)))
}

/** Base-currency minor units the expenses add up to (what was actually paid out). */
export function paidTotalMinor(list: ReadonlyArray<ExpenseWithDetails>, ledgerIds: string[], base: string): number {
  if (list.length === 0) return 0
  const { balances } = computeBalances([...list], [], ledgerIds, base)
  return balances.reduce((acc, b) => acc + b.totalPaidMinor, 0)
}

/**
 * The "actual" figure for an option's price: what its matched expenses add up to, in the trip's base currency.
 * Null when nothing was spent. With `userId` it also says who the money was really split between (`splitCount`,
 * never the trip headcount) and the viewer's own share (`viewerShare`; null = not on the expense).
 */
export function actualFromExpenses(
  matched: ReadonlyArray<ExpenseWithDetails>,
  ledgerIds: string[],
  base: string,
  userId?: string | null
): { total: number; currency: string; viewerShare?: number | null; splitCount?: number } | null {
  const minor = paidTotalMinor(matched, ledgerIds, base)
  if (minor <= 0) return null
  const out: { total: number; currency: string; viewerShare?: number | null; splitCount?: number } = { total: fromMinorUnits(minor, base), currency: base }
  if (userId) {
    const ids = [...new Set([...ledgerIds, userId])]
    const { balances } = computeBalances([...matched], [], ids, base)
    const mine = balances.find((b) => b.userId === userId)?.totalOwedMinor ?? 0
    const splitCount = balances.filter((b) => b.totalOwedMinor > 0).length
    if (splitCount > 0) {
      out.splitCount = splitCount
      out.viewerShare = mine > 0 ? fromMinorUnits(mine, base) : null
    }
  }
  return out
}

export function buildYourCost(input: YourCostInput): YourCostModel {
  const { trip, userId, sections } = input
  const base = trip.base_currency || trip.accommodation_cost_currency || 'GBP'
  const hc = typeof input.headcount === 'number' ? { count: input.headcount, isEstimate: false } : input.headcount
  const votes = input.votes ?? []
  const events = input.events ?? []
  const bookings = input.bookings ?? []
  const expenses = input.expenses ?? []
  const conv = makeConverter(base, input.fxRates)
  const finished = isTripFinished(trip, input.now)
  const confirmationEnabled = input.confirmationEnabled

  const ledgerIds = [...new Set([...(input.participantUserIds ?? []), ...(userId ? [userId] : [])])]
  const myShareMinorOf = (list: ReadonlyArray<ExpenseWithDetails>): number => {
    if (!userId || list.length === 0) return 0
    const { balances } = computeBalances([...list], [], ledgerIds, base)
    return balances.find((b) => b.userId === userId)?.totalOwedMinor ?? 0
  }
  /** Base-currency minor units the matched expenses add up to (what was actually paid out). */
  const paidTotalMinorOf = (list: ReadonlyArray<ExpenseWithDetails>): number => paidTotalMinor(list, ledgerIds, base)

  const lines: YourCostLine[] = []
  const failedLines: string[] = []
  let optionalNotChosen = 0

  const myVoteOptionIds = new Set(votes.filter((v) => v.user_id === userId).map((v) => v.option_id))
  const iAnswered = (o: CostOptionInput): boolean =>
    myVoteOptionIds.has(o.id) || !!o.selections?.some((s) => s.user_id === userId)
  /** People who chose this option (votes + selections): the headcount an opt-in total divides by. Never below 1. */
  const optedInCount = (o: CostOptionInput): number => {
    const ids = new Set<string>()
    for (const v of votes) if (v.option_id === o.id) ids.add(v.user_id)
    for (const sel of o.selections ?? []) ids.add(sel.user_id)
    if (userId && iAnswered(o)) ids.add(userId)
    return Math.max(ids.size, 1)
  }

  // Booking / expense matching, per option.
  const bookingsOf = (o: CostOptionInput): CostBookingInput[] => bookings.filter((b) => b.option_id === o.id && isLiveBooking(b))
  const isBookedOption = (o: CostOptionInput): boolean => o.status === 'booked' || bookingsOf(o).length > 0
  const expensesOf = (o: CostOptionInput): ExpenseWithDetails[] => matchOptionExpenses(o.id, bookings, expenses)

  const pushLine = (
    line: Omit<YourCostLine, 'low' | 'high' | 'isRange' | 'native' | 'nativeByCurrency' | 'partial' | 'converted' | 'approx' | 'dividedByHeadcount' | 'notShared'> & {
      figures: Figure[]
      notShared?: boolean
    }
  ): void => {
    const { figures, notShared = false, ...rest } = line
    // One native range PER currency: a range never mixes currencies.
    const byCurrency = new Map<string, { low: number; high: number }>()
    for (const f of figures) {
      const cur = byCurrency.get(f.currency)
      byCurrency.set(f.currency, cur ? { low: Math.min(cur.low, f.amount), high: Math.max(cur.high, f.amount) } : { low: f.amount, high: f.amount })
    }
    const nativeByCurrency = [...byCurrency].map(([currency, r]) => ({ currency, ...r }))
    const native = nativeByCurrency[0]
    const convertedFigures = figures.map((f) => conv.toBase(f.amount, f.currency))
    const usable = convertedFigures.filter((c): c is { amount: number; converted: boolean } => c.amount != null)
    const converted = convertedFigures.some((c) => c.converted)
    const partial = usable.length > 0 && usable.length < convertedFigures.length
    const low = usable.length > 0 ? Math.min(...usable.map((u) => u.amount)) : null
    const high = usable.length > 0 ? Math.max(...usable.map((u) => u.amount)) : null
    lines.push({
      ...rest,
      low,
      high,
      isRange: low != null && high != null ? low !== high : native.low !== native.high || nativeByCurrency.length > 1,
      native,
      nativeByCurrency,
      partial,
      converted,
      approx: converted || partial || figures.some((f) => f.approximate || f.certainty === 'est'),
      dividedByHeadcount: figures.some((f) => f.divided),
      notShared,
    })
  }

  const priceOption = (option: CostOptionInput, ctx: PriceContext, headcount: InScopeHeadcount = hc): OptionPrice | null =>
    computeOptionPrice(
      { price: option.price, currency: option.currency, price_type: option.price_type, metadata: option.metadata },
      trip,
      headcount,
      { booked: option.status === 'booked', confirmationEnabled, ...ctx }
    )

  /**
   * One line for a decided winner or a booked option, reconciled with the real
   * expenses linked to THAT option. Returns false when there was nothing to show.
   */
  const emitOption = (
    section: CostSectionInput,
    option: CostOptionInput,
    where: { id: string; label: string; decided: boolean }
  ): boolean => {
    const scope = readCostScope(section)
    const optIn = scope === 'opt_in'
    const headcount: InScopeHeadcount = optIn ? { count: optedInCount(option), isEstimate: true } : hc
    const booking = bookingsOf(option)[0] ?? null
    const p = priceOption(option, { decided: where.decided, booking, ...(optIn ? { headcountNoun: 'in' } : {}) }, headcount)
    const matched = userId ? expensesOf(option) : []

    const emit = (figure: Figure, certainty: Certainty, note: string, basisLine: string | null): void => {
      pushLine({
        id: where.id,
        kind: 'question',
        label: where.label,
        sectionType: section.section_type ?? null,
        deepLink: { type: 'question', sectionId: section.id, optionId: option.id },
        figures: [figure],
        certainty,
        qualifier: certainty === 'paid' ? 'paid' : certainty === 'booked' ? 'booked' : 'decided',
        note,
        optionCount: 1,
        basisLine,
      })
    }

    if (matched.length === 0) {
      if (!p) return false
      emit(figureOf(p), p.certainty, p.certainty === 'booked' ? 'booked' : 'decided', p.basisLine)
      return true
    }

    const minePaid = fromMinorUnits(myShareMinorOf(matched), base)
    if (minePaid <= 0) {
      // A real expense exists but the viewer is not on it: say so, never "£0 paid", and keep it out of their total.
      if (scope !== 'everyone') return false
      pushLine({
        id: where.id,
        kind: 'question',
        label: where.label,
        sectionType: section.section_type ?? null,
        deepLink: { type: 'question', sectionId: section.id, optionId: option.id },
        figures: [{ amount: 0, currency: base, certainty: 'paid', approximate: false, divided: false, basisLine: null }],
        certainty: 'paid',
        qualifier: 'paid',
        note: 'Not shared with you',
        optionCount: 1,
        basisLine: null,
        notShared: true,
      })
      return true
    }
    const paidFigure = (certainty: Certainty): Figure => ({ amount: minePaid, currency: base, certainty, approximate: false, divided: false, basisLine: null })
    if (!p) {
      // Nothing priced, only real money: the paid split is the line.
      if (minePaid <= 0 && scope !== 'everyone') return false
      emit(paidFigure('paid'), 'paid', 'paid', null)
      return true
    }
    const totalBase = conv.toBase(p.total, p.currency).amount
    const perBase = conv.toBase(p.perPerson, p.currency).amount
    if (totalBase == null || perBase == null) {
      // Cannot compare without a rate: keep the priced figure (it is reported in missingRates).
      emit(figureOf(p), p.certainty, p.certainty === 'booked' ? 'booked' : 'decided', p.basisLine)
      return true
    }
    const fullyPaid = paidTotalMinorOf(matched) >= toMinorUnits(totalBase, base) - 1
    if (fullyPaid) {
      if (minePaid <= 0 && scope !== 'everyone') return false
      emit(paidFigure('paid'), 'paid', 'paid', null)
      return true
    }
    // Part paid (a deposit): never less than the estimate, and say how far along it is.
    const paidOf = `${formatMoney(minePaid, base, { mode: 'exact' })} paid of ${formatMoney(perBase, base, { estimate: true })}`
    const amount = Math.max(minePaid, perBase)
    emit(
      { amount, currency: base, certainty: p.certainty, approximate: p.approximate || minePaid > perBase, divided: p.dividedByHeadcount, basisLine: null },
      p.certainty,
      paidOf,
      `${paidOf} · ${p.basisLine}`
    )
    return true
  }

  // --- 1. Questions ---------------------------------------------------------
  const processSection = (section: CostSectionInput): void => {
    const live = liveOptions(section)
    if (live.length === 0) return

    // Own choice: your picks.
    if (isPersonalOrderSection(section.metadata)) {
      if (!userId) return
      const perCurrency = new Map<string, { totals: number[]; assumedDays: Set<number> }>()
      let picks = 0
      for (const option of live) {
        for (const sel of (option.selections ?? []).filter((s) => s.user_id === userId)) {
          const rawItem = readOrderItemMetadata(sel.metadata)
          const pricing = readOptionPricing(option.metadata)
          const currency = option.currency || base
          let total: number | null = null
          let assumed: number | null = null
          if (pricing) {
            // A per-day pick with no dates covers the trip's days, not one day.
            const withDays = withTripDays(pricing, rawItem, trip)
            assumed = withDays.assumedDays
            total = buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, withDays.item, base).total
          } else if (isPriced(option)) {
            const qty = rawItem.quantity && rawItem.quantity > 0 ? rawItem.quantity : 1
            total = fromMinorUnits(toMinorUnits(Number(option.price), currency) * qty, currency)
          }
          if (total == null || total <= 0) continue
          picks += 1
          const entry = perCurrency.get(currency) ?? { totals: [], assumedDays: new Set<number>() }
          entry.totals.push(total)
          if (assumed != null) entry.assumedDays.add(assumed)
          perCurrency.set(currency, entry)
        }
      }
      if (picks === 0) return
      const decided = section.status === 'completed'
      for (const [currency, entry] of perCurrency) {
        const days = [...entry.assumedDays]
        const basisLine = days.length > 0 ? days.map((d) => `× ${d} ${d === 1 ? 'day' : 'days'}`).join(' · ') + ' (no dates picked yet)' : null
        pushLine({
          id: `picks:${section.id}:${currency}`,
          kind: 'own_picks',
          label: section.title,
          sectionType: section.section_type ?? null,
          deepLink: { type: 'question', sectionId: section.id, optionId: null },
          figures: [{ amount: sumMinor(entry.totals, currency), currency, certainty: decided ? 'decided' : 'est', approximate: days.length > 0, divided: false, basisLine }],
          certainty: decided ? 'decided' : 'est',
          qualifier: 'your_picks',
          note: 'your picks',
          optionCount: picks,
          basisLine,
        })
      }
      return
    }

    const priced = live.filter(isPriced)
    const scope = readCostScope(section)

    // Decided question: the winner.
    if (section.status === 'completed') {
      const id = resolveWinner(
        {
          status: section.status,
          metadata: section.metadata ?? null,
          voting_method: section.voting_method ?? null,
          options: section.options.map((o) => ({
            id: o.id,
            status: o.status ?? 'available',
            order_index: o.order_index,
            created_at: o.created_at,
            metadata: o.metadata,
          })),
        },
        votes as CostVoteInput[]
      ).optionId
      const winner = section.options.find((o) => o.id === id) ?? null
      if (!winner) return // closed without a decision: nothing to count
      // "Optional — only people who choose it pay": a decided winner is yours only if you answered with it.
      if (scope === 'opt_in' && !iAnswered(winner)) {
        if (isPriced(winner) || isBookedOption(winner)) optionalNotChosen += 1
        return
      }
      emitOption(section, winner, { id: `q:${section.id}`, label: section.title, decided: true })
      return
    }

    // Open question with booked options (live booking or the legacy status flag): every booked option counts.
    const bookedAll = live.filter(isBookedOption)
    if (bookedAll.length > 0) {
      const mine = bookedAll.filter((o) => scope === 'everyone' || iAnswered(o))
      if (mine.length === 0) {
        optionalNotChosen += 1
        return
      }
      let emitted = 0
      for (const option of mine) {
        const only = mine.length === 1
        if (emitOption(section, option, { id: only ? `q:${section.id}` : `q:${section.id}:${option.id}`, label: only ? section.title : `${section.title} · ${option.title}`, decided: false })) emitted += 1
      }
      if (emitted > 0) return
    }

    // Open question. On a finished trip it was never decided and will not happen: it costs nothing.
    if (finished) return
    if (priced.length === 0) return
    const candidates = scope === 'everyone' ? priced : priced.filter(iAnswered)
    if (candidates.length === 0) {
      optionalNotChosen += 1
      return
    }
    const figures = candidates
      .map((o) => {
        const p =
          scope === 'everyone'
            ? priceOption(o, {})
            : priceOption(o, { headcountNoun: 'in' }, { count: optedInCount(o), isEstimate: true })
        return p ? figureOf(p) : null
      })
      .filter((f): f is Figure => f !== null)
    if (figures.length === 0) return
    const single = figures.length === 1
    pushLine({
      id: `q:${section.id}`,
      kind: 'question',
      label: section.title,
      sectionType: section.section_type ?? null,
      deepLink: { type: 'question', sectionId: section.id, optionId: single ? candidates[0].id : null },
      figures,
      certainty: 'est',
      qualifier: scope === 'everyone' ? 'open' : 'your_pick',
      note: scope === 'everyone' ? (single ? 'open: 1 option' : `open: ${figures.length} options`) : 'your pick',
      optionCount: figures.length,
      basisLine: single ? figures[0].basisLine : null,
    })
  }

  /** One bad line degrades to "not included" with a warning; it never takes down the card. */
  const failedSectionIds = new Set<string>()
  const guarded = (label: string, work: () => void, sectionId?: string): void => {
    const before = lines.length
    try {
      work()
    } catch (err) {
      lines.length = before
      failedLines.push(label)
      if (sectionId) failedSectionIds.add(sectionId)
      console.warn(`Your cost: "${label}" could not be priced and is not included.`, err)
    }
  }
  for (const section of sections) guarded(section.title, () => processSection(section), section.id)
  const okSections = sections.filter((s) => !failedSectionIds.has(s.id))

  // --- 2. Plan entries with a cost -------------------------------------------
  const pricedOptionIds = new Set(okSections.flatMap((s) => s.options.filter(isPriced).map((o) => o.id)))
  for (const event of events) {
    guarded(event.title, () => {
      if (event.source_option_id && pricedOptionIds.has(event.source_option_id)) return
      if (!readEventCost(event.metadata)) return
      const attendees = event.participant_ids ?? []
      if (attendees.length > 0 && (!userId || !attendees.includes(userId))) return
      const p = computeEventPrice(event, trip, hc, { confirmationEnabled })
      if (!p) return
      pushLine({
        id: `event:${event.id}`,
        kind: 'event',
        label: event.title,
        sectionType: null,
        deepLink: { type: 'event', eventId: event.id },
        figures: [{ amount: p.perPerson, currency: p.currency, certainty: 'decided', approximate: p.approximate, divided: p.dividedByHeadcount, basisLine: null }],
        certainty: 'decided',
        qualifier: 'on_plan',
        note: attendees.length > 0 ? "you're in" : 'on the plan',
        optionCount: 1,
        basisLine: null,
      })
    })
  }

  // --- 3. The organiser's rough figure, only until accommodation has a price --
  // "Priced" includes a booked option, a booking and a linked expense: real money replaces the guess.
  const accommodationPriced = okSections.some(
    (s) =>
      s.section_type === 'accommodation' &&
      liveOptions(s).some((o) => isPriced(o) || isBookedOption(o) || expensesOf(o).length > 0)
  )
  const rough = trip.estimated_accommodation_cost
  if (rough != null && Number(rough) > 0 && !accommodationPriced && !finished) {
    const name = input.organizerName?.trim()
    const label = name ? `Rough estimate from ${name}` : 'Rough estimate from the organiser'
    guarded(label, () =>
      pushLine({
        id: 'estimate:organizer',
        kind: 'estimate',
        label,
        sectionType: 'accommodation',
        deepLink: { type: 'trip_settings' },
        figures: [{ amount: Number(rough), currency: trip.accommodation_cost_currency || base, certainty: 'est', approximate: false, divided: false, basisLine: null }],
        certainty: 'est',
        qualifier: 'rough_estimate',
        note: label,
        optionCount: 1,
        basisLine: null,
      })
    )
  }

  // --- 4. Totals, reconciliation ---------------------------------------------
  const counted = lines.filter((l) => !l.notShared && l.low != null && l.high != null)
  const lowMinor = counted.reduce((acc, l) => acc + toMinorUnits(l.low as number, base), 0)
  const highMinor = counted.reduce((acc, l) => acc + toMinorUnits(l.high as number, base), 0)
  const low = fromMinorUnits(lowMinor, base)
  const high = fromMinorUnits(highMinor, base)
  const approx = lines.some((l) => !l.notShared && l.approx)
  const totals: YourCostTotals = {
    low,
    high,
    isRange: low !== high,
    approx,
    certainty: weakestCertainty(lines.filter((l) => !l.notShared).map((l) => l.certainty)),
    text: formatMoneyRange(low, high, base, approx ? { estimate: true } : {}),
  }

  let alreadySpent: number | null = null
  let expensesMissingRate: string[] = []
  let involved = false
  const expenseShares: Array<{ id: string; title: string; share: number }> = []
  if (expenses.length > 0 && userId) {
    const { balances, expensesMissingRate: missing } = computeBalances([...expenses], [], ledgerIds, base)
    const mine = balances.find((b) => b.userId === userId)
    alreadySpent = fromMinorUnits(mine?.totalOwedMinor ?? 0, base)
    involved = (mine?.totalOwedMinor ?? 0) > 0 || (mine?.totalPaidMinor ?? 0) > 0
    expensesMissingRate = missing
    // Per-expense share through the same engine (one expense at a time), so the rows add up to the headline.
    for (const e of expenses) {
      const one = computeBalances([e], [], ledgerIds, base).balances.find((b) => b.userId === userId)
      const minor = one?.totalOwedMinor ?? 0
      if (minor > 0) expenseShares.push({ id: e.id, title: (e.description ?? '').trim() || 'Expense', share: fromMinorUnits(minor, base) })
    }
    expenseShares.sort((a, b) => b.share - a.share)
  } else if (userId && input.expenses) {
    alreadySpent = 0
  }

  // "Your share" only when the ledger actually has you in it: a finished trip with no expenses, or none
  // that include you, is still the estimate (with a plain note), never "Your share: £0.00".
  const share = finished && alreadySpent != null && involved ? alreadySpent : null
  const mode: YourCostModel['mode'] = share != null ? 'share' : 'estimate'
  const hasCosts = lines.some((l) => !l.notShared)
  const emptyReason: YourCostModel['emptyReason'] =
    share != null || !userId || hasCosts
      ? null
      : input.viewerInScope === false
        ? 'not_going'
        : finished
          ? 'no_costs'
          : null
  const note =
    emptyReason === 'not_going'
      ? "You're not going on this trip, so there is no cost to estimate for you."
      : emptyReason === 'no_costs'
        ? 'You have no costs recorded on this trip.'
        : finished && share == null && userId && expenses.length === 0
          ? 'No expenses were logged for this trip, so this is still the estimate.'
          : null

  return {
    mode,
    title: mode === 'share' ? 'Your share' : 'Your cost for this trip',
    currency: base,
    headcount: hc.count,
    headcountIsEstimate: hc.isEstimate,
    lines,
    totals,
    alreadySpent,
    share,
    estimateForComparison: mode === 'share' ? totals : null,
    notIncluded: [...YOUR_COST_NOT_INCLUDED],
    optionalNotChosen,
    missingRates: [...conv.missing],
    expensesMissingRate,
    expenseShares,
    failedLines,
    headcountNoun: countNoun(hc.isEstimate, confirmationEnabled),
    note,
    emptyReason,
    isEmpty: !hasCosts && share == null,
  }
}

/** Convenience for the card headline: "≈£1,150 – £1,310" (estimate) or "£5,719.28" (share, exact). */
export function yourCostHeadline(model: YourCostModel): string {
  if (model.mode === 'share' && model.share != null) return formatMoney(model.share, model.currency, { mode: 'exact' })
  return model.totals.text
}
