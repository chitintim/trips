/**
 * AI proposals & human-approval layer (plan §13, "AI proposals & human
 * approval layer"; backing table: public.ai_proposals, migration
 * 20260706153414_v2_additions.sql).
 *
 * A ProposedAction is one item in a batch of AI-drafted changes (from
 * trip-chat or ingest) that a human must review before anything is
 * applied. Deletes are never auto-applied -- `delete_request` only ever
 * carries a reference for a human to act on, never executes by itself.
 *
 * Applying an approved proposal happens under the approving user's own
 * JWT/RLS (see the ai_proposals RLS policies) -- this contract only
 * describes the shape of the drafted batch, not execution privileges.
 */
import { z } from 'zod'
import { UuidSchema, DateOnlySchema } from './common'

/** Caller-supplied key so re-applying the same proposal batch is a no-op. */
const IdempotencyKeySchema = z.string().min(1).max(128)

export const CreateEventActionSchema = z.object({
  type: z.literal('create_event'),
  idempotency_key: IdempotencyKeySchema,
  trip_id: UuidSchema,
  title: z.string().min(1).max(200),
  event_date: DateOnlySchema,
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  all_day: z.boolean().optional(),
  category: z
    .enum(['flight', 'accommodation', 'transport', 'activity', 'dining', 'transfer', 'meeting_point', 'free_time', 'other'])
    .optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

export const CreateOptionActionSchema = z.object({
  type: z.literal('create_option'),
  idempotency_key: IdempotencyKeySchema,
  section_id: UuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  price_type: z.enum(['per_person_fixed', 'total_split', 'per_person_tiered']).optional(),
})

export const CreateBookingDraftActionSchema = z.object({
  type: z.literal('create_booking_draft'),
  idempotency_key: IdempotencyKeySchema,
  trip_id: UuidSchema,
  option_id: UuidSchema.nullable().optional(),
  title: z.string().min(1).max(200),
  vendor: z.string().nullable().optional(),
  confirmation_ref: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  booking_date: DateOnlySchema.nullable().optional(),
  cancellation_deadline: z.string().datetime({ offset: true }).nullable().optional(),
})

export const CreateExpenseDraftActionSchema = z.object({
  type: z.literal('create_expense_draft'),
  idempotency_key: IdempotencyKeySchema,
  trip_id: UuidSchema,
  description: z.string().min(1).max(500),
  amount: z.number().positive(),
  currency: z.string().length(3),
  paid_by: UuidSchema.nullable().optional(),
  payment_date: DateOnlySchema.optional(),
  category: z.enum(['accommodation', 'transport', 'food', 'activities', 'equipment', 'other']).optional(),
  participant_ids: z.array(UuidSchema).optional(),
})

export const UpdateEventActionSchema = z.object({
  type: z.literal('update_event'),
  idempotency_key: IdempotencyKeySchema,
  event_id: UuidSchema,
  title: z.string().min(1).max(200).optional(),
  event_date: DateOnlySchema.optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

/**
 * A delete is only ever *requested* -- it carries the entity to delete and
 * is surfaced to the human reviewer, but the apply step must never delete
 * automatically. UI/apply logic MUST treat this action type as "needs
 * explicit manual confirmation per-item", distinct from the other action
 * types which can be bulk-approved.
 */
export const DeleteRequestActionSchema = z.object({
  type: z.literal('delete_request'),
  idempotency_key: IdempotencyKeySchema,
  entity_type: z.enum(['event', 'option', 'booking', 'expense', 'checklist_item']),
  entity_id: UuidSchema,
  reason: z.string().nullable().optional(),
})

export const ProposedActionSchema = z.discriminatedUnion('type', [
  CreateEventActionSchema,
  CreateOptionActionSchema,
  CreateBookingDraftActionSchema,
  CreateExpenseDraftActionSchema,
  UpdateEventActionSchema,
  DeleteRequestActionSchema,
])

export type ProposedAction = z.infer<typeof ProposedActionSchema>

export const ProposalSchema = z.object({
  trip_id: UuidSchema,
  source_text: z.string().nullable().optional(),
  actions: z.array(ProposedActionSchema).min(1).max(20),
})

export type Proposal = z.infer<typeof ProposalSchema>

/** Mirrors public.ai_proposals.status check constraint. */
export const AiProposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'partially_applied'])
export type AiProposalStatus = z.infer<typeof AiProposalStatusSchema>

/** Hand-written JSON Schema mirror for Claude structured outputs. */
export const ProposalJsonSchema = {
  name: 'Proposal',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['trip_id', 'actions'],
    properties: {
      trip_id: { type: 'string' },
      source_text: { type: ['string', 'null'] },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['type', 'idempotency_key'],
          properties: {
            type: {
              type: 'string',
              enum: [
                'create_event',
                'create_option',
                'create_booking_draft',
                'create_expense_draft',
                'update_event',
                'delete_request',
              ],
            },
            idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
  },
} as const
