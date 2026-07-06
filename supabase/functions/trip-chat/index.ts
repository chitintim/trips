// Trip Chat AI Assistant Edge Function v2 (plan §13)
//
// REWRITE: context-stuffing -> tool use.
//  - Slim system prompt: trip header + participants + requester role only
//    (v1 serialized the whole trip, ~15-20K tokens/query).
//  - READ tools (get_expenses, get_balances, ...) are executed server-side
//    as Supabase queries under the CALLER's JWT so RLS applies -- never the
//    service role for reads.
//  - WRITE intents (organizers only): the model emits a ProposedAction
//    changeset via the propose_actions tool; the function validates it
//    against ProposalSchema and INSERTS into ai_proposals (status pending),
//    then streams back {type:'proposal', proposal_id}. The frontend renders
//    review cards and applies under the approving user's JWT. This function
//    NEVER writes trip data directly (v1 wrote timeline events with the
//    service role -- that pathway is gone).
//  - SSE envelope stays compatible with the current ChatDrawer
//    ({type:'text'|'done'|'error'}), with {type:'proposal', proposal_id}
//    added.
//  - Rate limit via consume_rate_limit RPC: organizers 40/day,
//    participants 15/day.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse } from '../_shared/errors.ts'
import { callerClient, serviceClient, requireUser, requireTripParticipant, isTripOrganizer } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import {
  createMessageStream,
  consumeAnthropicStream,
  padForCaching,
  CLAUDE_MODEL,
  type AnthropicMessage,
  type AnthropicUsage,
  type AnthropicContentBlock,
} from '../_shared/anthropic.ts'
import { logAiUsage } from '../_shared/usage.ts'
import { buildAnthropicToolDefs, executeReadTool } from './tools.ts'
import { READ_TOOL_NAMES, type ChatToolName } from '../_shared/contracts/chatToolContracts.ts'
import { ProposalSchema, ProposedActionSchema } from '../_shared/contracts/aiProposal.ts'

const MAX_TOOL_ITERATIONS = 6
const MAX_LENGTH_ORGANIZER = 10000
const MAX_LENGTH_PARTICIPANT = 700

/**
 * The staged-write tool: instead of separate create_event/update_event/...
 * write tools that execute directly (v1 behavior), organizers get ONE
 * propose_actions tool whose input is a ProposedAction[] changeset. The
 * function validates against ProposalSchema and stores it in ai_proposals
 * for human review -- nothing is written to trip data here.
 */
const PROPOSE_ACTIONS_TOOL = {
  name: 'propose_actions',
  description:
    'Stage a batch of proposed changes (create/update events, expense drafts, booking drafts, options, delete requests) for human review. ' +
    'Nothing is applied until a human approves each card in the review UI. Use this for ANY request to add/change/delete trip data. ' +
    'Each action needs a unique idempotency_key (short random string). Max 20 actions per proposal. ' +
    'Deletes are delete_request actions carrying entity_type + entity_id -- they always require individual human confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      source_text: { type: 'string', description: "Short summary of the user's request that motivated these actions" },
      actions: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          description:
            'A ProposedAction. type is one of create_event | create_option | create_booking_draft | create_expense_draft | update_event | delete_request. ' +
            'Fields per type: create_event{trip_id,title,event_date(YYYY-MM-DD),start_time?,end_time?,all_day?,category?,location?,description?}; ' +
            'create_option{section_id,title,description?,price?,currency?,price_type?}; ' +
            'create_booking_draft{trip_id,option_id?,title,vendor?,confirmation_ref?,amount?,currency?,booking_date?,cancellation_deadline?}; ' +
            'create_expense_draft{trip_id,description,amount,currency,paid_by?,payment_date?,category?,participant_ids?}; ' +
            'update_event{event_id,...fields to change}; ' +
            'delete_request{entity_type(event|option|booking|expense|checklist_item),entity_id,reason?}. ' +
            'ALWAYS include type and idempotency_key.',
          properties: {
            type: {
              type: 'string',
              enum: ['create_event', 'create_option', 'create_booking_draft', 'create_expense_draft', 'update_event', 'delete_request'],
            },
            idempotency_key: { type: 'string' },
          },
          required: ['type', 'idempotency_key'],
        },
      },
    },
    required: ['actions'],
  },
}

// deno-lint-ignore no-explicit-any
function buildSystemPrompt(trip: any, participants: any[], userName: string, isOrganizer: boolean): string {
  const participantList = participants
    // deno-lint-ignore no-explicit-any
    .map((p: any) => `- ${p.user?.full_name || p.user?.email || 'Unknown'} (id: ${p.user_id}, ${p.role})`)
    .join('\n')

  const roleInstructions = isOrganizer
    ? `The current user "${userName}" is an ORGANIZER. When they ask you to add, change, or delete trip data (events, expenses, bookings, options), use the propose_actions tool to stage the changes for their review -- changes are NEVER applied directly; a human approves each one. After staging, tell them what you proposed and that it's awaiting their review.`
    : `The current user "${userName}" is a PARTICIPANT (not an organizer). They can ask questions about the trip, but you MUST NOT stage any write actions. If they ask to change something, politely tell them only organizers can make changes.`

  return `You are a helpful trip planning assistant for the trip "${trip.name}".

TRIP HEADER:
- Destination: ${trip.location}
- Dates: ${trip.start_date} to ${trip.end_date}
- Status: ${trip.status}
- Base currency: ${trip.base_currency || 'GBP'}
- Trip ID: ${trip.id}

PARTICIPANTS:
${participantList}

${roleInstructions}

HOW TO ANSWER:
- Use the read tools (get_expenses, get_balances, get_itinerary, get_confirmation_status, ...) to look up live trip data before answering questions about money, plans, or people. Don't guess -- fetch.
- Prefer one or two well-chosen tool calls over many. Summarize tool results in friendly, concise prose; never dump raw JSON at the user.
- Amounts: mention the currency. Dates: be explicit (e.g. "Saturday 14 March").
- This is a SHARED chat visible to all participants. Be helpful and informative to everyone, and don't reveal anything the tools didn't return.
- When you used propose_actions, end your reply by summarizing the staged changes and noting they need review/approval.`
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    const supabaseClient = callerClient(req)
    const user = await requireUser(supabaseClient)

    const { tripId, message } = await req.json()
    if (!tripId || !message) {
      throw new Error('Missing tripId or message')
    }

    await requireTripParticipant(supabaseClient, tripId, user.id)
    const organizer = await isTripOrganizer(supabaseClient, tripId, user.id)

    const maxLength = organizer ? MAX_LENGTH_ORGANIZER : MAX_LENGTH_PARTICIPANT
    if (message.length > maxLength) {
      throw new Error(`Message too long (${message.length} chars). Maximum is ${maxLength} characters.`)
    }

    // Rate limit: organizers 40/day, participants 15/day (plan §13).
    await consumeRateLimit(supabaseClient, organizer ? RATE_LIMITS.chatOrganizer : RATE_LIMITS.chatParticipant)

    // Slim context: trip header + participants + recent chat history.
    // All reads under the caller's JWT.
    const [tripResult, participantsResult, chatResult, userResult] = await Promise.all([
      supabaseClient.from('trips').select('id, name, location, start_date, end_date, status, base_currency').eq('id', tripId).single(),
      supabaseClient.from('trip_participants').select('user_id, role, user:user_id(full_name, email)').eq('trip_id', tripId).eq('active', true),
      supabaseClient.from('trip_chat_messages').select('role, content, user_id').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(30),
      supabaseClient.from('users').select('full_name, email').eq('id', user.id).single(),
    ])

    if (tripResult.error || !tripResult.data) {
      throw new Error('Trip not found')
    }

    const participants = participantsResult.data ?? []
    const userName = userResult.data?.full_name || userResult.data?.email || 'Unknown'

    // Build conversation history (oldest first), attributing user turns.
    const nameByUserId = new Map<string, string>()
    for (const p of participants) {
      // deno-lint-ignore no-explicit-any
      nameByUserId.set(p.user_id, (p.user as any)?.full_name || (p.user as any)?.email || 'Someone')
    }
    // deno-lint-ignore no-explicit-any
    let history: AnthropicMessage[] = (chatResult.data ?? []).reverse().map((msg: any) =>
      msg.role === 'assistant'
        ? { role: 'assistant' as const, content: msg.content }
        : { role: 'user' as const, content: `[${nameByUserId.get(msg.user_id) ?? 'Someone'}]: ${msg.content}` }
    )
    // The API requires the first message to be a user turn.
    while (history.length > 0 && history[0].role === 'assistant') {
      history = history.slice(1)
    }

    const conversation: AnthropicMessage[] = [
      ...history,
      { role: 'user', content: `[${userName}]: ${message}` },
    ]

    const systemPrompt = buildSystemPrompt(tripResult.data, participants, userName, organizer)

    // Tools: read tools for everyone; propose_actions only for organizers.
    const tools = [
      ...buildAnthropicToolDefs(READ_TOOL_NAMES),
      ...(organizer ? [PROPOSE_ACTIONS_TOOL] : []),
    ]

    // Store the user message before calling the AI (service role -- matches
    // v1 behavior; trip_chat_messages inserts are server-authored).
    const admin = serviceClient()
    await admin.from('trip_chat_messages').insert({
      trip_id: tripId,
      user_id: user.id,
      role: 'user',
      content: message,
    })

    // SSE response stream to the client.
    const encoder = new TextEncoder()
    const totalUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    let modelUsed = CLAUDE_MODEL

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

        try {
          let finalText = ''
          let proposalId: string | null = null
          const proposalSummaries: Array<{ type: string; summary: string }> = []

          // Agentic tool loop: stream each model turn; execute read tools /
          // stage proposals between turns; stop on end_turn.
          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const isLastAllowedIteration = iteration === MAX_TOOL_ITERATIONS - 1
            const claudeResponse = await createMessageStream({
              model: CLAUDE_MODEL,
              max_tokens: 4096,
              system: [
                {
                  type: 'text',
                  text: padForCaching(systemPrompt),
                  cache_control: { type: 'ephemeral' },
                },
              ],
              messages: conversation,
              // On the final permitted iteration, force a text answer.
              tools: isLastAllowedIteration ? undefined : tools,
            })

            const turn = await consumeAnthropicStream(claudeResponse, (delta) => {
              finalText += delta
              send({ type: 'text', text: delta })
            })

            totalUsage.input_tokens += turn.usage.input_tokens
            totalUsage.output_tokens += turn.usage.output_tokens
            totalUsage.cache_creation_input_tokens = (totalUsage.cache_creation_input_tokens ?? 0) + (turn.usage.cache_creation_input_tokens ?? 0)
            totalUsage.cache_read_input_tokens = (totalUsage.cache_read_input_tokens ?? 0) + (turn.usage.cache_read_input_tokens ?? 0)
            if (turn.model) modelUsed = turn.model

            if (turn.stop_reason !== 'tool_use' || turn.toolUses.length === 0) {
              break // done -- end_turn (or max_tokens etc.)
            }

            // Append the assistant turn (text + tool_use blocks) to the conversation.
            const assistantContent: AnthropicContentBlock[] = []
            if (turn.text) assistantContent.push({ type: 'text', text: turn.text })
            for (const tu of turn.toolUses) {
              assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
            }
            conversation.push({ role: 'assistant', content: assistantContent })

            // Execute all requested tools; all results go back in ONE user message.
            const toolResults: AnthropicContentBlock[] = []
            for (const tu of turn.toolUses) {
              try {
                if (tu.name === 'propose_actions') {
                  if (!organizer) {
                    throw new Error('Only organizers can stage changes')
                  }
                  // Validate the changeset against the Proposal contract.
                  const rawInput = tu.input as { source_text?: string; actions?: unknown[] }
                  const actions = (rawInput.actions ?? []).map((a) => ProposedActionSchema.parse(a))
                  const proposal = ProposalSchema.parse({
                    trip_id: tripId,
                    source_text: rawInput.source_text ?? message,
                    actions,
                  })
                  // Insert under the CALLER's JWT -- the ai_proposals insert
                  // policy requires created_by = auth.uid() and trip
                  // membership, so RLS enforces this is legit.
                  const { data: inserted, error: insertError } = await supabaseClient
                    .from('ai_proposals')
                    .insert({
                      trip_id: proposal.trip_id,
                      created_by: user.id,
                      source_text: proposal.source_text ?? null,
                      actions: proposal.actions,
                      status: 'pending',
                    })
                    .select('id')
                    .single()
                  if (insertError || !inserted) {
                    throw new Error(`Failed to store proposal: ${insertError?.message ?? 'no data'}`)
                  }
                  proposalId = inserted.id
                  send({ type: 'proposal', proposal_id: proposalId })
                  for (const a of proposal.actions) {
                    // deno-lint-ignore no-explicit-any
                    proposalSummaries.push({ type: a.type, summary: 'title' in a ? ((a as any).title ?? a.type) : a.type })
                  }
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify({ ok: true, proposal_id: proposalId, staged_actions: proposal.actions.length }),
                  })
                } else if ((READ_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                  const result = await executeReadTool(tu.name as ChatToolName, tu.input, {
                    client: supabaseClient,
                    tripId,
                    isOrganizer: organizer,
                  })
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result),
                  })
                } else {
                  throw new Error(`Unknown tool: ${tu.name}`)
                }
              } catch (toolError) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content: toolError instanceof Error ? toolError.message : 'Tool execution failed',
                  is_error: true,
                })
              }
            }
            conversation.push({ role: 'user', content: toolResults })
          }

          // Persist the assistant reply (service role; metadata carries proposal linkage).
          await admin.from('trip_chat_messages').insert({
            trip_id: tripId,
            user_id: null,
            role: 'assistant',
            content: finalText || '(no response)',
            had_write_actions: proposalId != null,
            metadata: proposalId ? { proposal_id: proposalId } : null,
          })

          await logAiUsage({ userId: user.id, tripId, functionName: 'trip-chat', model: modelUsed, usage: totalUsage })

          // Final done event -- actions_summary keeps its v1 field name for
          // ChatDrawer compatibility; entries now describe STAGED proposals,
          // not executed writes (nothing is executed here).
          send({
            type: 'done',
            message: finalText,
            actions_summary: proposalSummaries,
            ...(proposalId ? { proposal_id: proposalId } : {}),
          })
          controller.close()
        } catch (streamError) {
          console.error('[trip-chat] stream error:', streamError)
          send({ type: 'error', error: streamError instanceof Error ? streamError.message : 'Stream interrupted' })
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
})
