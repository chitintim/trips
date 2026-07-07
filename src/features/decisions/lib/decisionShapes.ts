/**
 * Decision shapes (UX_REDESIGN.md Part 5, "the Meribel lessons"): real trips
 * have THREE decision shapes, not one. This module is the pure (no-React)
 * logic layer for shapes 2 (personal order form) and 3 (tiered group
 * pricing) — shape 1 (group vote) is the existing voting.ts/costImpact.ts
 * machinery, unchanged.
 *
 *   - decision_shape lives in planning_sections.metadata (additive jsonb
 *     column, see the 20260707140000 migration). Absent = 'vote', so every
 *     existing section keeps behaving exactly as before.
 *   - Catalog item pricing (option.metadata.pricing) and tiered group
 *     pricing (option.metadata.price_tiers) live on options.metadata,
 *     alongside the existing grid_row/grid_column/source fields (see
 *     optionMetadata.ts, which owns the OptionMetadata/OptionPricing/
 *     PriceTier/PricingVariant type definitions this module builds on).
 *   - A participant's personal order line lives on their `selections` row's
 *     metadata: { start_date, end_date, variant, quantity }.
 *
 * All money math funnels through lib/money's integer-minor-units helpers —
 * never raw float arithmetic on prices.
 */
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { readOptionMetadata } from './optionMetadata'
import type { Json } from '../../../types/database.types'
import type { OptionPricing, PriceTier } from './optionMetadata'

export type { OptionPricing, PriceTier, PricingVariant } from './optionMetadata'

// ============================================================================
// Section decision shape
// ============================================================================

export type DecisionShape = 'vote' | 'personal'

export interface SectionMetadata {
  decision_shape?: DecisionShape
}

export function readSectionMetadata(metadata: Json | null | undefined): SectionMetadata {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as SectionMetadata
  }
  return {}
}

/** Absent metadata/decision_shape defaults to 'vote' — every pre-existing section. */
export function getDecisionShape(metadata: Json | null | undefined): DecisionShape {
  const shape = readSectionMetadata(metadata).decision_shape
  return shape === 'personal' ? 'personal' : 'vote'
}

export function isPersonalOrderSection(metadata: Json | null | undefined): boolean {
  return getDecisionShape(metadata) === 'personal'
}

// ============================================================================
// Shape 2: personal order form — catalog pricing + per-selection order lines
// ============================================================================

export function readOptionPricing(metadata: Json | null | undefined): OptionPricing | null {
  return readOptionMetadata(metadata).pricing ?? null
}

/** True when at least one option in a personal-order section has catalog pricing set. */
export function sectionHasCatalogPricing(options: Array<{ metadata: Json | null }>): boolean {
  return options.some((o) => !!readOptionPricing(o.metadata))
}

/** The runtime convention for a `selections.metadata` row under a personal-order section. */
export interface OrderItemMetadata {
  start_date?: string
  end_date?: string
  variant?: string
  quantity?: number
}

export function readOrderItemMetadata(metadata: Json | null | undefined): OrderItemMetadata {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as OrderItemMetadata
  }
  return {}
}

export function buildOrderItemMetadata(item: OrderItemMetadata): Json {
  return item as unknown as Json
}

/** Inclusive day count between two YYYY-MM-DD dates (same day = 1 day). Never less than 1. */
export function countDaysInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime()
  const end = new Date(`${endDate}T00:00:00Z`).getTime()
  const days = Math.round((end - start) / 86_400_000) + 1
  return Math.max(days, 1)
}

/** Resolve the effective per_day/flat rate for a pricing spec + chosen variant label (falls back to the base rate when no variant matches). */
export function resolveVariantPricing(pricing: OptionPricing, variantLabel?: string | null): { per_day?: number; flat?: number } {
  if (variantLabel && pricing.variants) {
    const variant = pricing.variants.find((v) => v.label === variantLabel)
    if (variant) return { per_day: variant.per_day, flat: variant.flat }
  }
  return { per_day: pricing.per_day, flat: pricing.flat }
}

/**
 * Total price (major units of `currency`) for one order line: flat pricing
 * wins if present (date range irrelevant), else per_day * (inclusive day
 * count from start/end) if a date range is set, else per_day alone (a
 * single day) as a last resort when no dates were picked yet. Multiplied by
 * quantity (default 1). Returns 0 when the pricing spec has no flat/per_day
 * at all (nothing to charge for).
 */
export function computeOrderItemTotal(pricing: OptionPricing, item: OrderItemMetadata, currency: string): number {
  const { per_day, flat } = resolveVariantPricing(pricing, item.variant)
  const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1

  let perUnitMajor = 0
  if (flat != null) {
    perUnitMajor = flat
  } else if (per_day != null) {
    const days = item.start_date && item.end_date ? countDaysInclusive(item.start_date, item.end_date) : 1
    perUnitMajor = per_day * days
  }

  const perUnitMinor = toMinorUnits(perUnitMajor, currency)
  return fromMinorUnits(perUnitMinor * quantity, currency)
}

/** One resolved line in a participant's order (or the organizer's consolidated matrix), ready for display. */
export interface OrderLine {
  optionId: string
  optionTitle: string
  variant: string | null
  quantity: number
  startDate: string | null
  endDate: string | null
  total: number
  currency: string
}

/** Build a display-ready order line from an option + its pricing + a selection's order-item metadata. */
export function buildOrderLine(
  option: { id: string; title: string; currency: string | null },
  pricing: OptionPricing,
  item: OrderItemMetadata,
  fallbackCurrency: string
): OrderLine {
  const currency = option.currency || fallbackCurrency
  return {
    optionId: option.id,
    optionTitle: option.title,
    variant: item.variant ?? null,
    quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
    startDate: item.start_date ?? null,
    endDate: item.end_date ?? null,
    total: computeOrderItemTotal(pricing, item, currency),
    currency,
  }
}

/** Sum of order lines' totals, grouped by currency (mirrors getSectionRunningTotal's shape for consistency). */
export function sumOrderLinesByCurrency(lines: OrderLine[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const line of lines) {
    const minor = toMinorUnits(line.total, line.currency)
    const existingMinor = totals[line.currency] != null ? toMinorUnits(totals[line.currency], line.currency) : 0
    totals[line.currency] = fromMinorUnits(existingMinor + minor, line.currency)
  }
  return totals
}

// ============================================================================
// Shape 3: tiered group pricing
// ============================================================================

export function readPriceTiers(metadata: Json | null | undefined): PriceTier[] {
  return readOptionMetadata(metadata).price_tiers ?? []
}

export function hasPriceTiers(metadata: Json | null | undefined): boolean {
  return readPriceTiers(metadata).length > 0
}

export interface TierResolution {
  tier: PriceTier
  /** Index into the tiers array (sorted ascending by max_people) that was selected. */
  index: number
  /** True when headcount exceeded every tier's max_people — the top tier was used as a fallback, and the organizer should be warned the booked price may need renegotiating. */
  aboveTop: boolean
}

/**
 * Pick the tier that applies at `headcount` (confirmed count, or opted-in
 * count for optional activities): the smallest tier whose max_people is >=
 * headcount. When headcount exceeds every tier, the top (largest) tier is
 * used with `aboveTop: true` so the UI can flag it ("booking may need
 * renegotiating at this size") rather than silently under-quoting.
 */
export function applicableTier(tiers: PriceTier[], headcount: number): TierResolution | null {
  if (tiers.length === 0) return null
  const sorted = [...tiers].sort((a, b) => a.max_people - b.max_people)
  for (let i = 0; i < sorted.length; i++) {
    if (headcount <= sorted[i].max_people) {
      return { tier: sorted[i], index: i, aboveTop: false }
    }
  }
  const topIndex = sorted.length - 1
  return { tier: sorted[topIndex], index: topIndex, aboveTop: true }
}

/** Per-person share (major units) of a tier's total, split across `headcount` (minimum 1 to avoid divide-by-zero before anyone's confirmed). */
export function perPersonAtTier(tier: PriceTier, headcount: number, currency: string): number {
  const divisor = Math.max(headcount, 1)
  const minor = toMinorUnits(tier.total, currency)
  return fromMinorUnits(Math.round(minor / divisor), currency)
}

export interface TierSensitivityPoint {
  headcount: number
  perPerson: number
}

/**
 * Sensitivity range across tier boundaries: "£75/pp if 6 · £38/pp if 12" —
 * the per-person cost at each tier's own max_people (its boundary
 * headcount), sorted ascending by headcount, so the UI can render "if only
 * N₁ ... if N₂" from the two ends.
 */
export function tierSensitivity(tiers: PriceTier[], currency: string): TierSensitivityPoint[] {
  const sorted = [...tiers].sort((a, b) => a.max_people - b.max_people)
  return sorted.map((tier) => ({
    headcount: tier.max_people,
    perPerson: perPersonAtTier(tier, tier.max_people, currency),
  }))
}

export interface TierCostImpact {
  perPerson: number
  currency: string
  aboveTop: boolean
  sensitivity: TierSensitivityPoint[]
}

/** One-call convenience: resolve the applicable tier at `headcount` and its sensitivity range, or null when the option carries no tiers. */
export function getTierCostImpact(tiers: PriceTier[], headcount: number, currency: string): TierCostImpact | null {
  const resolution = applicableTier(tiers, headcount)
  if (!resolution) return null
  return {
    perPerson: perPersonAtTier(resolution.tier, headcount, currency),
    currency,
    aboveTop: resolution.aboveTop,
    sensitivity: tierSensitivity(tiers, currency),
  }
}
