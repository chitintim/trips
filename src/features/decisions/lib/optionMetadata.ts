/**
 * `options.metadata` is an untyped `Json` column (no dedicated DB type) —
 * this module defines the runtime convention this feature relies on for
 * matrix/grid tiered options (ski-rental-matrix style, per
 * PLANING_IMPROVEMENTS.md and the legacy MatrixSelector component), the
 * paste-a-link ingestion's provenance tagging, and the two decision-shape
 * pricing conventions from UX_REDESIGN.md Part 5 (personal-order catalog
 * pricing + tiered group pricing) — see decisionShapes.ts for the
 * accessors/resolution logic built on top of these fields.
 */
import type { Json } from '../../../types/database.types'

/** A named variant of a personal-order catalog item (e.g. "Adult" vs "Kids" skis), each with its own per-day/flat price. */
export interface PricingVariant {
  label: string
  per_day?: number
  flat?: number
}

/** Shape 2 (personal pick / order form) pricing for a catalog item option. */
export interface OptionPricing {
  per_day?: number
  flat?: number
  variants?: PricingVariant[]
}

/** Shape 3 (tiered group pricing) — a headcount breakpoint and the total price at/under it. */
export interface PriceTier {
  max_people: number
  total: number
}

export interface OptionMetadata {
  /** Row label for matrix/grid display (e.g. "Level A"). */
  grid_row?: string
  /** Column label for matrix/grid display (e.g. "Skis+Boots"). */
  grid_column?: string
  /** Set when this option was created via paste-a-link ingestion. */
  source?: 'manual' | 'link_parse'
  /** Original pasted URL, when source is link_parse. */
  source_url?: string
  /** Personal-order catalog pricing (decision_shape 'personal' sections). */
  pricing?: OptionPricing
  /** Headcount-tiered total pricing (decision_shape 'vote' sections, price_type 'total_split'). */
  price_tiers?: PriceTier[]
}

export function readOptionMetadata(metadata: Json | null | undefined): OptionMetadata {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as OptionMetadata
  }
  return {}
}

export function isMatrixOption(metadata: Json | null | undefined): boolean {
  const meta = readOptionMetadata(metadata)
  return !!meta.grid_row && !!meta.grid_column
}

/** True when a section's options collectively look like a matrix (>=1 option carries grid coordinates). */
export function sectionHasMatrixLayout(options: Array<{ metadata: Json | null }>): boolean {
  return options.some((o) => isMatrixOption(o.metadata))
}

export function getMatrixAxes(options: Array<{ metadata: Json | null }>): { rows: string[]; columns: string[] } {
  const rows = new Set<string>()
  const columns = new Set<string>()
  for (const opt of options) {
    const meta = readOptionMetadata(opt.metadata)
    if (meta.grid_row) rows.add(meta.grid_row)
    if (meta.grid_column) columns.add(meta.grid_column)
  }
  return { rows: Array.from(rows), columns: Array.from(columns) }
}
