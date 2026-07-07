/**
 * Adjustment disambiguation engine (plan §10, "Adjustment disambiguation
 * engine (v1's #1 pain: service charge & tax detection)").
 *
 * This is pure TypeScript -- NOT the model. The model extracts a
 * ReceiptParseResult (line items, tax array, service_charge, discounts,
 * printed totals); this module verifies the arithmetic in integer minor
 * units and, on mismatch, hypothesis-tests standard receipt interpretations
 * to find the one combination of "how do the printed numbers combine" that
 * reconciles EXACTLY to the printed total. The model's per-field provenance
 * labels (printed_line | derived | embedded_in_prices -- surfaced via
 * `notes`/`confidence` today; a dedicated field can be added later) only
 * break ties between multiple reconciling hypotheses -- they never override
 * an exact arithmetic match, and code never "silently adjusts" a total that
 * doesn't reconcile under any hypothesis (plan: "Never silently adjust").
 *
 * All arithmetic is done in integer minor units (money module convention,
 * plan §4) to avoid float drift; a receipt total is exact if
 * |computed - printed| <= toleranceMinorUnits (default 1 minor unit per
 * plan §10, i.e. 1 pence/cent, or 1 whole yen for zero-decimal currencies).
 */
import { toMinorUnits, sumMinorUnits, roundHalfAwayFromZero } from './money/minorUnits.ts'
import type { ReceiptParseResult, LineItem } from './contracts/receiptParseResult.ts'

export type HypothesisId =
  | 'all_inclusive'
  | 'service_5pct'
  | 'service_8pct'
  | 'service_10pct'
  | 'service_12_5pct'
  | 'service_15pct'
  | 'service_18pct'
  | 'service_20pct'
  | 'tax_exclusive_same_rate'
  | 'tax_inclusive_service_added'
  | 'printed_fields_as_is'
  | 'printed_total_trusted'

export interface ReconciliationResult {
  /** Whether some interpretation reconciles Σ(lines) -> total exactly (within tolerance). */
  reconciled: boolean
  /** Which hypothesis reconciled (or 'printed_total_trusted' if none did). */
  hypothesis: HypothesisId
  /** Human-readable explanation, surfaced in review UI / repair re-prompt. */
  explanation: string
  /** Computed subtotal in minor units under the winning hypothesis. */
  computedSubtotalMinor: number
  /** Computed total in minor units under the winning hypothesis. */
  computedTotalMinor: number
  /** The printed total in minor units, for comparison. */
  printedTotalMinor: number
  /** Per-line-number review flags when nothing reconciled. */
  lineReviewFlags: number[]
  /** True if the model's line items disagreed with each other on printed_field (ambiguous). */
  hasAmbiguousLines: boolean
}

const SERVICE_RATE_HYPOTHESES: Array<{ id: HypothesisId; rate: number }> = [
  { id: 'service_5pct', rate: 0.05 },
  { id: 'service_8pct', rate: 0.08 },
  { id: 'service_10pct', rate: 0.10 },
  { id: 'service_12_5pct', rate: 0.125 },
  { id: 'service_15pct', rate: 0.15 },
  { id: 'service_18pct', rate: 0.18 },
  { id: 'service_20pct', rate: 0.20 },
]

/** Sum of a receipt's line_total fields, in minor units. */
function sumLineTotalsMinor(lines: LineItem[], currency: string): number {
  return sumMinorUnits(lines.map((l) => toMinorUnits(l.line_total, currency)))
}

/** Sum of any receipt-level discounts (as positive minor-unit amounts to subtract). */
function sumDiscountsMinor(
  discounts: ReceiptParseResult['discounts'],
  subtotalMinor: number,
  currency: string
): number {
  let total = 0
  for (const d of discounts) {
    if (d.amount != null) total += toMinorUnits(d.amount, currency)
    else if (d.percent != null) total += roundHalfAwayFromZero((subtotalMinor * d.percent) / 100)
  }
  return total
}

/**
 * Verifies + reconciles a ReceiptParseResult. Tolerance defaults to 1 minor
 * unit per tax group (plan §10) -- since we don't split by tax group in this
 * pass, we apply 1 minor unit globally, which is at least as strict.
 */
export function reconcileReceipt(receipt: ReceiptParseResult, toleranceMinorUnits = 1): ReconciliationResult {
  const currency = receipt.currency
  const printedTotalMinor = toMinorUnits(receipt.total, currency)
  const lineTotalsSumMinor = sumLineTotalsMinor(receipt.line_items, currency)
  const printedSubtotalMinor = receipt.subtotal != null ? toMinorUnits(receipt.subtotal, currency) : null
  const discountsMinor = sumDiscountsMinor(receipt.discounts, printedSubtotalMinor ?? lineTotalsSumMinor, currency)
  const roundingMinor = receipt.rounding_adjustment != null ? toMinorUnits(receipt.rounding_adjustment, currency) : 0

  const hasAmbiguousLines = receipt.line_items.some((l) => l.printed_field === 'ambiguous')

  const within = (a: number, b: number) => Math.abs(a - b) <= toleranceMinorUnits

  const taxAddOnMinor = sumMinorUnits(
    receipt.tax.filter((t) => !t.inclusive).map((t) => toMinorUnits(t.amount, currency))
  )
  const serviceChargeMinor = receipt.service_charge?.amount != null
    ? toMinorUnits(receipt.service_charge.amount, currency)
    : receipt.service_charge?.percent != null
      ? roundHalfAwayFromZero((lineTotalsSumMinor * receipt.service_charge.percent) / 100)
      : 0
  // A voluntary/suggested service charge (auto === false, e.g. a printed "suggested
  // gratuity" line on a US-style slip) is frequently NOT reflected in the receipt's
  // own printed total -- the customer chooses whether to add it after the fact. Only
  // a mandatory/auto charge (or one whose auto-ness is unspecified, matching prior
  // behavior) should be assumed present in the printed total by default. When the
  // charge is voluntary, prefer the "not applied" interpretation (it reconciles
  // without silently attributing a declined suggestion to the total) and only fall
  // back to including it if that's the sole way to reconcile.
  const serviceIsVoluntary = receipt.service_charge?.auto === false
  const serviceVariants = serviceIsVoluntary ? [0, serviceChargeMinor] : [serviceChargeMinor]

  // --- Hypothesis 1: printed fields as-is (Σlines + tax(non-inclusive) + service - discounts + rounding = total) ---
  for (const serviceMinor of serviceVariants) {
    const computedTotal = lineTotalsSumMinor + taxAddOnMinor + serviceMinor - discountsMinor + roundingMinor
    if (within(computedTotal, printedTotalMinor)) {
      return {
        reconciled: true,
        hypothesis: 'printed_fields_as_is',
        explanation: serviceIsVoluntary && serviceMinor === 0 && serviceChargeMinor !== 0
          ? 'Line items plus printed tax/discount/rounding fields reconcile exactly to the printed total; the voluntary/suggested service charge printed on the receipt was not applied to this total.'
          : 'Line items plus printed tax/service/discount/rounding fields reconcile exactly to the printed total.',
        computedSubtotalMinor: lineTotalsSumMinor,
        computedTotalMinor: computedTotal,
        printedTotalMinor,
        lineReviewFlags: [],
        hasAmbiguousLines,
      }
    }
  }

  // --- Hypothesis 2: all-inclusive (Σlines already includes everything; total should equal Σlines) ---
  {
    const computedTotal = lineTotalsSumMinor - discountsMinor + roundingMinor
    if (within(computedTotal, printedTotalMinor)) {
      return {
        reconciled: true,
        hypothesis: 'all_inclusive',
        explanation: 'Line item totals already include all tax and service charges (all-inclusive pricing); no separate addition needed.',
        computedSubtotalMinor: lineTotalsSumMinor,
        computedTotalMinor: computedTotal,
        printedTotalMinor,
        lineReviewFlags: [],
        hasAmbiguousLines,
      }
    }
  }

  // Discounted base: discounts (e.g. vouchers, loyalty %) are applied to the
  // line-item subtotal BEFORE any percentage-based service/tax add-on is
  // computed on top -- this matches how receipts actually print (discount
  // reduces the subtotal, then service/tax is charged on the discounted
  // amount), and is what makes e.g. "£5 off, then +10% service" reconcile.
  const discountedBaseMinor = lineTotalsSumMinor - discountsMinor

  // --- Hypothesis 3: tax-inclusive (already in line prices) + service added on top ---
  // Checked before the generic "+N% service" hypothesis below: when inclusive
  // tax is actually present on the receipt, this label is strictly more
  // informative for the exact same arithmetic, so it should win the tie
  // rather than the tax-agnostic label.
  const inclusiveTaxPresent = receipt.tax.some((t) => t.inclusive)
  if (inclusiveTaxPresent) {
    for (const { rate } of SERVICE_RATE_HYPOTHESES) {
      const service = roundHalfAwayFromZero(discountedBaseMinor * rate)
      const computedTotal = discountedBaseMinor + service + roundingMinor
      if (within(computedTotal, printedTotalMinor)) {
        return {
          reconciled: true,
          hypothesis: 'tax_inclusive_service_added',
          explanation: `Tax is already included in line prices; a ${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}% service charge is added on top of that to reach the printed total.`,
          computedSubtotalMinor: lineTotalsSumMinor,
          computedTotalMinor: computedTotal,
          printedTotalMinor,
          lineReviewFlags: [],
          hasAmbiguousLines,
        }
      }
    }
  }

  // --- Hypothesis 4: +N% service on top of line totals (standard rates) ---
  for (const { id, rate } of SERVICE_RATE_HYPOTHESES) {
    const service = roundHalfAwayFromZero(discountedBaseMinor * rate)
    const computedTotal = discountedBaseMinor + service + roundingMinor
    if (within(computedTotal, printedTotalMinor)) {
      return {
        reconciled: true,
        hypothesis: id,
        explanation: `Line items plus a ${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}% service charge added on top reconcile exactly to the printed total.`,
        computedSubtotalMinor: lineTotalsSumMinor,
        computedTotalMinor: computedTotal,
        printedTotalMinor,
        lineReviewFlags: [],
        hasAmbiguousLines,
      }
    }
  }

  // --- Hypothesis 5: tax-exclusive at the same rate(s) already given, applied on top ---
  {
    const inclusiveRatesReplayedAsExclusive = receipt.tax
      .filter((t) => t.rate != null)
      .map((t) => t.rate as number)
    let computedTotal = discountedBaseMinor
    for (const rate of inclusiveRatesReplayedAsExclusive) {
      computedTotal += roundHalfAwayFromZero(discountedBaseMinor * rate)
    }
    computedTotal += roundingMinor
    if (inclusiveRatesReplayedAsExclusive.length > 0 && within(computedTotal, printedTotalMinor)) {
      return {
        reconciled: true,
        hypothesis: 'tax_exclusive_same_rate',
        explanation: 'Tax was printed as an informational rate but is actually added on top (tax-exclusive), not included in line prices.',
        computedSubtotalMinor: lineTotalsSumMinor,
        computedTotalMinor: computedTotal,
        printedTotalMinor,
        lineReviewFlags: [],
        hasAmbiguousLines,
      }
    }
  }

  // --- Nothing reconciled: trust the printed total, flag lines for review ---
  const lineReviewFlags = receipt.line_items
    .filter((l) => l.printed_field === 'ambiguous' || l.confidence != null && l.confidence < 0.7)
    .map((l) => l.line_number)

  return {
    reconciled: false,
    hypothesis: 'printed_total_trusted',
    explanation:
      `No standard interpretation reconciles the line items to the printed total ` +
      `(closest attempt off by more than ${toleranceMinorUnits} minor unit(s)). ` +
      `Trusting the printed total; please review flagged line items.`,
    computedSubtotalMinor: lineTotalsSumMinor,
    computedTotalMinor: printedTotalMinor,
    printedTotalMinor,
    lineReviewFlags: lineReviewFlags.length > 0 ? lineReviewFlags : receipt.line_items.map((l) => l.line_number),
    hasAmbiguousLines,
  }
}

/**
 * Builds the repair re-prompt text quoting the discrepancy (plan §10: "One
 * repair re-prompt quoting the discrepancy if nothing reconciles"). Used by
 * parse-receipt to ask the model to re-examine the image with the specific
 * numeric mismatch called out.
 */
export function buildRepairPrompt(receipt: ReceiptParseResult, result: ReconciliationResult): string {
  const currency = receipt.currency
  const fmt = (minor: number) => (minor / (currency === 'JPY' || currency === 'KRW' ? 1 : 100)).toFixed(
    currency === 'JPY' || currency === 'KRW' ? 0 : 2
  )
  return (
    `Your previous extraction did not reconcile: the sum of line item totals is ${fmt(result.computedSubtotalMinor)} ${currency}, ` +
    `but the printed receipt total is ${fmt(result.printedTotalMinor)} ${currency} ` +
    `(difference: ${fmt(Math.abs(result.computedTotalMinor - result.printedTotalMinor))} ${currency}). ` +
    `Please re-examine the receipt image carefully, paying special attention to: ` +
    `(1) whether each line shows a unit price or a line total (cross-check against quantity), ` +
    `(2) any tax or service charge lines you may have missed or mis-labeled as inclusive/exclusive, ` +
    `(3) any discounts or rounding adjustments printed on the receipt. ` +
    `Return a corrected, complete ReceiptParseResult that reconciles exactly to the printed total.`
  )
}
