/**
 * NudgeDraftRequest/Response: contract for the `nudge-draft` edge function
 * (plan §14) -- AI-drafted, WhatsApp-ready copy for one blocker/person,
 * with a deep link back into the app.
 */
import { z } from 'zod'
import { UuidSchema } from './common'

export const BlockerTypeSchema = z.enum([
  'pending_rsvp',
  'unvoted_poll',
  'unclaimed_items',
  'unpaid_settlement',
  'unbooked_won_poll',
  'expiring_cancellation_window',
])

export const NudgeDraftRequestSchema = z.object({
  trip_id: UuidSchema,
  target_user_id: UuidSchema,
  blocker_type: BlockerTypeSchema,
  blocker_entity_id: UuidSchema.optional(),
  /** Optional organizer-supplied tone/context hint, e.g. "keep it light". */
  tone_hint: z.string().max(200).optional(),
})

export const NudgeDraftResponseSchema = z.object({
  message: z.string(),
  deep_link: z.string(),
  blocker_type: BlockerTypeSchema,
  target_user_id: UuidSchema,
})

export type BlockerType = z.infer<typeof BlockerTypeSchema>
export type NudgeDraftRequest = z.infer<typeof NudgeDraftRequestSchema>
export type NudgeDraftResponse = z.infer<typeof NudgeDraftResponseSchema>

export const NudgeDraftResponseJsonSchema = {
  name: 'NudgeDraftResponse',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'deep_link', 'blocker_type', 'target_user_id'],
    properties: {
      message: { type: 'string' },
      deep_link: { type: 'string' },
      blocker_type: {
        type: 'string',
        enum: [
          'pending_rsvp',
          'unvoted_poll',
          'unclaimed_items',
          'unpaid_settlement',
          'unbooked_won_poll',
          'expiring_cancellation_window',
        ],
      },
      target_user_id: { type: 'string' },
    },
  },
} as const
