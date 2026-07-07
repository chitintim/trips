/**
 * ReceiptParseResult: the structured-output schema for parse-receipt v2
 * (plan §10). Passed to Claude as a JSON schema for structured outputs and
 * used to validate the response before it's trusted.
 *
 * Design notes (see plan §10 for rationale):
 * - line_items carry BOTH qty/unit_price/line_total AND `printed_field`
 *   indicating which of {unit_price, line_total} was actually printed on
 *   the receipt -- this structurally solves the JP 単価/金額 ambiguity
 *   instead of relying on prompt heuristics.
 * - tax is an array (not flat columns) to handle VAT-inclusive Europe,
 *   US add-on tax, and Japan's dual 8%/10% receipts in one shape.
 * - Reconciliation (sum-of-lines vs subtotal, subtotal+adjustments vs total)
 *   happens in code, not the model -- this schema only describes shape.
 */
import { z } from 'npm:zod@3'
import { CurrencyCodeSchema, DateOnlySchema, ConfidenceSchema } from './common.ts'

export const LineItemDiscountSchema = z.object({
  amount: z.number().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  reason: z.string().nullable().optional(),
})

export const LineItemSchema = z.object({
  line_number: z.number().int().min(1),
  name_original: z.string(),
  name_english: z.string().nullable().optional(),
  quantity: z.number().positive(),
  unit_price: z.number(),
  line_total: z.number(),
  /**
   * Which of unit_price/line_total was actually printed on the receipt;
   * the other is derived (quantity * unit_price, or line_total / quantity).
   * 'both' when both were printed and agree; 'ambiguous' when the model
   * could not tell (should route to the repair re-prompt / user review).
   */
  printed_field: z.enum(['unit_price', 'line_total', 'both', 'ambiguous']),
  discounts: z.array(LineItemDiscountSchema).default([]),
  confidence: ConfidenceSchema.optional(),
})

export const TaxLineSchema = z.object({
  label: z.string().optional(),
  rate: z.number().min(0).max(1).nullable().optional(), // e.g. 0.08 for 8%
  amount: z.number(),
  /** true = tax already included in the printed line/subtotal totals (EU VAT-style) */
  inclusive: z.boolean(),
})

export const ServiceChargeSchema = z.object({
  amount: z.number().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  auto: z.boolean().describe('true if mandatory/auto-added, false if voluntary/optional'),
})

export const ReceiptDiscountSchema = z.object({
  label: z.string().optional(),
  amount: z.number().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
})

export const ReceiptFieldConfidenceSchema = z.object({
  field: z.string(),
  confidence: ConfidenceSchema,
  note: z.string().optional(),
})

export const ReceiptParseResultSchema = z.object({
  vendor_name: z.string().nullable(),
  vendor_name_english: z.string().nullable().optional(),
  vendor_address: z.string().nullable().optional(),
  receipt_date: DateOnlySchema.nullable(),
  currency: CurrencyCodeSchema,
  line_items: z.array(LineItemSchema),
  tax: z.array(TaxLineSchema).default([]),
  service_charge: ServiceChargeSchema.nullable().optional(),
  tip: z.number().nullable().optional(),
  discounts: z.array(ReceiptDiscountSchema).default([]),
  rounding_adjustment: z.number().nullable().optional(),
  subtotal: z.number().nullable(),
  total: z.number(),
  confidence: z.array(ReceiptFieldConfidenceSchema).default([]),
  notes: z.string().nullable().optional(),
})

export type LineItem = z.infer<typeof LineItemSchema>
export type TaxLine = z.infer<typeof TaxLineSchema>
export type ServiceCharge = z.infer<typeof ServiceChargeSchema>
export type ReceiptParseResult = z.infer<typeof ReceiptParseResultSchema>

/**
 * Hand-written JSON Schema mirror of ReceiptParseResultSchema, for passing
 * to Claude's structured-output `output_config: {format: {type: "json_schema"}}`.
 * Kept in sync manually with the Zod schema above (no zod-to-json-schema
 * dependency) -- update both together.
 */
export const ReceiptParseResultJsonSchema = {
  name: 'ReceiptParseResult',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['vendor_name', 'receipt_date', 'currency', 'line_items', 'subtotal', 'total'],
    properties: {
      vendor_name: { type: ['string', 'null'] },
      vendor_name_english: { type: ['string', 'null'] },
      vendor_address: { type: ['string', 'null'] },
      receipt_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['line_number', 'name_original', 'quantity', 'unit_price', 'line_total', 'printed_field'],
          properties: {
            line_number: { type: 'integer' },
            name_original: { type: 'string' },
            name_english: { type: ['string', 'null'] },
            quantity: { type: 'number' },
            unit_price: { type: 'number' },
            line_total: { type: 'number' },
            printed_field: { type: 'string', enum: ['unit_price', 'line_total', 'both', 'ambiguous'] },
            discounts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  amount: { type: ['number', 'null'] },
                  percent: { type: ['number', 'null'] },
                  reason: { type: ['string', 'null'] },
                },
              },
            },
            confidence: { type: 'number' },
          },
        },
      },
      tax: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'inclusive'],
          properties: {
            label: { type: 'string' },
            rate: { type: ['number', 'null'] },
            amount: { type: 'number' },
            inclusive: { type: 'boolean' },
          },
        },
      },
      service_charge: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['auto'],
        properties: {
          amount: { type: ['number', 'null'] },
          percent: { type: ['number', 'null'] },
          auto: { type: 'boolean' },
        },
      },
      tip: { type: ['number', 'null'] },
      discounts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            amount: { type: ['number', 'null'] },
            percent: { type: ['number', 'null'] },
          },
        },
      },
      rounding_adjustment: { type: ['number', 'null'] },
      subtotal: { type: ['number', 'null'] },
      total: { type: 'number' },
      confidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'confidence'],
          properties: {
            field: { type: 'string' },
            confidence: { type: 'number' },
            note: { type: 'string' },
          },
        },
      },
      notes: { type: ['string', 'null'] },
    },
  },
} as const
