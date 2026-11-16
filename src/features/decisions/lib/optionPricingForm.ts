/**
 * Form <-> storage mapping for the option editor's "How is this priced?"
 * control (redesign proposal 4.2 / slice 3D). Pure and tested; the sheet only
 * wires inputs to these functions.
 *
 * Storage (no migration): `options.price_type` + `options.metadata`
 * (`price_basis`, `nights`, `price_tiers`, grid keys, catalog `pricing`, and
 * whatever other keys the row already has). Basis reading/writing is the frozen
 * `lib/cost/priceBasis` pair; this file adds the merge-don't-drop rule, the
 * default basis, validation and the text the organiser sees.
 */
import { applyPriceBasis, deriveNights, readExplicitNights, readPriceBasis, type PriceBasis } from '../../../lib/cost/priceBasis'
import type { Json } from '../../../types/database.types'

export type PriceTypeValue = 'per_person_fixed' | 'total_split' | 'per_person_tiered'

/** The editor's choices, in display order. Labels are the owner-approved wording. */
export const PRICING_CHOICES: ReadonlyArray<{ basis: PriceBasis; label: string; priceLabel: string; placeholder: string }> = [
  { basis: 'each', label: 'Each person pays', priceLabel: 'Price per person', placeholder: '0.00' },
  { basis: 'total_split', label: 'One price, split between everyone going', priceLabel: 'Total price', placeholder: '0.00' },
  { basis: 'per_night', label: 'Per night', priceLabel: 'Price per night (whole place)', placeholder: '0.00' },
  { basis: 'by_group_size', label: 'Depends on group size', priceLabel: 'Total price', placeholder: '0.00' },
]

export const OPTIONAL_COST_LABEL = 'Optional — only people who choose it pay'
export const OPTIONAL_COST_HELP = 'Applies to the whole question. Leave off if everyone shares the cost.'

/** Accommodation-like questions default to one shared total; everything else to a per-person price. */
export function defaultBasisForSection(sectionType: string | null | undefined): PriceBasis {
  return sectionType === 'accommodation' ? 'total_split' : 'each'
}

export interface TierRow {
  maxPeople: string
  total: string
}

export interface PricingFormValues {
  basis: PriceBasis
  price: string
  currency: string
  /** Per-night only. '' = not set (falls back to the derived nights). */
  nights: string
  tiers: TierRow[]
  gridRow: string
  gridColumn: string
}

type Obj = Record<string, unknown>

function obj(metadata: Json | null | undefined): Obj {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Obj) : {}
}

export interface TripDates {
  start_date?: string | null
  end_date?: string | null
  /** Shown as the currency of a price stored without one (never silently stamped GBP). */
  base_currency?: string | null
}

/** The stored row fields buildPricing compares the form against. */
export interface ExistingPricing {
  price?: number | null
  currency?: string | null
  price_type: string
  metadata: Json | null
}

/** Seed the pricing part of the form from a stored option (legacy rows included). */
export function pricingFromOption(
  option: { price: number | null; currency: string | null; price_type: string; metadata: Json | null },
  trip?: TripDates | null
): PricingFormValues {
  const basis = readPriceBasis(option)
  const meta = obj(option.metadata)
  const tiers = Array.isArray(meta.price_tiers) ? (meta.price_tiers as Array<{ max_people?: unknown; total?: unknown }>) : []
  return {
    basis,
    price: option.price != null ? String(option.price) : '',
    // A price stored with no currency is displayed in the trip's currency; buildPricing keeps it null while that default is untouched.
    currency: option.currency || trip?.base_currency || 'GBP',
    nights: basis === 'per_night' ? String(deriveNights(option.metadata, trip).nights) : '',
    tiers: tiers.map((t) => ({ maxPeople: String(t.max_people ?? ''), total: String(t.total ?? '') })),
    gridRow: typeof meta.grid_row === 'string' ? meta.grid_row : '',
    gridColumn: typeof meta.grid_column === 'string' ? meta.grid_column : '',
  }
}

/** Seed from a paste-a-link draft (its price_type is the only basis hint). */
export function pricingFromDraft(
  draft: { price?: number | null; currency?: string | null; price_type?: string | null },
  fallbackBasis: PriceBasis
): PricingFormValues {
  const basis = draft.price_type ? readPriceBasis({ price_type: draft.price_type, metadata: null }) : fallbackBasis
  return {
    basis,
    price: draft.price != null ? String(draft.price) : '',
    currency: draft.currency || 'GBP',
    nights: '',
    tiers: [],
    gridRow: '',
    gridColumn: '',
  }
}

export function emptyPricing(basis: PriceBasis): PricingFormValues {
  return { basis, price: '', currency: 'GBP', nights: '', tiers: [], gridRow: '', gridColumn: '' }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseNumber(s: string): number {
  return s.trim() === '' ? NaN : Number(s)
}

/** The first thing wrong with the pricing fields, or null. A missing price is never an error. */
export function validatePricing(v: PricingFormValues): string | null {
  if (v.price.trim() !== '' && v.basis !== 'by_group_size') {
    const p = parseNumber(v.price)
    if (!Number.isFinite(p)) return 'Enter the price as a number.'
    if (p < 0) return 'The price can’t be negative.'
  }
  if (v.basis === 'per_night' && v.nights.trim() !== '') {
    const n = parseNumber(v.nights)
    if (!Number.isInteger(n) || n < 1) return 'Nights must be a whole number, 1 or more.'
  }
  if (v.basis === 'by_group_size') {
    for (const row of v.tiers) {
      const hasMax = row.maxPeople.trim() !== ''
      const hasTotal = row.total.trim() !== ''
      if (!hasMax && !hasTotal) continue
      if (!hasMax || !hasTotal) return 'Fill in both the group size and the total for each row, or remove the row.'
      const max = parseNumber(row.maxPeople)
      const total = parseNumber(row.total)
      if (!Number.isInteger(max) || max < 1) return 'Group sizes must be whole numbers, 1 or more.'
      if (!Number.isFinite(total) || total < 0) return 'Group totals can’t be negative.'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Build what gets saved
// ---------------------------------------------------------------------------

export function parseTiers(rows: TierRow[]): Array<{ max_people: number; total: number }> {
  return rows
    .filter((t) => t.maxPeople.trim() && t.total.trim())
    .map((t) => ({ max_people: parseInt(t.maxPeople, 10), total: parseFloat(t.total) }))
}

export interface BuiltPricing {
  price: number | null
  currency: string | null
  price_type: PriceTypeValue
  metadata: Json
}

/**
 * Write `grid_row` / `grid_column` into `metadata`. With a stored row
 * (`existing` given) a key is only rewritten when its field changed, so a lone
 * grid row or lone column survives an unrelated save; creating (undefined)
 * sets the keys only when both are filled.
 */
export function applyGridFields(metadata: Obj, existing: Json | null | undefined, gridRow: string, gridColumn: string): void {
  const row = gridRow.trim()
  const col = gridColumn.trim()
  if (existing === undefined) {
    if (row && col) {
      metadata.grid_row = row
      metadata.grid_column = col
    }
    return
  }
  const stored = obj(existing)
  const was = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string).trim() : '')
  const touch = (key: 'grid_row' | 'grid_column', value: string) => {
    if (value === was(key)) return
    if (value) metadata[key] = value
    else delete metadata[key]
  }
  touch('grid_row', row)
  touch('grid_column', col)
}

/**
 * The columns to write for a vote-shape option. `existing` is the stored row (null
 * when creating): its metadata is MERGED, never replaced, so keys like `source`,
 * `source_url` and the catalog `pricing` survive; the stored amount only changes
 * if the form value differs.
 *
 * Saving an UNCHANGED option is a no-op on every stored field, for every legacy
 * shape: when the form's basis is the one the row already reads as, the
 * `price_type`, `price_basis` spelling (or its absence), explicit `nights`,
 * tier rows, lone grid row/column and a missing currency are all left exactly as
 * stored; only fields the organiser actually edited are rewritten.
 */
export function buildPricing(v: PricingFormValues, existing: ExistingPricing | null, trip?: TripDates | null): BuiltPricing {
  const base: Obj = { ...obj(existing?.metadata) }
  const seed = existing ? pricingFromOption({ price: existing.price ?? null, currency: existing.currency ?? null, price_type: existing.price_type, metadata: existing.metadata }, trip) : null
  const basisUnchanged = !!existing && v.basis === readPriceBasis(existing)

  // Nights: an explicit stored value stays explicit; otherwise blank or equal to what the dates give -> no override.
  const nightsUntouched = basisUnchanged && seed != null && v.nights === seed.nights
  let nights: number | null | undefined = null
  if (v.basis === 'per_night' && v.nights.trim() !== '') {
    const n = parseInt(v.nights, 10)
    const { nights: dateNights } = deriveNights({ ...base, nights: undefined } as Json, trip)
    nights = n === dateNights && readExplicitNights(existing?.metadata) == null ? null : n
  }
  if (nightsUntouched) nights = undefined

  let metadata: Obj
  let price_type: PriceTypeValue
  if (basisUnchanged && existing) {
    // Keep the stored spelling; touch only what changed.
    metadata = { ...base }
    price_type = existing.price_type as PriceTypeValue
    if (v.basis === 'per_night' && !nightsUntouched) {
      if (nights == null) delete metadata.nights
      else metadata.nights = nights
    }
  } else {
    const applied = applyPriceBasis(base as Json, v.basis, { nights })
    metadata = { ...obj(applied.metadata) }
    price_type = applied.price_type
  }

  // Grid keys: rewrite a key only when its field changed (a lone row or column survives an unrelated save).
  applyGridFields(metadata, existing ? existing.metadata : undefined, v.gridRow, v.gridColumn)

  const tiersUnchanged = !!seed && basisUnchanged && JSON.stringify(v.tiers) === JSON.stringify(seed.tiers)
  const tiers = v.basis === 'by_group_size' ? parseTiers(v.tiers) : []
  if (tiersUnchanged) {
    // keep price_tiers verbatim
  } else if (tiers.length > 0) metadata.price_tiers = tiers
  else delete metadata.price_tiers

  const hasPrice = v.price.trim() !== '' && v.basis !== 'by_group_size'
  // A tiered option keeps whatever fallback price it already had (the field is hidden).
  let price: number | null
  if (v.basis === 'by_group_size') price = existing?.price ?? null
  else if (!hasPrice) price = null
  else if (existing?.price != null && seed && v.price === seed.price) price = existing.price
  else price = parseFloat(v.price)

  // Legacy "per person (tiered/matrix)" rows keep their stored type while their basis is unchanged.
  if (existing?.price_type === 'per_person_tiered' && basisUnchanged) price_type = 'per_person_tiered'

  const priced = price != null || tiers.length > 0
  let currency: string | null
  if (!priced) currency = existing ? existing.currency ?? null : null // no price: keep whatever currency the row had
  else if (existing && existing.currency == null && v.currency === (trip?.base_currency || 'GBP')) currency = null // never stamp a default on a stored null
  else currency = v.currency

  // A row stored with null metadata stays null while nothing was written to it.
  const emptyStaysNull = !!existing && existing.metadata == null && Object.keys(metadata).length === 0
  return { price, currency, price_type, metadata: emptyStaysNull ? null : (metadata as Json) }
}

/** The option-shaped object `computeOptionPrice` wants, for the live preview. */
export function previewOption(v: PricingFormValues, existing: ExistingPricing | null, trip?: TripDates | null) {
  const built = buildPricing(v, existing, trip)
  return { price: built.price, currency: built.currency ?? v.currency, price_type: built.price_type, metadata: built.metadata }
}

/**
 * An option with nothing priced yet (price 0/absent and no booking) must show
 * no amount at all, never "£0 each". Returns null for such a price.
 */
export function meaningfulPrice<T extends { perPerson: number; total: number }>(price: T | null): T | null {
  if (!price) return null
  return price.perPerson > 0 || price.total > 0 ? price : null
}
