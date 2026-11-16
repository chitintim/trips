/**
 * View model for Today's "Your cost" card (proposal 4.5 / 4.6). Pure: turns
 * the `buildYourCost` model into the exact strings the card prints, so the
 * wording is unit-tested and the component stays a thin renderer.
 */
import { formatMoney, formatMoneyRange } from '../../../lib/money/format'
import { CERTAINTY_WORD, type Certainty } from '../../../lib/cost/optionPrice'
import { DEEP_LINKS } from '../../../lib/todos/copy'
import { formatRoughEstimate } from '../../people/lib/roughCost'
import type { YourCostLine, YourCostModel } from '../../../lib/cost/yourCost'

export interface YourCostRowView {
  id: string
  label: string
  /** "£640", "≈£60 – £140", "≈£52 (¥12,000)". */
  amount: string
  /** The certainty word: est. / decided / booked / paid. */
  chip: string
  certainty: Certainty
  /** Second line: "open: 2 options", "your picks", "£2,000 total · 9 going · est.", "from ¥12,000". */
  detail: string | null
  /** `?open=...` query string for the row, or null when there is nowhere to go. */
  link: string | null
}

export interface YourCostView {
  mode: YourCostModel['mode']
  /** Bold line: "Your cost so far: ≈£1,240", "Your share: £1,287.40", "Organizer's rough estimate: ~£800 each". Null when nothing is priced. */
  headline: string | null
  /** Small line under the headline. */
  subline: string | null
  rows: YourCostRowView[]
  /** "Split between 9 going" (or "9 invited (estimate)"), only when a figure was divided. */
  basis: string | null
  /** "Charged to you so far (from expenses): £720.00". */
  spent: string | null
  /** Share mode: "Estimated before the trip: ≈£1,100 – £1,400". */
  comparison: string | null
  notIncluded: string | null
  /** "2 optional activities you haven't chosen aren't counted." */
  optionalNote: string | null
  warnings: string[]
  /** Honest empty state when nothing is priced yet. */
  empty: { title: string; body: string } | null
  /** Rows start open when there are few of them. */
  defaultOpen: boolean
}

export const ROUGH_ESTIMATE_LABEL = "Organizer's rough estimate"

function linkFor(line: YourCostLine): string | null {
  const l = line.deepLink
  if (l.type === 'question') return DEEP_LINKS.question(l.sectionId)
  if (l.type === 'event') return DEEP_LINKS.item(l.eventId)
  return null
}

/** The pre-trip estimate is worth showing next to the real share only when it covered a meaningful part of it. */
export const ESTIMATE_COMPARISON_MIN_COVERAGE = 0.5

export function showEstimateComparison(estimateHigh: number, share: number): boolean {
  return share > 0 && estimateHigh >= share * ESTIMATE_COMPARISON_MIN_COVERAGE
}

function amountFor(line: YourCostLine, currency: string): string {
  if (line.notShared) return 'Not shared with you'
  if (line.low == null || line.high == null) {
    // No rate: show it in its own currency (each currency separately, never one range across them); it is left out of the total.
    return line.nativeByCurrency.map((c) => formatMoneyRange(c.low, c.high, c.currency, { estimate: true })).join(' · ')
  }
  return formatMoneyRange(line.low, line.high, currency, line.approx ? { estimate: true } : {})
}

function detailFor(line: YourCostLine, currency: string): string | null {
  if (line.notShared) return null
  const parts: string[] = []
  if (line.qualifier === 'open' || line.qualifier === 'your_pick' || line.qualifier === 'your_picks' || line.qualifier === 'on_plan') {
    parts.push(line.note)
    if (line.qualifier === 'your_picks' && line.basisLine) parts.push(line.basisLine)
  } else if (line.basisLine) {
    parts.push(line.basisLine)
  }
  const foreign = line.nativeByCurrency.filter((c) => c.currency !== currency)
  if (foreign.length > 0) {
    const own = foreign.map((c) => formatMoneyRange(c.low, c.high, c.currency, {})).join(' · ')
    if (line.low == null) parts.push(`${own} · no exchange rate yet, not in the total`)
    else if (line.partial) parts.push(`partly priced: ${own} has no exchange rate yet, not in the total`)
    else parts.push(`from ${own}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function rowFor(line: YourCostLine, currency: string): YourCostRowView {
  return {
    id: line.id,
    label: line.kind === 'estimate' ? ROUGH_ESTIMATE_LABEL : line.label,
    amount: amountFor(line, currency),
    chip: line.notShared ? '' : CERTAINTY_WORD[line.certainty],
    certainty: line.certainty,
    detail: detailFor(line, currency),
    link: linkFor(line),
  }
}

export function buildYourCostView(model: YourCostModel): YourCostView {
  const cur = model.currency
  const rows = model.lines.map((l) => rowFor(l, cur))
  const countable = model.lines.filter((l) => !l.notShared && l.low != null)
  const onlyRough = model.lines.length > 0 && model.lines.every((l) => l.kind === 'estimate')
  const divided = model.lines.some((l) => !l.notShared && l.dividedByHeadcount)

  const warnings: string[] = []
  if (model.missingRates.length > 0) {
    warnings.push(`No exchange rate for ${model.missingRates.join(', ')} yet, so ${model.missingRates.length === 1 ? 'that price is' : 'those prices are'} not in the total.`)
  }
  if (model.expensesMissingRate.length > 0) {
    const n = model.expensesMissingRate.length
    warnings.push(`${n} expense${n === 1 ? '' : 's'} can't be converted yet, so ${n === 1 ? "it isn't" : "they aren't"} counted below.`)
  }

  for (const label of model.failedLines) warnings.push(`"${label}" couldn't be priced, so it isn't included.`)

  const spent =
    model.alreadySpent != null && model.alreadySpent > 0
      ? `Charged to you so far (from expenses): ${formatMoney(model.alreadySpent, cur, { mode: 'exact' })}`
      : null

  // The noun follows the in-scope rule (tracking off -> "going"), so it never contradicts "N going" elsewhere.
  const basis =
    divided && model.headcount > 0
      ? `Split between ${model.headcount} ${model.headcountNoun}${model.headcountNoun === 'invited' ? ' (estimate)' : ''}`
      : null
  const notIncluded = model.notIncluded.length > 0 ? `Not included: ${model.notIncluded.join(' · ')}` : null
  const optionalNote =
    model.optionalNotChosen > 0
      ? `${model.optionalNotChosen} optional ${model.optionalNotChosen === 1 ? 'question' : 'questions'} with a price ${model.optionalNotChosen === 1 ? "isn't" : "aren't"} counted until you pick.`
      : null

  const base = { rows, basis, notIncluded, optionalNote, warnings, defaultOpen: rows.length <= 4 }

  // Finished: the real figure, with the estimate faded underneath.
  if (model.mode === 'share' && model.share != null) {
    return {
      ...base,
      mode: 'share',
      headline: `Your share: ${formatMoney(model.share, cur, { mode: 'exact' })}`,
      subline: 'Your part of every expense on this trip.',
      spent: null,
      comparison:
        countable.length > 0 && showEstimateComparison((model.estimateForComparison ?? model.totals).high, model.share)
          ? `Estimated before the trip: ${model.estimateForComparison?.text ?? model.totals.text}`
          : null,
      empty: null,
      // The planning lines are history now; keep them folded.
      defaultOpen: false,
    }
  }

  // Nothing of theirs: say exactly why, never estimate.
  if (model.emptyReason) {
    return {
      ...base,
      mode: 'estimate',
      headline: null,
      subline: null,
      spent: null,
      comparison: null,
      empty: {
        title: model.emptyReason === 'not_going' ? "You're not going on this trip" : 'You have no costs recorded on this trip.',
        body: model.emptyReason === 'not_going' ? 'There is no cost to estimate for you.' : 'Expenses shared with you would show up here.',
      },
    }
  }

  // Nothing priced at all.
  if (model.isEmpty || countable.length === 0) {
    return {
      ...base,
      mode: 'estimate',
      headline: null,
      subline: null,
      spent,
      comparison: null,
      empty: {
        title: 'Nothing is priced yet',
        body: "Prices appear here as the group decides things. Your own share will show up once accommodation has a price.",
      },
    }
  }

  // Only the organiser's rough figure so far: say exactly that, never as "your cost".
  if (onlyRough) {
    const line = countable[0]
    const rough = formatRoughEstimate(line.native.low, line.native.currency, cur, line.low)
    return {
      ...base,
      mode: 'estimate',
      rows: [],
      basis: null,
      headline: `${ROUGH_ESTIMATE_LABEL}: ${rough}`,
      subline: 'Nothing is priced yet. This is replaced by real prices as the group decides.',
      spent,
      comparison: null,
      empty: null,
    }
  }

  return {
    ...base,
    mode: 'estimate',
    headline: `Your cost so far: ${model.totals.text}`,
    subline: model.note ?? (model.totals.isRange ? 'The range narrows as open questions get decided.' : null),
    spent,
    comparison: null,
    empty: null,
  }
}
