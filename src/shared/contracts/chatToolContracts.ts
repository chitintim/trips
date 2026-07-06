/**
 * ChatToolContracts: names + argument schemas for the trip-chat v2 tool-use
 * design (plan §13). Replaces the old context-stuffing approach: a slim
 * system prompt plus these tools, called by Claude on demand.
 *
 * Read tools return data; write tools (organizer-only) are staged as an
 * inline confirmation card in chat and only executed after the user
 * confirms -- see ai_proposals (migration 20260706153414_v2_additions.sql)
 * for the durable review/approval record of proposed write actions.
 */
import { z } from 'zod'
import { UuidSchema, DateOnlySchema } from './common'

// ---- Read tools ---------------------------------------------------------

export const GetExpensesArgsSchema = z.object({
  trip_id: UuidSchema,
  category: z.string().optional(),
  paid_by: UuidSchema.optional(),
  date_from: DateOnlySchema.optional(),
  date_to: DateOnlySchema.optional(),
})

export const GetExpenseDetailsArgsSchema = z.object({
  expense_id: UuidSchema,
})

export const GetBalancesArgsSchema = z.object({
  trip_id: UuidSchema,
})

export const GetPendingClaimsArgsSchema = z.object({
  trip_id: UuidSchema,
  user_id: UuidSchema.optional(),
})

export const GetItineraryArgsSchema = z.object({
  trip_id: UuidSchema,
  date_from: DateOnlySchema.optional(),
  date_to: DateOnlySchema.optional(),
})

export const GetOptionsArgsSchema = z.object({
  section_id: UuidSchema,
})

export const GetConfirmationStatusArgsSchema = z.object({
  trip_id: UuidSchema,
})

export const SearchPlacesArgsSchema = z.object({
  trip_id: UuidSchema,
  query: z.string().min(1),
})

// ---- Write tools (organizer-only, confirm-before-execute) ---------------

export const CreateEventArgsSchema = z.object({
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

export const UpdateEventArgsSchema = z.object({
  event_id: UuidSchema,
  title: z.string().min(1).max(200).optional(),
  event_date: DateOnlySchema.optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

export const DeleteEventArgsSchema = z.object({
  event_id: UuidSchema,
})

export const CreateExpenseDraftArgsSchema = z.object({
  trip_id: UuidSchema,
  description: z.string().min(1).max(500),
  amount: z.number().positive(),
  currency: z.string().length(3),
  paid_by: UuidSchema,
  payment_date: DateOnlySchema.optional(),
  category: z.enum(['accommodation', 'transport', 'food', 'activities', 'equipment', 'other']).optional(),
  participant_ids: z.array(UuidSchema).optional(),
})

export const RecordSettlementArgsSchema = z.object({
  trip_id: UuidSchema,
  from_user_id: UuidSchema,
  to_user_id: UuidSchema,
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
})

export const ClosePollArgsSchema = z.object({
  section_id: UuidSchema,
})

export const DraftNudgeArgsSchema = z.object({
  trip_id: UuidSchema,
  target_user_id: UuidSchema,
  blocker_type: z.enum(['pending_rsvp', 'unvoted_poll', 'unclaimed_items', 'unpaid_settlement']),
  blocker_entity_id: UuidSchema.optional(),
})

/**
 * Full tool registry: name -> args schema. Used to generate the Anthropic
 * `tools` array (name + input_schema) and to validate tool_use blocks
 * before executing the corresponding handler.
 */
export const ChatToolContracts = {
  // read
  get_expenses: GetExpensesArgsSchema,
  get_expense_details: GetExpenseDetailsArgsSchema,
  get_balances: GetBalancesArgsSchema,
  get_pending_claims: GetPendingClaimsArgsSchema,
  get_itinerary: GetItineraryArgsSchema,
  get_options: GetOptionsArgsSchema,
  get_confirmation_status: GetConfirmationStatusArgsSchema,
  search_places: SearchPlacesArgsSchema,
  // write (organizer-only, confirm-before-execute)
  create_event: CreateEventArgsSchema,
  update_event: UpdateEventArgsSchema,
  delete_event: DeleteEventArgsSchema,
  create_expense_draft: CreateExpenseDraftArgsSchema,
  record_settlement: RecordSettlementArgsSchema,
  close_poll: ClosePollArgsSchema,
  draft_nudge: DraftNudgeArgsSchema,
} as const

export type ChatToolName = keyof typeof ChatToolContracts

export const READ_TOOL_NAMES = [
  'get_expenses',
  'get_expense_details',
  'get_balances',
  'get_pending_claims',
  'get_itinerary',
  'get_options',
  'get_confirmation_status',
  'search_places',
] as const satisfies readonly ChatToolName[]

export const WRITE_TOOL_NAMES = [
  'create_event',
  'update_event',
  'delete_event',
  'create_expense_draft',
  'record_settlement',
  'close_poll',
  'draft_nudge',
] as const satisfies readonly ChatToolName[]

export type ChatToolArgs<Name extends ChatToolName> = z.infer<(typeof ChatToolContracts)[Name]>
