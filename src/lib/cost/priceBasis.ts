/**
 * Pricing basis as data (redesign proposal 4.2). "What does the number on this
 * option mean?" was a hidden enum (`options.price_type`) plus a free-floating
 * `metadata.price_tiers`; here it is one typed value, `PriceBasis`:
 *
 *   each           Each person pays this price.                      (price_type per_person_fixed)
 *   total_split    One total for the group, split between N.         (price_type total_split)
 *   per_night      Price per night for the whole place; total is
 *                  price x nights, then split between N.             (metadata price_basis 'per_night')
 *   by_group_size  Total depends on group size (metadata.price_tiers
 *                  breakpoints), split between N.                    (metadata price_basis 'by_group_size')
 *
 * Reading (never throws, never needs a migration):
 *   1. `metadata.price_basis` when it is a known value. Legacy spellings from
 *      the proposal ('night' -> per_night, 'stay' -> total_split) are accepted.
 *      A `by_group_size` basis without tiers degrades to total_split.
 *   2. else `metadata.price_tiers` present -> by_group_size.
 *   3. else price_type 'total_split' -> total_split.
 *   4. else (per_person_fixed AND the retired per_person_tiered) -> each.
 *
 * Writing: `applyPriceBasis` returns the `{ price_type, metadata }` pair the
 * option editor should save, keeping old readers (which only know price_type)
 * computing a sensible number.
 */
import { readPriceTiers } from '../../features/decisions/lib/decisionShapes'
import type { Json } from '../../types/database.types'

export type PriceBasis = 'each' | 'total_split' | 'per_night' | 'by_group_size'

/** One-line explanations for under each choice. */
export const PRICE_BASIS_HELP: Record<PriceBasis, string> = {
  each: 'Everyone who joins pays this amount.',
  total_split: 'One price for everyone, shared between the people going.',
  per_night: 'The price of the whole place for one night. We multiply by the nights and share it.',
  by_group_size: 'The total changes with how many people there are (for example a bigger chalet).',
}

export interface BasisSource {
  price_type?: string | null
  metadata?: Json | null
}

function metaObject(metadata: Json | null | undefined): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
}

function hasTiers(meta: Record<string, unknown>): boolean {
  // The same validated reader the price maths uses: a malformed row is not a tier.
  return readPriceTiers(meta as Json).length > 0
}

/** The pricing basis of an option. See file header for the precedence rules. */
export function readPriceBasis(source: BasisSource): PriceBasis {
  const meta = metaObject(source.metadata)
  const explicit = meta.price_basis
  if (explicit === 'each' || explicit === 'total_split' || explicit === 'per_night') return explicit
  if (explicit === 'night') return 'per_night'
  if (explicit === 'stay') return 'total_split'
  if (explicit === 'by_group_size') return hasTiers(meta) ? 'by_group_size' : 'total_split'
  if (hasTiers(meta)) return 'by_group_size'
  if (source.price_type === 'total_split') return 'total_split'
  return 'each' // per_person_fixed, per_person_tiered (retired) and anything unknown
}

/** True when the figure for one person is a total divided by a headcount. */
export function isDividedBasis(basis: PriceBasis): boolean {
  return basis !== 'each'
}

/** Explicit `metadata.nights` override (whole number >= 1), or null. */
export function readExplicitNights(metadata: Json | null | undefined): number | null {
  const n = metaObject(metadata).nights
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.round(n) : null
}

function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
}

/** Nights between check-in and check-out dates (YYYY-MM-DD), or null when either is unusable or the order is wrong. Same day = 0 -> null. */
export function nightsBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null
  const a = dayNumber(start)
  const b = dayNumber(end)
  if (a == null || b == null) return null
  const n = b - a
  return n >= 1 ? n : null
}

function readDateRange(meta: Record<string, unknown>): { start: string; end: string } | null {
  const r = meta.date_range
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { start, end } = r as Record<string, unknown>
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : null
}

export type NightsSource = 'option_nights' | 'option_dates' | 'trip' | 'default'

export interface DerivedNights {
  nights: number
  source: NightsSource
}

/**
 * Nights for a per-night price, in order: the option's own `metadata.nights`,
 * the option's `date_range`, the trip's start/end dates, else 1 (source
 * 'default', so callers can warn that the figure is unverified).
 */
export function deriveNights(
  metadata: Json | null | undefined,
  trip?: { start_date?: string | null; end_date?: string | null } | null
): DerivedNights {
  const explicit = readExplicitNights(metadata)
  if (explicit != null) return { nights: explicit, source: 'option_nights' }
  const range = readDateRange(metaObject(metadata))
  const fromRange = range ? nightsBetween(range.start, range.end) : null
  if (fromRange != null) return { nights: fromRange, source: 'option_dates' }
  const fromTrip = nightsBetween(trip?.start_date, trip?.end_date)
  if (fromTrip != null) return { nights: fromTrip, source: 'trip' }
  return { nights: 1, source: 'default' }
}

export interface AppliedPriceBasis {
  price_type: 'per_person_fixed' | 'total_split'
  metadata: Json
}

/**
 * What the option editor saves when the organiser picks a basis:
 *  - `price_type`: 'per_person_fixed' for each, 'total_split' for the other
 *    three (an old reader that only knows price_type then still divides a
 *    total by the headcount).
 *  - `metadata.price_basis` is always written; `metadata.nights` is written
 *    for per_night when given (null removes it, undefined keeps it; other bases remove it); `price_tiers` is
 *    dropped unless the basis is by_group_size. All other keys are kept.
 */
export function applyPriceBasis(
  metadata: Json | null | undefined,
  basis: PriceBasis,
  extras: { nights?: number | null } = {}
): AppliedPriceBasis {
  const next: Record<string, unknown> = { ...metaObject(metadata) }
  next.price_basis = basis
  if (basis === 'per_night') {
    if (extras.nights === null) delete next.nights
    else if (extras.nights !== undefined && extras.nights >= 1) next.nights = Math.round(extras.nights)
    // undefined: keep whatever nights the option already had
  } else delete next.nights
  if (basis !== 'by_group_size') delete next.price_tiers
  return { price_type: basis === 'each' ? 'per_person_fixed' : 'total_split', metadata: next as Json }
}
