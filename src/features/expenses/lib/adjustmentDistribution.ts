/**
 * Adjustments review panel math (plan §10): tax/service/tip/discount
 * distribution across line items and, transitively, across claimants.
 *
 * The receipt parser (supabase/functions/_shared/receiptReconciliation.ts)
 * already picks the winning *hypothesis* for how a receipt's printed
 * numbers combine. This module is the client-side counterpart used by the
 * adjustments review panel + itemized claims: given a set of line-item
 * subtotals (minor units) and a chosen adjustment configuration (segmented
 * choice + percent), compute
 *   1. each adjustment's total minor-unit amount,
 *   2. the live reconciliation bar (Σitems ± adjustments vs printed total),
 *   3. the proportional distribution of each adjustment across line items
 *      (and, by extension, across whichever claimants own each line),
 * using largestRemainderDistribute so every distribution sums EXACTLY.
 *
 * All money math is in integer minor units; convert at the UI boundary via
 * src/lib/money/minorUnits.ts.
 */
import { largestRemainderDistribute, sumMinorUnits } from '../../../lib/money'

/** How a tax/service adjustment relates to the printed line-item prices. */
export type AdjustmentMode = 'included' | 'added_on_top' | 'none'

export interface PercentAdjustmentConfig {
  mode: AdjustmentMode
  /** Percent as a whole number, e.g. 10 for 10%. Ignored when mode is 'none'. */
  percent: number
}

export interface AdjustmentsConfig {
  tax: PercentAdjustmentConfig
  service: PercentAdjustmentConfig
  /** Flat tip amount in minor units (not a percent quick-select in the panel, though callers may derive one). */
  tipMinor: number
  /** Flat discount amount in minor units (positive number, subtracted). */
  discountMinor: number
}

export const SERVICE_TAX_PERCENT_QUICK_SELECTS = [5, 8, 10, 12.5, 15, 18, 20] as const

/**
 * Computes the total minor-unit amount a percent-based adjustment
 * contributes on top of the base (added_on_top only -- 'included' means the
 * amount is already inside `baseMinor` and contributes 0 additional, 'none'
 * contributes 0).
 */
export function computeAddOnAmount(config: PercentAdjustmentConfig, baseMinor: number): number {
  if (config.mode !== 'added_on_top') return 0
  return Math.round((baseMinor * config.percent) / 100)
}

export interface ReconciliationBarResult {
  /** Sum of line-item subtotals, minor units. */
  itemsSubtotalMinor: number
  /** Computed total after applying tax/service/tip/discount per the config, minor units. */
  computedTotalMinor: number
  /** The printed/expected total to reconcile against, minor units. */
  printedTotalMinor: number
  /** computedTotalMinor - printedTotalMinor; 0 means exact. */
  deltaMinor: number
  /** True when deltaMinor is within tolerance (default 1 minor unit). */
  isExact: boolean
}

/**
 * Live reconciliation bar: Σitems ± adjustments vs printed total. Green
 * (isExact) when the two match within tolerance, amber with a delta
 * otherwise (plan §10's adjustments review panel).
 */
export function computeReconciliationBar(
  itemSubtotalsMinor: number[],
  config: AdjustmentsConfig,
  printedTotalMinor: number,
  toleranceMinorUnits = 1
): ReconciliationBarResult {
  const itemsSubtotalMinor = sumMinorUnits(itemSubtotalsMinor)
  const taxAddOn = computeAddOnAmount(config.tax, itemsSubtotalMinor)
  const serviceAddOn = computeAddOnAmount(config.service, itemsSubtotalMinor)
  const computedTotalMinor = itemsSubtotalMinor + taxAddOn + serviceAddOn + config.tipMinor - config.discountMinor
  const deltaMinor = computedTotalMinor - printedTotalMinor
  return {
    itemsSubtotalMinor,
    computedTotalMinor,
    printedTotalMinor,
    deltaMinor,
    isExact: Math.abs(deltaMinor) <= toleranceMinorUnits,
  }
}

export interface LineAdjustmentShare {
  /** Index into the input itemSubtotalsMinor array. */
  lineIndex: number
  taxShareMinor: number
  serviceShareMinor: number
  tipShareMinor: number
  discountShareMinor: number
  /** Line subtotal + its share of every adjustment (net owed for this line). */
  totalWithAdjustmentsMinor: number
}

/**
 * Distributes tax/service/tip/discount proportionally to each line item's
 * subtotal (plan §10: "Tax/service/tip distribute proportionally to each
 * claimant's item subtotal"), using largestRemainderDistribute so each
 * adjustment's per-line shares sum exactly to that adjustment's total.
 * Discount is distributed the same way and then subtracted per-line.
 *
 * Lines with a zero subtotal (e.g. a fully-discounted freebie) receive a
 * zero share of every proportional adjustment.
 */
export function distributeAdjustmentsAcrossLines(
  itemSubtotalsMinor: number[],
  config: AdjustmentsConfig
): LineAdjustmentShare[] {
  const itemsSubtotalMinor = sumMinorUnits(itemSubtotalsMinor)
  const taxTotal = computeAddOnAmount(config.tax, itemsSubtotalMinor)
  const serviceTotal = computeAddOnAmount(config.service, itemsSubtotalMinor)

  const taxShares = largestRemainderDistribute(taxTotal, itemSubtotalsMinor)
  const serviceShares = largestRemainderDistribute(serviceTotal, itemSubtotalsMinor)
  const tipShares = largestRemainderDistribute(config.tipMinor, itemSubtotalsMinor)
  const discountShares = largestRemainderDistribute(config.discountMinor, itemSubtotalsMinor)

  return itemSubtotalsMinor.map((subtotal, i) => ({
    lineIndex: i,
    taxShareMinor: taxShares[i],
    serviceShareMinor: serviceShares[i],
    tipShareMinor: tipShares[i],
    discountShareMinor: discountShares[i],
    totalWithAdjustmentsMinor: subtotal + taxShares[i] + serviceShares[i] + tipShares[i] - discountShares[i],
  }))
}

/**
 * Given a mapping of claimant -> their claimed subtotal (minor units, e.g.
 * the sum of amount_owed across their expense_item_claims before
 * adjustments), distributes tax/service/tip/discount proportionally across
 * claimants the same way as across lines. This is what the claims UI uses
 * to show each claimant's final owed amount once the organizer locks in
 * the adjustments configuration.
 */
export function distributeAdjustmentsAcrossClaimants(
  claimantSubtotalsMinor: Map<string, number>,
  config: AdjustmentsConfig
): Map<string, number> {
  const claimantIds = Array.from(claimantSubtotalsMinor.keys())
  const subtotals = claimantIds.map((id) => claimantSubtotalsMinor.get(id) ?? 0)
  const shares = distributeAdjustmentsAcrossLines(subtotals, config)

  const result = new Map<string, number>()
  claimantIds.forEach((id, i) => {
    result.set(id, shares[i].totalWithAdjustmentsMinor)
  })
  return result
}
