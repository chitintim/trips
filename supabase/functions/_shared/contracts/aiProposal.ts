/**
 * AI proposals & human-approval layer (plan §13, "AI proposals & human
 * approval layer"; backing table: public.ai_proposals, migration
 * 20260706153414_v2_additions.sql).
 *
 * A ProposedAction is one item in a batch of AI-drafted changes (from
 * trip-chat, ingest, or reorganize-plan) that a human must review before
 * anything is applied. Deletes are never auto-applied -- `delete_request`
 * only ever carries a reference for a human to act on, never executes by
 * itself.
 *
 * Applying an approved proposal happens under the approving user's own
 * JWT/RLS (see the ai_proposals RLS policies) -- this contract only
 * describes the shape of the drafted batch, not execution privileges.
 */
import { z } from 'npm:zod@3'
import { UuidSchema, DateOnlySchema } from './common.ts'

/** Caller-supplied key so re-applying the same proposal batch is a no-op. */
const IdempotencyKeySchema = z.string().min(1).max(128)

/**
 * Some actions need to point at an entity that doesn't have a real database
 * id yet because ANOTHER action earlier in the SAME proposal batch is what
 * creates it (e.g. reorganize-plan's "Ski pack" case: a create_section
 * action for a new personal-picks catalog, immediately followed by several
 * create_option actions that belong under it). Rather than inventing a
 * nested/tree-shaped action format, a referencing field may carry either a
 * real UUID (the common case -- an entity that already exists) or the
 * string `ref:<idempotency_key>` pointing at the idempotency_key of a
 * create_section action elsewhere in the batch. Resolution happens at
 * apply time (see applyProposal.ts's resolveRef): the reviewing UI tracks
 * which idempotency_keys have already been applied and to what real id,
 * and substitutes it in. Referencing an action that hasn't been applied
 * yet (or was discarded) fails loudly on that card rather than silently
 * doing nothing.
 */
const RefOrUuidSchema = z.union([UuidSchema, z.string().regex(/^ref:[A-Za-z0-9_-]{1,128}$/)])

/** Arbitrary jsonb merge-patch (see options.metadata / planning_sections.metadata conventions in decisionShapes.ts / optionMetadata.ts). Applied as a shallow spread over the current value, never a wholesale replace. */
const MetadataPatchSchema = z.record(z.string(), z.unknown())

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
  /** A real section id, or `ref:<idempotency_key>` of a create_section action earlier in this same batch. */
  section_id: RefOrUuidSchema,
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
 * Updates an existing option in place -- the "matrix-of-bundles -> catalog
 * with variants" and "prose-fact extraction" moves (UPGRADE_MASTER_PLAN.md
 * §13 build brief) both lean on this rather than delete+recreate.
 * `metadata_patch` is MERGED into `options.metadata` (pricing/variants/
 * price_tiers/date hints), never a wholesale replace -- see
 * applyProposal.ts's update_option apply path.
 */
export const UpdateOptionActionSchema = z.object({
  type: z.literal('update_option'),
  idempotency_key: IdempotencyKeySchema,
  option_id: UuidSchema,
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  metadata_patch: MetadataPatchSchema.optional(),
})

/**
 * Creates a new planning_sections row. `title` is the QUESTION wording
 * (UX_REDESIGN.md Part 4 "Decisions: questions, not sections" -- e.g. "How
 * are we getting there?", not a label like "Transport"). `decision_shape`
 * picks group-vote vs personal-picks-catalog (UX_REDESIGN.md Part 5).
 */
export const CreateSectionActionSchema = z.object({
  type: z.literal('create_section'),
  idempotency_key: IdempotencyKeySchema,
  trip_id: UuidSchema,
  title: z.string().min(1).max(200),
  section_type: z.enum(['accommodation', 'flights', 'transport', 'equipment', 'insurance', 'activities', 'lessons']),
  decision_shape: z.enum(['vote', 'personal']),
  vote_deadline: z.string().datetime({ offset: true }).nullable().optional(),
  voting_method: z.enum(['single', 'approval', 'ranked']).optional(),
})

/** Updates an existing section's question wording/description/deadline, or merges into its metadata (e.g. flipping decision_shape). */
export const UpdateSectionActionSchema = z.object({
  type: z.literal('update_section'),
  idempotency_key: IdempotencyKeySchema,
  section_id: UuidSchema,
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  metadata_patch: MetadataPatchSchema.optional(),
  vote_deadline: z.string().datetime({ offset: true }).nullable().optional(),
})

/** Re-parents an existing option under a different section -- e.g. consolidating a scattered matrix option into the new catalog section. */
export const MoveOptionActionSchema = z.object({
  type: z.literal('move_option'),
  idempotency_key: IdempotencyKeySchema,
  option_id: UuidSchema,
  /** A real section id, or `ref:<idempotency_key>` of a create_section action earlier in this same batch. */
  to_section_id: RefOrUuidSchema,
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
  UpdateOptionActionSchema,
  CreateSectionActionSchema,
  UpdateSectionActionSchema,
  MoveOptionActionSchema,
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

/**
 * Hand-written JSON Schema mirror for Claude structured outputs -- one
 * action, discriminated on `type` via `oneOf`. IMPORTANT (learned in prod,
 * parse-receipt outage): Claude's structured-output schemas REJECT
 * `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf` on
 * numbers/integers, and this codebase's convention is to keep these
 * hand-written mirrors to enums/required/types/properties only across the
 * board (no minLength/maxLength/minItems/maxItems either) -- the Zod
 * schemas above keep their .min()/.max()/.length() constraints, enforced
 * on the parsed result, never inside the schema handed to the model.
 */
export const ProposedActionJsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'trip_id', 'title', 'event_date'],
      properties: {
        type: { const: 'create_event' },
        idempotency_key: { type: 'string' },
        trip_id: { type: 'string' },
        title: { type: 'string' },
        event_date: { type: 'string' },
        start_time: { type: ['string', 'null'] },
        end_time: { type: ['string', 'null'] },
        all_day: { type: 'boolean' },
        category: {
          type: 'string',
          enum: ['flight', 'accommodation', 'transport', 'activity', 'dining', 'transfer', 'meeting_point', 'free_time', 'other'],
        },
        location: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'section_id', 'title'],
      properties: {
        type: { const: 'create_option' },
        idempotency_key: { type: 'string' },
        section_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        price: { type: ['number', 'null'] },
        currency: { type: ['string', 'null'] },
        price_type: { type: 'string', enum: ['per_person_fixed', 'total_split', 'per_person_tiered'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'trip_id', 'title'],
      properties: {
        type: { const: 'create_booking_draft' },
        idempotency_key: { type: 'string' },
        trip_id: { type: 'string' },
        option_id: { type: ['string', 'null'] },
        title: { type: 'string' },
        vendor: { type: ['string', 'null'] },
        confirmation_ref: { type: ['string', 'null'] },
        amount: { type: ['number', 'null'] },
        currency: { type: ['string', 'null'] },
        booking_date: { type: ['string', 'null'] },
        cancellation_deadline: { type: ['string', 'null'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'trip_id', 'description', 'amount', 'currency'],
      properties: {
        type: { const: 'create_expense_draft' },
        idempotency_key: { type: 'string' },
        trip_id: { type: 'string' },
        description: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        paid_by: { type: ['string', 'null'] },
        payment_date: { type: 'string' },
        category: { type: 'string', enum: ['accommodation', 'transport', 'food', 'activities', 'equipment', 'other'] },
        participant_ids: { type: 'array', items: { type: 'string' } },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'event_id'],
      properties: {
        type: { const: 'update_event' },
        idempotency_key: { type: 'string' },
        event_id: { type: 'string' },
        title: { type: 'string' },
        event_date: { type: 'string' },
        start_time: { type: ['string', 'null'] },
        end_time: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'option_id'],
      properties: {
        type: { const: 'update_option' },
        idempotency_key: { type: 'string' },
        option_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        price: { type: ['number', 'null'] },
        currency: { type: ['string', 'null'] },
        metadata_patch: { type: 'object' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'trip_id', 'title', 'section_type', 'decision_shape'],
      properties: {
        type: { const: 'create_section' },
        idempotency_key: { type: 'string' },
        trip_id: { type: 'string' },
        title: { type: 'string' },
        section_type: {
          type: 'string',
          enum: ['accommodation', 'flights', 'transport', 'equipment', 'insurance', 'activities', 'lessons'],
        },
        decision_shape: { type: 'string', enum: ['vote', 'personal'] },
        vote_deadline: { type: ['string', 'null'] },
        voting_method: { type: 'string', enum: ['single', 'approval', 'ranked'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'section_id'],
      properties: {
        type: { const: 'update_section' },
        idempotency_key: { type: 'string' },
        section_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        metadata_patch: { type: 'object' },
        vote_deadline: { type: ['string', 'null'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'option_id', 'to_section_id'],
      properties: {
        type: { const: 'move_option' },
        idempotency_key: { type: 'string' },
        option_id: { type: 'string' },
        to_section_id: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'idempotency_key', 'entity_type', 'entity_id'],
      properties: {
        type: { const: 'delete_request' },
        idempotency_key: { type: 'string' },
        entity_type: { type: 'string', enum: ['event', 'option', 'booking', 'expense', 'checklist_item'] },
        entity_id: { type: 'string' },
        reason: { type: ['string', 'null'] },
      },
    },
  ],
} as const

/** Hand-written JSON Schema mirror for Claude structured outputs (a whole Proposal: trip_id + source_text + up to 20 actions). */
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
        items: ProposedActionJsonSchema,
      },
    },
  },
} as const
