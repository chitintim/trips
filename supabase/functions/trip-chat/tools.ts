/**
 * trip-chat v2 tool implementations (plan §13). Every READ tool here is
 * executed as a Supabase query using the CALLER's JWT (the client passed in
 * is always callerClient(req) from _shared/supabaseClients.ts) -- never the
 * service role -- so RLS is the enforcement layer for what the model can
 * see, exactly like a human using the app.
 *
 * Tool names/arg shapes mirror _shared/contracts/chatToolContracts.ts
 * exactly; this file is the "implementation" half (Supabase queries), the
 * contracts file is the "shape" half (Zod schemas -> Anthropic tool JSON
 * schema).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  ChatToolContracts,
  type ChatToolName,
  type ChatToolArgs,
} from '../_shared/contracts/chatToolContracts.ts'

/** Builds the Anthropic `tools` array (name + input_schema) for the given tool names. */
export function buildAnthropicToolDefs(names: readonly ChatToolName[]) {
  const descriptions: Record<ChatToolName, string> = {
    get_expenses: 'List expenses for the trip, optionally filtered by category, payer, or date range. Use this to answer questions about spending.',
    get_expense_details: 'Get full details (line items, splits, claims) for one specific expense by ID.',
    get_balances: 'Get who-owes-whom balances for the trip (who has paid more/less than their share).',
    get_pending_claims: 'List itemized expenses awaiting participant item-claims, optionally filtered to one user.',
    get_itinerary: 'List timeline events (flights, activities, accommodation, etc.) for the trip, optionally filtered by date range.',
    get_options: 'List the options (choices being decided on) within one planning section, including vote/selection counts.',
    get_confirmation_status: 'Get the RSVP/confirmation status summary for all participants in the trip.',
    search_places: 'Search for a place associated with this trip by name (fuzzy match against the places table).',
    create_event: 'Propose creating a new timeline event. Organizer-only -- this stages a change for human review, it does not write directly.',
    update_event: 'Propose updating an existing timeline event. Organizer-only -- staged for human review.',
    delete_event: 'Propose deleting a timeline event. Organizer-only -- staged for human review, deletes always require individual confirmation.',
    create_expense_draft: 'Propose creating a new expense from a natural-language description (e.g. "I paid 4200 yen for ramen"). Staged for human review.',
    record_settlement: 'Propose recording a settlement payment between two participants. Organizer-only -- staged for human review.',
    close_poll: 'Propose closing voting on a planning section. Organizer-only -- staged for human review.',
    draft_nudge: 'Draft a friendly reminder message for a participant about a specific blocker (pending RSVP, unvoted poll, etc).',
  }

  return names.map((name) => ({
    name,
    description: descriptions[name],
    input_schema: zodToJsonSchemaLoose(ChatToolContracts[name]),
  }))
}

/**
 * Minimal, hand-rolled Zod->JSON-Schema conversion covering exactly the
 * shapes used in chatToolContracts.ts (z.object of string/uuid/date/enum/
 * number/optional/array fields). Not a general-purpose converter --
 * intentionally narrow so it stays auditable. If chatToolContracts.ts grows
 * shapes this doesn't handle, extend this function, don't reach for a zod-
 * to-json-schema dependency (keeps _shared dependency-light per plan §13).
 */
// deno-lint-ignore no-explicit-any
function zodToJsonSchemaLoose(schema: any): Record<string, unknown> {
  const shape = schema._def?.shape?.() ?? schema.shape
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries<any>(shape)) {
    const { jsonType, isOptional } = describeZodType(value)
    properties[key] = jsonType
    if (!isOptional) required.push(key)
  }

  return {
    type: 'object',
    properties,
    required,
  }
}

// deno-lint-ignore no-explicit-any
function describeZodType(zodType: any): { jsonType: Record<string, unknown>; isOptional: boolean } {
  let current = zodType
  let isOptional = false

  // Unwrap ZodOptional / ZodNullable / ZodDefault wrappers.
  while (current?._def) {
    const typeName = current._def.typeName
    if (typeName === 'ZodOptional') {
      isOptional = true
      current = current._def.innerType
      continue
    }
    if (typeName === 'ZodNullable') {
      current = current._def.innerType
      continue
    }
    if (typeName === 'ZodDefault') {
      current = current._def.innerType
      continue
    }
    break
  }

  const typeName = current?._def?.typeName

  if (typeName === 'ZodEnum') {
    return { jsonType: { type: 'string', enum: current._def.values }, isOptional }
  }
  if (typeName === 'ZodNumber') {
    return { jsonType: { type: 'number' }, isOptional }
  }
  if (typeName === 'ZodArray') {
    return { jsonType: { type: 'array', items: describeZodType(current._def.type).jsonType }, isOptional }
  }
  // ZodString (incl. uuid/date-pattern refinements) and anything else -> string.
  return { jsonType: { type: 'string' }, isOptional }
}

export interface ToolExecutionContext {
  client: SupabaseClient
  tripId: string
  isOrganizer: boolean
}

/** Result of executing a read tool: JSON-serializable data for the tool_result content. */
export async function executeReadTool(
  name: ChatToolName,
  args: unknown,
  ctx: ToolExecutionContext
): Promise<unknown> {
  const schema = ChatToolContracts[name]
  const parsed = schema.parse(args) as ChatToolArgs<typeof name>

  switch (name) {
    case 'get_expenses': {
      const a = parsed as ChatToolArgs<'get_expenses'>
      let query = ctx.client
        .from('expenses')
        .select('id, description, amount, currency, category, paid_by, payment_date, status')
        .eq('trip_id', ctx.tripId)
        .order('payment_date', { ascending: false })
        .limit(50)
      if (a.category) query = query.eq('category', a.category)
      if (a.paid_by) query = query.eq('paid_by', a.paid_by)
      if (a.date_from) query = query.gte('payment_date', a.date_from)
      if (a.date_to) query = query.lte('payment_date', a.date_to)
      const { data, error } = await query
      if (error) throw new Error(`get_expenses failed: ${error.message}`)
      return data
    }

    case 'get_expense_details': {
      const a = parsed as ChatToolArgs<'get_expense_details'>
      const { data, error } = await ctx.client
        .from('expenses')
        .select('*, expense_splits(user_id, amount, split_type), expense_item_claims(user_id, amount_owed), expense_line_items(*)')
        .eq('id', a.expense_id)
        .eq('trip_id', ctx.tripId)
        .maybeSingle()
      if (error) throw new Error(`get_expense_details failed: ${error.message}`)
      if (!data) throw new Error('Expense not found or not in this trip')
      return data
    }

    case 'get_balances': {
      // Balances are a derived computation (paid - owed + settlements), not
      // a single table -- pull the raw rows here and let the model reason
      // over them (kept intentionally simple; a dedicated RPC would be a
      // good follow-up for workstream D to expose to both UI and chat).
      const [expensesRes, splitsRes, claimsRes, settlementsRes, participantsRes] = await Promise.all([
        ctx.client.from('expenses').select('id, paid_by, amount, base_currency_amount, currency, fx_rate').eq('trip_id', ctx.tripId),
        ctx.client.from('expense_splits').select('expense_id, user_id, amount, base_currency_amount'),
        ctx.client.from('expense_item_claims').select('expense_id, user_id, amount_owed'),
        ctx.client.from('settlements').select('from_user_id, to_user_id, amount').eq('trip_id', ctx.tripId),
        ctx.client.from('trip_participants').select('user_id, user:user_id(full_name, email)').eq('trip_id', ctx.tripId).eq('active', true),
      ])
      if (expensesRes.error) throw new Error(`get_balances failed: ${expensesRes.error.message}`)
      const expenses = expensesRes.data ?? []
      const expenseIds = new Set(expenses.map((e) => e.id))
      const splits = (splitsRes.data ?? []).filter((s) => expenseIds.has(s.expense_id))
      const claims = (claimsRes.data ?? []).filter((c) => expenseIds.has(c.expense_id))
      const settlements = settlementsRes.data ?? []
      const participants = participantsRes.data ?? []

      const balances = participants.map((p) => {
        const paid = expenses.filter((e) => e.paid_by === p.user_id).reduce((s, e) => s + Number(e.base_currency_amount ?? e.amount), 0)
        const owedSplits = splits.filter((s) => s.user_id === p.user_id).reduce((s, sp) => s + Number(sp.base_currency_amount ?? sp.amount), 0)
        const owedClaims = claims.filter((c) => c.user_id === p.user_id).reduce((s, c) => {
          const exp = expenses.find((e) => e.id === c.expense_id)
          const rate = exp?.fx_rate ? Number(exp.fx_rate) : 1
          return s + Number(c.amount_owed) * rate
        }, 0)
        const settledPaid = settlements.filter((s) => s.from_user_id === p.user_id).reduce((s, x) => s + Number(x.amount), 0)
        const settledReceived = settlements.filter((s) => s.to_user_id === p.user_id).reduce((s, x) => s + Number(x.amount), 0)
        return {
          user_id: p.user_id,
          name: (p.user as any)?.full_name || (p.user as any)?.email || 'Unknown',
          net_balance: paid - owedSplits - owedClaims + settledPaid - settledReceived,
        }
      })
      return { balances }
    }

    case 'get_pending_claims': {
      const a = parsed as ChatToolArgs<'get_pending_claims'>
      const { data, error } = await ctx.client
        .from('expenses')
        .select('id, description, amount, currency, status, expense_item_claims(user_id), expense_allocation_links(code)')
        .eq('trip_id', ctx.tripId)
        .eq('ai_parsed', true)
        .in('status', ['unallocated', 'pending_allocation'])
      if (error) throw new Error(`get_pending_claims failed: ${error.message}`)
      let results = data ?? []
      if (a.user_id) {
        results = results.filter((e: any) => !(e.expense_item_claims ?? []).some((c: any) => c.user_id === a.user_id))
      }
      return results
    }

    case 'get_itinerary': {
      const a = parsed as ChatToolArgs<'get_itinerary'>
      let query = ctx.client
        .from('trip_timeline_events')
        .select('id, title, event_date, start_time, end_time, category, location, description')
        .eq('trip_id', ctx.tripId)
        .order('event_date')
        .order('start_time')
      if (a.date_from) query = query.gte('event_date', a.date_from)
      if (a.date_to) query = query.lte('event_date', a.date_to)
      const { data, error } = await query
      if (error) throw new Error(`get_itinerary failed: ${error.message}`)
      return data
    }

    case 'get_options': {
      const a = parsed as ChatToolArgs<'get_options'>
      const { data, error } = await ctx.client
        .from('options')
        .select('id, title, description, price, currency, status, selections(user_id), option_votes(user_id)')
        .eq('section_id', a.section_id)
        .order('order_index')
      if (error) throw new Error(`get_options failed: ${error.message}`)
      return data
    }

    case 'get_confirmation_status': {
      const { data, error } = await ctx.client
        .from('trip_participants')
        .select('user_id, confirmation_status, conditional_type, conditional_date, user:user_id(full_name, email)')
        .eq('trip_id', ctx.tripId)
        .eq('active', true)
      if (error) throw new Error(`get_confirmation_status failed: ${error.message}`)
      return data
    }

    case 'search_places': {
      const a = parsed as ChatToolArgs<'search_places'>
      const { data, error } = await ctx.client
        .from('places')
        .select('id, name, address, lat, lng, google_maps_link, google_place_url')
        .eq('trip_id', ctx.tripId)
        .ilike('name', `%${a.query}%`)
        .limit(10)
      if (error) throw new Error(`search_places failed: ${error.message}`)
      return data
    }

    default:
      throw new Error(`${name} is not a read tool`)
  }
}
