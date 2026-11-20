// Trip Chat request handler (separated from Deno.serve so the whole turn can be
// tested with a fake database and a canned model stream: no network, no spend).
//
//  - Private thread per person per trip (thread_user_id) once the A1 migrations
//    are applied; before that the legacy shared history is used exactly as before.
//  - The model can only PROPOSE: propose tools write one chat_actions row
//    (service role) and the client executes on Confirm. This function never
//    writes trip data.
//  - SSE events are additive: status, text, action, done, error (+ legacy proposal).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, ForbiddenError, HttpError, RateLimitedError } from '../_shared/errors.ts'
import { callerClient, requireTripParticipant, requireUser, serviceClient } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { createMessageStream, MODEL_TRIP_CHAT, type AnthropicMessage, type AnthropicRequestOptions, type AnthropicUsage } from '../_shared/anthropic.ts'
import { estimateCostUsd } from '../_shared/pricing.ts'
import { logAiUsage } from '../_shared/usage.ts'
import { isMissingSchemaError } from '../_shared/todos/snapshot.ts'
import { ProposalSchema, ProposedActionSchema } from '../_shared/contracts/aiProposal.ts'
import { enforceDailySpend, DAILY_LIMIT_CODE, SPEND_LIMIT_CODE, SpendLimitError } from './spend.ts'
import { localNow } from './localTime.ts'
import { CHAT_EFFORT, MAX_ROUND_RESULT_CHARS, runChatTurn, TRUNCATION_NOTE, type ToolOutcome, type ToolUse } from './loop.ts'
import { chatStreamErrorLog, chatStreamErrorPayload } from './streamError.ts'
import { CHAT_OFF_CODE, CHAT_OFF_MESSAGE, decideChat } from './chatSettings.ts'
import { normalizeToolInput } from './toolSchema.ts'
import { LEGACY_PROPOSE_ACTIONS, TOOL_BY_NAME, buildToolDefs, statusLabelFor } from './registry.ts'
import { storedLinkOf, type StoredLink } from './storedLinks.ts'
import { STATIC_SYSTEM, tripBlock } from './prompt.ts'
import { stageWords } from './tools/read/index.ts'
import {
  buildContextBlock, loadActionOutcomes, loadHistory, loadThreadState, loadTripAndRoster, withHistoryBreakpoint,
} from './context.ts'
import type { ChatActionEnvelope, ToolCtx } from './tools/types.ts'

export const MAX_TOOL_ITERATIONS = 6
const MAX_LENGTH_ORGANIZER = 10000
const MAX_LENGTH_PARTICIPANT = 700
/** One tool result sent to the model (about 2.5k tokens); the round total is capped in loop.ts. */
export const MAX_TOOL_RESULT_CHARS = 8000
export { MAX_ROUND_RESULT_CHARS }
const PING_MS = 10_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chat is switched off for this trip (site switch or trip switch). HTTP 403 with code `chat_off`. */
class ChatOffError extends ForbiddenError {
  constructor() { super(CHAT_OFF_MESSAGE) }
}

export interface ChatDeps {
  callerClient: (req: Request) => SupabaseClient
  serviceClient: () => SupabaseClient
  callModel: (opts: AnthropicRequestOptions) => Promise<Response>
  model: string
  env: (name: string) => string | undefined
  logUsage: typeof logAiUsage
  log: (line: string) => void
  now: () => Date
  /** Test seam: replaces the keepalive timer. */
  pingMs?: number
}

export const realDeps: ChatDeps = {
  callerClient,
  serviceClient,
  callModel: createMessageStream,
  model: MODEL_TRIP_CHAT,
  env: (n) => Deno.env.get(n),
  logUsage: logAiUsage,
  log: (l) => console.log(l),
  now: () => new Date(),
}

export async function handleChat(req: Request, deps: ChatDeps = realDeps): Promise<Response> {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    const client = deps.callerClient(req)
    const user = await requireUser(client)

    const body = await req.json()
    const tripId: string = body?.tripId
    const message: string = body?.message
    if (!tripId || !message || typeof message !== 'string') throw new Error('Missing tripId or message')
    const clientTurnId: string | null = typeof body.turnId === 'string' && UUID_RE.test(body.turnId) ? body.turnId.toLowerCase() : null
    const turnId = clientTurnId ?? crypto.randomUUID()
    const tz: string | null = typeof body.tz === 'string' && body.tz.length <= 64 ? body.tz : null
    const page: string | null = ['today', 'plan', 'money', 'people'].includes(body.page) ? body.page : null

    await requireTripParticipant(client, tripId, user.id)
    const { trip, roster, viewer } = await loadTripAndRoster(client, tripId, user.id)

    // ONE decision per request (site switch + trip switch + env ceiling, chatSettings.ts): chat off is refused here, before any rate-limit token,
    // spend check, model call or message insert; the same decision feeds the tools, the prompt wording, action gating and done.actions_enabled.
    const admin = deps.serviceClient()
    const decision = await decideChat(admin, tripId, trip, deps.env('TRIP_CHAT_ACTIONS'), deps.now())
    if (!decision.chat) throw new ChatOffError()

    const maxLength = viewer.canManageTrip ? MAX_LENGTH_ORGANIZER : MAX_LENGTH_PARTICIPANT
    if (message.length > maxLength) throw new Error(`Message too long (${message.length} chars). Maximum is ${maxLength} characters.`)

    // Retry of a turn that already finished: answer from the stored reply, no model call, no charge.
    if (clientTurnId) {
      const replay = await replayStoredTurn(client, tripId, user.id, clientTurnId)
      if (replay) return sseResponse(replay)
    }

    await enforceDailySpend(admin, user.id, viewer.canManageTrip, deps.env, deps.now())
    await consumeRateLimit(client, viewer.canManageTrip ? RATE_LIMITS.chatOrganizer : RATE_LIMITS.chatParticipant)

    const thread = await loadThreadState(client, tripId, user.id)
    const nameById = new Map(roster.map((p) => [p.userId, p.name]))
    const history = await loadHistory(client, tripId, user.id, thread.clearedAt, nameById, turnId)

    const actionsEnabled = decision.actions
    const local = localNow(deps.now(), tz)
    const now = local.now
    const proposedIds: string[] = []
    const envelopes: ChatActionEnvelope[] = []
    let proposalId: string | null = null
    const proposalSummaries: Array<{ type: string; summary: string }> = []
    const links: StoredLink[] = []

    // Stream plumbing (the tool context needs `send` for action events).
    const encoder = new TextEncoder()
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>
    let closed = false
    const send = (obj: unknown) => { if (!closed) controllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)) }

    const ctx: ToolCtx = {
      client, admin, tripId, userId: user.id, turnId, trip, roster, me: viewer,
      actionsEnabled, today: local.today, now,
      private: history.private, userMessage: message, tzLabel: tz ? 'your local date' : 'UTC',
      proposedThisTurn: { count: 0 },
      emitAction: (a) => {
        envelopes.push(a)
        const link = storedLinkOf(a)
        if (link) links.push(link)
        if (a.requires !== 'link') proposedIds.push(a.id)
        send({ type: 'action', action: a })
      },
      memo: new Map(),
      lastSeenAt: thread.lastSeenAt,
    }

    const outcomes = await loadActionOutcomes(admin, tripId, user.id, history.lastTurnId)
    const contextBlock = await buildContextBlock({ ctx, page, outcomes, frozen: trip.settlement_snapshot != null })

    const conversation: AnthropicMessage[] = [
      ...withHistoryBreakpoint(history.messages),
      { role: 'user', content: [{ type: 'text', text: contextBlock }, { type: 'text', text: message }] },
    ]
    const system = [
      { type: 'text' as const, text: STATIC_SYSTEM, cache_control: { type: 'ephemeral' as const } },
      { type: 'text' as const, text: tripBlock(trip, roster, stageWords(trip, ctx.today), ctx.now), cache_control: { type: 'ephemeral' as const } },
    ]
    const tools = buildToolDefs()

    // Store the user message before calling the AI. A duplicate (retry after a failed turn) is fine.
    const rowBase = history.private ? { thread_user_id: user.id, turn_id: turnId } : {}
    const ins = await admin.from('trip_chat_messages').insert({ trip_id: tripId, user_id: user.id, role: 'user', content: message, ...rowBase })
    if (ins.error && (ins.error as { code?: string }).code !== '23505') console.error('[trip-chat] could not store the message')

    const totalUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const state = { model: deps.model }
    const t0 = Date.now()
    let tFirstText: number | null = null

    const executeTool = async (tu: ToolUse): Promise<ToolOutcome> => {
      if (tu.name === LEGACY_PROPOSE_ACTIONS) {
        if (!viewer.canManageTrip) return { content: JSON.stringify({ ok: false, error: 'Only organisers can stage changes. Offer a propose_* tool or open_screen instead.' }), is_error: true }
        const raw = tu.input as { source_text?: string; actions?: unknown[] }
        if ((raw.actions ?? []).some((a) => (a as { type?: string })?.type === 'delete_request')) {
          return { content: JSON.stringify({ ok: false, error: 'Deleting is not possible from chat. Use open_screen so the person can delete it in the app.' }), is_error: true }
        }
        const actions = (raw.actions ?? []).map((a) => ProposedActionSchema.parse(a))
        const proposal = ProposalSchema.parse({ trip_id: tripId, source_text: raw.source_text ?? message, actions })
        const { data: inserted, error: insertError } = await client
          .from('ai_proposals')
          .insert({ trip_id: proposal.trip_id, created_by: user.id, source_text: null /* never keep the organiser's private wording where trip members can read it */, actions: proposal.actions, status: 'pending' })
          .select('id')
          .single()
        if (insertError || !inserted) throw new Error('Failed to store the proposal')
        proposalId = inserted.id
        send({ type: 'proposal', proposal_id: proposalId })
        // deno-lint-ignore no-explicit-any
        for (const a of proposal.actions) proposalSummaries.push({ type: a.type, summary: 'title' in a ? ((a as any).title ?? a.type) : a.type })
        return { content: JSON.stringify({ ok: true, staged_actions: proposal.actions.length }) }
      }
      const tool = TOOL_BY_NAME.get(tu.name)
      if (!tool) {
        return { content: `Unknown tool "${tu.name}". Use one of: ${[...TOOL_BY_NAME.keys()].join(', ')}.`, is_error: true }
      }
      const out = await tool.run(normalizeToolInput(tool.inputSchema, tu.input), ctx)
      let content = JSON.stringify(out.content)
      if (content.length > MAX_TOOL_RESULT_CHARS) content = content.slice(0, MAX_TOOL_RESULT_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE
      return { content, ...(out.is_error ? { is_error: true } : {}) }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controllerRef = controller
        const ping = setInterval(() => { try { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')) } catch { /* closed */ } }, deps.pingMs ?? PING_MS)
        const sendTimed = (obj: unknown) => {
          if (tFirstText === null && (obj as { type?: string })?.type === 'text') tFirstText = Date.now() - t0
          send(obj)
        }
        try {
          const result = await runChatTurn({
            callModel: deps.callModel,
            model: deps.model,
            system,
            tools,
            conversation,
            executeTool,
            send: sendTimed,
            usage: totalUsage,
            state,
            maxIterations: MAX_TOOL_ITERATIONS,
            onToolStart: (tu) => send({ type: 'status', label: statusLabelFor(tu.name) }),
            // One ai_usage row per model call, written the moment the call ends (the daily spend cap reads these rows):
            // a turn that is cut off, errors or is abandoned still has every finished call on the books.
            onCallBilled: (u, model) => deps.logUsage({ userId: user.id, tripId, functionName: 'trip-chat', model, usage: u }),
          })

          let messageId: string | null = null
          const metadata = proposalId || proposedIds.length || links.length
            ? { ...(proposalId ? { proposal_id: proposalId } : {}), ...(proposedIds.length ? { action_ids: proposedIds } : {}), ...(links.length ? { links } : {}) }
            : null
          const saved = await admin.from('trip_chat_messages')
            .insert({ trip_id: tripId, user_id: null, role: 'assistant', content: result.finalText, had_write_actions: proposalId != null || proposedIds.length > 0, metadata, ...rowBase })
            .select('id').single()
          if (!saved.error && saved.data) messageId = (saved.data as { id: string }).id

          deps.log(JSON.stringify({
            fn: 'trip-chat', model: state.model, effort: CHAT_EFFORT, iterations: result.iterations, tools: result.toolsUsed,
            input: totalUsage.input_tokens, output: totalUsage.output_tokens,
            cache_read: totalUsage.cache_read_input_tokens ?? 0, cache_write: totalUsage.cache_creation_input_tokens ?? 0,
            cost_usd: estimateCostUsd(totalUsage, state.model), actions_proposed: proposedIds.length,
            actions_enabled: actionsEnabled, settings_source: decision.source, ...(decision.fallback ? { settings_fallback: decision.fallback } : {}), ms_first_text: tFirstText, ms_total: Date.now() - t0,
          }))

          send({
            type: 'done',
            message: result.finalText,
            message_id: messageId,
            turn_id: turnId,
            actions: proposedIds,
            actions_summary: proposalSummaries,
            actions_enabled: actionsEnabled,
            ...(proposalId ? { proposal_id: proposalId } : {}),
          })
        } catch (streamError) {
          console.error('[trip-chat] stream error:', chatStreamErrorLog(streamError))
          send(chatStreamErrorPayload(streamError))
        } finally {
          clearInterval(ping)
          closed = true
          try { controller.close() } catch { /* already closed */ }
        }
      },
    })
    return sseResponse(stream)
  } catch (error) {
    if (error instanceof ChatOffError) {
      console.error('[error]', 403, CHAT_OFF_CODE)
      return new Response(JSON.stringify({ success: false, error: error.message, code: CHAT_OFF_CODE }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (error instanceof SpendLimitError || error instanceof RateLimitedError) {
      const code = error instanceof SpendLimitError ? SPEND_LIMIT_CODE : DAILY_LIMIT_CODE
      console.error('[error]', 429, code)
      return new Response(JSON.stringify({ success: false, error: error.message, code }), {
        status: (error as HttpError).status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    return errorResponse(error)
  }
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  })
}

/** If this turn already has a stored reply, a stream that replays it (text, its actions, done). Null otherwise. */
async function replayStoredTurn(client: SupabaseClient, tripId: string, userId: string, turnId: string): Promise<ReadableStream<Uint8Array> | null> {
  const { data, error } = await client.from('trip_chat_messages').select('id, content')
    .eq('trip_id', tripId).eq('thread_user_id', userId).eq('turn_id', turnId).eq('role', 'assistant').maybeSingle()
  if (error || !data) return null
  const row = data as { id: string; content: string }
  const acts = await client.from('chat_actions').select('id, kind, params, preview, basis, requires, status, expires_at, turn_id')
    .eq('trip_id', tripId).eq('user_id', userId).eq('turn_id', turnId).order('created_at')
  const actions = isMissingSchemaError(acts.error) || !acts.data ? [] : (acts.data as ChatActionEnvelope[])
  const encoder = new TextEncoder()
  const events: unknown[] = [
    { type: 'text', text: row.content },
    ...actions.map((a) => ({ type: 'action', action: a })),
    { type: 'done', message: row.content, message_id: row.id, turn_id: turnId, actions: actions.map((a) => a.id), actions_summary: [], replayed: true },
  ]
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
}
