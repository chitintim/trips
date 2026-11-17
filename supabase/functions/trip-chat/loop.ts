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

export const CHAT_MAX_TOKENS = 16000 // thinking counts toward max_tokens
export const CHAT_EFFORT = 'low' as const

export const FINAL_ITERATION_INSTRUCTION = 'Answer the question now in plain text. Do not call any more tools.'
export const NOTICE_REFUSAL = "I can't help with that one."
export const NOTICE_CUT_SHORT = '(cut short)'
export const NOTICE_TOOLS_EXHAUSTED = "I couldn't finish looking that up; try a narrower question."
export const NOTICE_EMPTY = "I couldn't put an answer together. Please try again."
export const NOTICE_TOO_LONG = 'That conversation is too long. Start a new chat and try again.'
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

export async function runChatTurn(deps: ChatLoopDeps): Promise<{ finalText: string }> {
  const { conversation, send, usage } = deps
  const midSystem = supportsMidConversationSystem(deps.model)
  let finalText = ''
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
      // Replay the assistant turn exactly as streamed (thinking + signature, text, tool_use).
      conversation.push({ role: 'assistant', content: turn.content as AnthropicContentBlock[] })
      const results: AnthropicContentBlock[] = []
      for (const tu of turn.toolUses) {
        try {
          const out = await deps.executeTool(tu)
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.is_error ? { is_error: true } : {}) })
        } catch (toolError) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolError instanceof Error ? toolError.message : 'Tool execution failed',
            is_error: true,
          })
        }
      }
      conversation.push({ role: 'user', content: results })
      continue
    }

    const notice = stopReasonNotice(turn.stop_reason === 'tool_use' ? 'end_turn' : turn.stop_reason)
    if (notice === NOTICE_CUT_SHORT && finalText.trim()) emit(` ${NOTICE_CUT_SHORT}`)
    else if (notice) emitNotice(notice)
    break
  }

  if (!finalText.trim()) emitNotice(NOTICE_EMPTY)
  return { finalText }
}
