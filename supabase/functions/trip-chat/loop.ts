// The trip-chat model loop, separated from Deno.serve so it can be tested with
// canned SSE streams (no network, no API spend).
//
// Rules this file keeps (claude-api skill, Sonnet 5.5):
//  - Thinking blocks are replayed in the next request exactly as received
//    (the assistant turn is pushed as `turn.content`, never rebuilt).
//  - `system` and `tools` are identical on every iteration, so the prompt
//    cache prefix and the thinking-block binding are never broken. The
//    "answer now" instruction for the last iteration is a trailing
//    `role: "system"` message (Sonnet 5.5+). A model without that feature
//    (Sonnet 5, the rollback target) keeps the old behaviour: tools are
//    omitted on the last iteration instead.
//  - No temperature / thinking:{disabled} / forced tool_choice fields.
//  - Mid-stream `error` events throw (a truncated reply is never saved as
//    complete) and every stop reason ends in text the user can read.

import { AiCallError } from '../_shared/aiError.ts'
import { estimateCostUsd } from '../_shared/pricing.ts'
import {
  consumeAnthropicStream,
  StreamEventError,
  supportsMidConversationSystem,
  ZERO_USAGE,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRequestOptions,
  type AnthropicToolDef,
  type AnthropicUsage,
  type StreamProgress,
} from '../_shared/anthropic.ts'

// COST BOUNDS (see README "Cost bounds"). Every number here is a hard limit on one turn.
export const CHAT_MAX_TOKENS = 6000 // per model call; thinking counts toward it
export const CHAT_EFFORT = 'low' as const
/** The turn stops (with a plain message) once the model calls have written this many tokens in total. */
export const MAX_TURN_OUTPUT_TOKENS = 24_000
/** ... or once the summed cost of its calls (cache-weighted, estimateCostUsd) reaches this. */
export const MAX_TURN_COST_USD = 0.6
/** Tool calls run per model call; the rest are answered with a "too many" error and not run. */
export const MAX_TOOLS_PER_ROUND = 6
/** Total characters of tool results sent back in one round (each result is also capped by the handler). */
export const MAX_ROUND_RESULT_CHARS = 24_000
export const TRUNCATION_NOTE = '\n[...truncated: the result was too long. Tell the person it was cut short and ask for a narrower question.]'

export const FINAL_ITERATION_INSTRUCTION = 'Answer the question now in plain text. Do not call any more tools.'
export const NOTICE_REFUSAL = "I can't help with that one."
export const NOTICE_CUT_SHORT = '(cut short)'
export const NOTICE_TOOLS_EXHAUSTED = "I couldn't finish looking that up; try a narrower question."
export const NOTICE_EMPTY = "I couldn't put an answer together. Please try again."
export const NOTICE_TOO_LONG = 'That conversation is too long. Start a new chat and try again.'
export const NOTICE_TURN_LIMIT = 'That was a big question, so I stopped here. Ask me a narrower one and I will pick it up.'
export const NOTICE_GENERIC = 'Something went wrong. Please try again.'

export interface ToolUse {
  id: string
  name: string
  input: unknown
}
export interface ToolOutcome {
  content: string
  is_error?: boolean
}

export interface ChatLoopDeps {
  /** Starts one streamed model call; returns the raw SSE Response (createMessageStream in production). */
  callModel: (opts: AnthropicRequestOptions) => Promise<Response>
  model: string
  system: AnthropicRequestOptions['system']
  tools: AnthropicToolDef[]
  conversation: AnthropicMessage[]
  /** Runs one tool call. May throw: the error text goes back to the model as an is_error result. */
  executeTool: (tu: ToolUse) => Promise<ToolOutcome>
  send: (obj: unknown) => void
  /** Summed in place, also when a call fails part-way, so the caller can still log what was charged. */
  usage: AnthropicUsage
  /** Updated with the model id the API reports. */
  state: { model: string }
  maxIterations: number
  /** Called just before a tool runs (all calls of one round start together): the server sends a fixed-label `status` event. */
  onToolStart?: (tu: ToolUse) => void
}

/** Maps a stream `error` event to the same coded errors the rest of the AI code uses. */
export function streamEventToAiError(err: StreamEventError): AiCallError {
  const t = err.eventType
  if (t === 'overloaded_error' || t === 'api_error') return new AiCallError('busy', `stream error ${t}`)
  if (t === 'rate_limit_error') return new AiCallError('rate_limited', `stream error ${t}`)
  return new AiCallError('unknown', `stream error ${t}`)
}

/** User-visible text for a stop reason that is not a normal end of turn, or null when the reply is complete. */
export function stopReasonNotice(stopReason: string | null): string | null {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return null
    case 'max_tokens':
    case null: // the stream ended with no message_delta: truncated
      return NOTICE_CUT_SHORT
    case 'refusal':
      return NOTICE_REFUSAL
    case 'model_context_window_exceeded':
      return NOTICE_TOO_LONG
    default: // pause_turn and anything new
      return NOTICE_GENERIC
  }
}

/** Shortens tool_result blocks so their summed text fits `maxTotal` (equal shares), always leaving the model-visible marker. */
export function capRoundResults(results: AnthropicContentBlock[], maxTotal: number): AnthropicContentBlock[] {
  const size = (b: AnthropicContentBlock) => (b.type === 'tool_result' ? b.content.length : 0)
  if (results.reduce((a, b) => a + size(b), 0) <= maxTotal) return results
  const share = Math.max(500, Math.floor(maxTotal / Math.max(1, results.length)))
  return results.map((b) => {
    if (b.type !== 'tool_result' || b.content.length <= share) return b
    return { ...b, content: b.content.slice(0, share - TRUNCATION_NOTE.length > 0 ? share - TRUNCATION_NOTE.length : share) + TRUNCATION_NOTE }
  })
}

/**
 * Moving cache breakpoint: exactly one `cache_control` on the LAST tool_result of the conversation, so every
 * following round re-reads the earlier rounds from cache (0.05x input) instead of paying full input price.
 * Earlier tool_result breakpoints are removed (max 4 breakpoints per request: system x2, history, this one).
 * A round adds fewer than 20 blocks, so the previous breakpoint is always inside the 20-block lookback.
 */
export function moveToolBreakpoint(conversation: AnthropicMessage[]): void {
  let target: AnthropicContentBlock | null = null
  for (let i = conversation.length - 1; i >= 0 && !target; i--) {
    const c = conversation[i].content
    if (Array.isArray(c)) for (let j = c.length - 1; j >= 0; j--) if (c[j].type === 'tool_result') { target = c[j]; break }
  }
  for (const m of conversation) {
    if (!Array.isArray(m.content)) continue
    m.content = m.content.map((b) => {
      if (b.type !== 'tool_result') return b
      if (b === target) return { ...b, cache_control: { type: 'ephemeral' as const } }
      if (!('cache_control' in b)) return b
      const { cache_control: _drop, ...rest } = b
      return rest as AnthropicContentBlock
    })
  }
}

export interface ChatTurnResult {
  finalText: string
  /** Model calls made this turn. */
  iterations: number
  /** Tool names in call order (names only, for the usage log). */
  toolsUsed: string[]
}

export async function runChatTurn(deps: ChatLoopDeps): Promise<ChatTurnResult> {
  const { conversation, send, usage } = deps
  const midSystem = supportsMidConversationSystem(deps.model)
  let finalText = ''
  let iterations = 0
  const toolsUsed: string[] = []
  const emit = (t: string) => {
    finalText += t
    send({ type: 'text', text: t })
  }
  const emitNotice = (notice: string) => emit(finalText.trim() ? `\n\n${notice}` : notice)

  for (let iteration = 0; iteration < deps.maxIterations; iteration++) {
    const last = iteration === deps.maxIterations - 1
    // Constant tools + system on every call; the last-turn instruction is a trailing system message.
    const messages: AnthropicMessage[] = last && midSystem
      ? [...conversation, { role: 'system', content: FINAL_ITERATION_INSTRUCTION }]
      : conversation
    iterations++
    const response = await deps.callModel({
      model: deps.model,
      max_tokens: CHAT_MAX_TOKENS,
      system: deps.system,
      messages,
      tools: last && !midSystem ? undefined : deps.tools,
      output_config: { effort: CHAT_EFFORT },
    })

    // Iterations after the first start a new paragraph so words never run together.
    let started = false
    const progress: StreamProgress = { usage: { ...ZERO_USAGE }, model: '' }
    let turn
    try {
      turn = await consumeAnthropicStream(response, (delta) => {
        if (!started) {
          started = true
          if (finalText.trim()) emit('\n\n')
        }
        emit(delta)
      }, { throwOnStreamError: true, progress })
    } catch (err) {
      if (err instanceof StreamEventError) throw streamEventToAiError(err)
      throw err
    } finally {
      usage.input_tokens += progress.usage.input_tokens
      usage.output_tokens += progress.usage.output_tokens
      usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + (progress.usage.cache_creation_input_tokens ?? 0)
      usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (progress.usage.cache_read_input_tokens ?? 0)
      if (progress.model) deps.state.model = progress.model
    }

    if (turn.stop_reason === 'tool_use' && turn.toolUses.length > 0) {
      if (last) {
        emitNotice(NOTICE_TOOLS_EXHAUSTED)
        break
      }
      // Hard per-turn spend bound: stop before running more tools or paying for another call.
      if (usage.output_tokens >= MAX_TURN_OUTPUT_TOKENS || estimateCostUsd(usage, deps.state.model || deps.model) >= MAX_TURN_COST_USD) {
        emitNotice(NOTICE_TURN_LIMIT)
        break
      }
      // Replay the assistant turn exactly as streamed (thinking + signature, text, tool_use).
      conversation.push({ role: 'assistant', content: turn.content as AnthropicContentBlock[] })
      // Parallel tool calls run concurrently; ALL results go back in ONE user message, in call order.
      for (const tu of turn.toolUses.slice(0, MAX_TOOLS_PER_ROUND)) {
        toolsUsed.push(tu.name)
        deps.onToolStart?.(tu)
      }
      const rawResults: AnthropicContentBlock[] = await Promise.all(turn.toolUses.map(async (tu, idx): Promise<AnthropicContentBlock> => {
        if (idx >= MAX_TOOLS_PER_ROUND) {
          return { type: 'tool_result', tool_use_id: tu.id, content: `Not run: at most ${MAX_TOOLS_PER_ROUND} tool calls per step. Ask for fewer things at once.`, is_error: true }
        }
        try {
          const out = await deps.executeTool(tu)
          return { type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.is_error ? { is_error: true } : {}) }
        } catch (toolError) {
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolError instanceof Error ? toolError.message : 'Tool execution failed',
            is_error: true,
          }
        }
      }))
      conversation.push({ role: 'user', content: capRoundResults(rawResults, MAX_ROUND_RESULT_CHARS) })
      moveToolBreakpoint(conversation)
      continue
    }

    const notice = stopReasonNotice(turn.stop_reason === 'tool_use' ? 'end_turn' : turn.stop_reason)
    if (notice === NOTICE_CUT_SHORT && finalText.trim()) emit(` ${NOTICE_CUT_SHORT}`)
    else if (notice) emitNotice(notice)
    break
  }

  if (!finalText.trim()) emitNotice(NOTICE_EMPTY)
  return { finalText, iterations, toolsUsed }
}
