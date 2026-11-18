/**
 * The ONE tools array: identical for every user and every turn (prompt-cache
 * prefix). Permissions are enforced when a tool runs, never by hiding it.
 */
import type { AnthropicToolDef } from '../_shared/anthropic.ts'
import type { ToolModule } from './tools/types.ts'
import { READ_TOOLS } from './tools/read/index.ts'
import { PROPOSE_TOOLS } from './tools/propose/index.ts'
import { toApiSchema } from './toolSchema.ts'

export const LEGACY_PROPOSE_ACTIONS = 'propose_actions'

/** Legacy organiser changeset tool (no delete_request any more, D5). Its item schema is open by design. */
export const LEGACY_PROPOSE_TOOL_DEF = {
  name: LEGACY_PROPOSE_ACTIONS,
  description:
    'Organisers only. Stage a batch of plan changes (create/update events, option drafts, booking drafts, expense drafts) for review in the Organize screen. Nothing is applied until a human approves each card. ' +
    'Prefer propose_create_question / propose_add_option / propose_add_expense when they fit. Deleting is not possible from chat: use open_screen instead. Each action needs type and a unique idempotency_key. Max 20 actions.',
  input_schema: {
    type: 'object',
    properties: {
      source_text: { type: 'string', description: "Short summary of the user's request" },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          description:
            'create_event{trip_id,title,event_date(YYYY-MM-DD),start_time?,end_time?,all_day?,category?,location?,description?}; ' +
            'create_option{section_id,title,description?,price?,currency?,price_type?}; ' +
            'create_booking_draft{trip_id,option_id?,title,vendor?,confirmation_ref?,amount?,currency?,booking_date?,cancellation_deadline?}; ' +
            'create_expense_draft{trip_id,description,amount,currency,paid_by?,payment_date?,category?,participant_ids?}; update_event{event_id,...}. ALWAYS include type and idempotency_key.',
          properties: {
            type: { type: 'string', enum: ['create_event', 'create_option', 'create_booking_draft', 'create_expense_draft', 'update_event'] },
            idempotency_key: { type: 'string' },
          },
          required: ['type', 'idempotency_key'],
        },
      },
    },
    required: ['actions'],
  },
}

export const ALL_TOOLS: ToolModule[] = [...READ_TOOLS, ...PROPOSE_TOOLS]

export const TOOL_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]))

export function buildToolDefs(): AnthropicToolDef[] {
  return [
    ...ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: toApiSchema(t.inputSchema) as Record<string, unknown> })),
    LEGACY_PROPOSE_TOOL_DEF,
  ]
}

export function statusLabelFor(name: string): string {
  return TOOL_BY_NAME.get(name)?.statusLabel ?? (name === LEGACY_PROPOSE_ACTIONS ? 'Drafting changes…' : 'Working on it…')
}
