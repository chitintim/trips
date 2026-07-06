/**
 * Shared primitive Zod schemas used across multiple contracts.
 * Imported by both the frontend (src/) and edge functions (supabase/functions/),
 * so keep this dependency-free beyond zod.
 */
import { z } from 'npm:zod@3'

/** ISO 4217 3-letter currency code, e.g. "GBP", "JPY". */
export const CurrencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Must be an uppercase 3-letter ISO 4217 currency code')

/** Date-only string, YYYY-MM-DD. Never a Date object -- avoids timezone drift (plan §16). */
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date-only string in YYYY-MM-DD format')

export const UuidSchema = z.string().uuid()

/** A confidence score in [0, 1] the model reports for an extracted field. */
export const ConfidenceSchema = z.number().min(0).max(1)

export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>
export type DateOnly = z.infer<typeof DateOnlySchema>
