/**
 * IngestResult: structured-output schema for the `ingest` edge function
 * (plan §9) -- the single "paste/photo anything" entry point. Classifies
 * arbitrary pasted text/URL/image into one of booking | option | event |
 * receipt and returns a per-type structured draft for user confirmation.
 */
import { z } from 'zod'
import { CurrencyCodeSchema, DateOnlySchema } from './common'
import { ReceiptParseResultSchema } from './receiptParseResult'

export const IngestClassificationSchema = z.enum(['booking', 'option', 'event', 'receipt'])

export const BookingDraftSchema = z.object({
  title: z.string(),
  vendor: z.string().nullable().optional(),
  confirmation_ref: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  currency: CurrencyCodeSchema.nullable().optional(),
  booking_date: DateOnlySchema.nullable().optional(),
  cancellation_deadline: z.string().datetime({ offset: true }).nullable().optional(),
  refundable: z.boolean().nullable().optional(),
  place_name: z.string().nullable().optional(),
  place_url: z.string().url().nullable().optional(),
  notes: z.string().nullable().optional(),
})

export const OptionDraftSchema = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: CurrencyCodeSchema.nullable().optional(),
  price_type: z.enum(['per_person_fixed', 'total_split', 'per_person_tiered']).nullable().optional(),
  place_name: z.string().nullable().optional(),
  place_url: z.string().url().nullable().optional(),
  image_url: z.string().url().nullable().optional(),
})

export const EventDraftSchema = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  category: z
    .enum(['flight', 'accommodation', 'transport', 'activity', 'dining', 'transfer', 'meeting_point', 'free_time', 'other'])
    .nullable()
    .optional(),
  event_date: DateOnlySchema,
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  all_day: z.boolean().nullable().optional(),
  place_name: z.string().nullable().optional(),
  place_url: z.string().url().nullable().optional(),
})

export const IngestResultSchema = z.discriminatedUnion('classification', [
  z.object({ classification: z.literal('booking'), booking: BookingDraftSchema }),
  z.object({ classification: z.literal('option'), option: OptionDraftSchema }),
  z.object({ classification: z.literal('event'), event: EventDraftSchema }),
  z.object({ classification: z.literal('receipt'), receipt: ReceiptParseResultSchema }),
])

export type IngestClassification = z.infer<typeof IngestClassificationSchema>
export type BookingDraft = z.infer<typeof BookingDraftSchema>
export type OptionDraft = z.infer<typeof OptionDraftSchema>
export type EventDraft = z.infer<typeof EventDraftSchema>
export type IngestResult = z.infer<typeof IngestResultSchema>

/** Hand-written JSON Schema mirror for Claude structured outputs. */
export const IngestResultJsonSchema = {
  name: 'IngestResult',
  schema: {
    type: 'object',
    required: ['classification'],
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'booking'],
        properties: {
          classification: { const: 'booking' },
          booking: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              vendor: { type: ['string', 'null'] },
              confirmation_ref: { type: ['string', 'null'] },
              amount: { type: ['number', 'null'] },
              currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
              booking_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              cancellation_deadline: { type: ['string', 'null'] },
              refundable: { type: ['boolean', 'null'] },
              place_name: { type: ['string', 'null'] },
              place_url: { type: ['string', 'null'] },
              notes: { type: ['string', 'null'] },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'option'],
        properties: {
          classification: { const: 'option' },
          option: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              description: { type: ['string', 'null'] },
              price: { type: ['number', 'null'] },
              currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
              price_type: { type: ['string', 'null'], enum: ['per_person_fixed', 'total_split', 'per_person_tiered', null] },
              place_name: { type: ['string', 'null'] },
              place_url: { type: ['string', 'null'] },
              image_url: { type: ['string', 'null'] },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'event'],
        properties: {
          classification: { const: 'event' },
          event: {
            type: 'object',
            required: ['title', 'event_date'],
            properties: {
              title: { type: 'string' },
              description: { type: ['string', 'null'] },
              category: {
                type: ['string', 'null'],
                enum: ['flight', 'accommodation', 'transport', 'activity', 'dining', 'transfer', 'meeting_point', 'free_time', 'other', null],
              },
              event_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              start_time: { type: ['string', 'null'] },
              end_time: { type: ['string', 'null'] },
              all_day: { type: ['boolean', 'null'] },
              place_name: { type: ['string', 'null'] },
              place_url: { type: ['string', 'null'] },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'receipt'],
        properties: {
          classification: { const: 'receipt' },
          receipt: { $ref: '#/definitions/ReceiptParseResult' },
        },
      },
    ],
  },
} as const
