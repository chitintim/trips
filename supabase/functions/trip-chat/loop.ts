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
  /** Absolute epoch-ms time budget for the turn; a retry is skipped when its wait plus a minimal attempt would not fit. */
  deadlineAt?: number
  /** Test seam for the retry backoff. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Called with the usage of EACH model call as soon as it ends (also a call that failed part-way but was billed), so the
   * spend is recorded call by call and survives the function being cut off before the turn finishes. `usage` above still
   * holds the running total for the caps.
   */
  onCallBilled?: (usage: AnthropicUsage, model: string) => void | Promise<void>
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

// --- Never end a turn with a button and no facts ---------------------------------------------------------
/** Read tools whose results are the facts a money / receipt question needs. */
export const MONEY_READ_TOOLS: ReadonlySet<string> = new Set(['get_my_money', 'get_balances', 'list_expenses', 'get_receipt'])
const MONEY_LINK_TARGETS: ReadonlySet<string> = new Set(['settle', 'claim', 'payment'])
const SAYS_CANNOT = /can't|cannot|can not|unable|not able|won't|only (an )?organi[sz]ers?|ask an organi[sz]er|not something i/i
const SAYS_NOTHING_OWED = /all square|nothing|nobody|no one|settled|isn't owed|doesn't owe|don't owe|owes? no|no money/i
const TRIVIAL_TEXT_CHARS = 40
/** After a lookup AND a button, a reply this short is a line about the button, not the facts that were looked up. */
const BUTTON_AFTER_READ_CHARS = 120
const SHORT_ANSWER_CHARS = 200

export const ANSWER_NUDGE =
  'Your reply so far has a button but does not answer the question. If the person asked about money, a receipt or anything else you can look up, use the read tools (get_my_money for what they owe or are owed, get_balances for everyone) if you have not already, then write the answer in words with the actual names and amounts. If they asked for something you cannot do, say so in one sentence and who can. Do not call open_screen again.'

/**
 * True when the turn is about to end with a button (or a lookup) and no real answer: the final text is trivial,
 * or a money / receipt read ran but the text carries no figure, or a money screen was opened with no read at all.
 * Pure, so the eval applies exactly the same rule. A short refusal ("I can't freeze balances ...") is a complete answer.
 */
export function answerNudgeNeeded(i: { toolsUsed: string[]; linkTargets: string[]; text: string }): boolean {
  const text = i.text.trim()
  if (text.length >= SHORT_ANSWER_CHARS) return false
  const moneyRead = i.toolsUsed.some((t) => MONEY_READ_TOOLS.has(t))
  const hasFigure = /\d/.test(text)
  if (moneyRead) return !hasFigure && !SAYS_NOTHING_OWED.test(text) && !SAYS_CANNOT.test(text)
  if (i.linkTargets.length === 0) return false
  if (SAYS_CANNOT.test(text)) return false
  if (text.length < TRIVIAL_TEXT_CHARS) return true
  if (text.length < BUTTON_AFTER_READ_CHARS && !hasFigure && i.toolsUsed.some((t) => t !== 'open_screen' && !t.startsWith('propose_'))) return true
  return i.linkTargets.some((t) => MONEY_LINK_TARGETS.has(t)) && !hasFigure && !SAYS_NOTHING_OWED.test(text)
}

/**
 * The corrective message. A USER message on every model: the API accepts a mid-conversation `system` message only right
 * after a user message (or a server tool result), and this one follows the assistant's finished reply (a live eval run
 * got HTTP 400 for exactly that).
 */
export function answerNudgeMessage(_model: string): AnthropicMessage {
  return { role: 'user', content: ANSWER_NUDGE }
}

// --- Repeated sentences ------------------------------------------------------------------------------
const MIN_DEDUPE_CHARS = 24
const sentenceKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Streams model text through, dropping a sentence or line that already went out earlier in the same turn (a model
 * that writes "Let me check." before a tool call and again after it, or says the same thing twice). Text is held
 * back only until its sentence/line ends. Short pieces (under MIN_DEDUPE_CHARS letters) are never dropped.
 */
export class RepeatFilter {
  private seen = new Set<string>()
  private buf = ''
  private swallowSpace = false

  private take(unit: string): string {
    const key = sentenceKey(unit)
    if (key.length >= MIN_DEDUPE_CHARS) {
      if (this.seen.has(key)) {
        this.swallowSpace = true
        return ''
      }
      this.seen.add(key)
    }
    if (this.swallowSpace) {
      if (unit.trim() === '') return ''
      this.swallowSpace = false
    }
    return unit
  }

  push(delta: string): string {
    this.buf += delta
    let out = ''
    for (;;) {
      const m = /([.!?]+["')\]]*\s)|\n/.exec(this.buf)
      if (!m) break
      const end = m.index + m[0].length
      out += this.take(this.buf.slice(0, end))
      this.buf = this.buf.slice(end)
    }
    return out
  }

  /** The held-back tail (end of a model call). */
  flush(): string {
    const rest = this.buf
    this.buf = ''
    return rest === '' ? '' : this.take(rest)
  }

  /** Forget the held-back tail without sending it (a failed attempt that is about to be retried). */
  discard(): void {
    this.buf = ''
  }
}

export interface ChatTurnResult {
  finalText: string
  /** Model calls made this turn. */
  iterations: number
  /** Tool names in call order (names only, for the usage log). */
  toolsUsed: string[]
}

// --- Retry of a model call that failed before any content reached the client -------------------------
/** Retries after the first attempt. Worst case adds about 2 s of sleeping. */
export const MAX_CALL_RETRIES = 2
const RETRY_BACKOFF_MS = [500, 1500]
const MIN_RETRY_ATTEMPT_MS = 3_000
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Backoff before retry number attempt+1, or null when this failure is not worth a retry. Only overload/5xx ('busy') and network failures qualify; 4xx and 429 are final. */
export function retryDelayMs(err: unknown, attempt: number, rand: () => number = Math.random): number | null {
  if (attempt >= MAX_CALL_RETRIES) return null
  const transient = (err instanceof AiCallError && err.code === 'busy') || err instanceof TypeError
  if (!transient) return null
  const base = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]
  return Math.round(base * (0.75 + rand() * 0.5))
}

function addUsage(into: AnthropicUsage, add: AnthropicUsage): void {
  into.input_tokens += add.input_tokens
  into.output_tokens += add.output_tokens
  into.cache_creation_input_tokens = (into.cache_creation_input_tokens ?? 0) + (add.cache_creation_input_tokens ?? 0)
  into.cache_read_input_tokens = (into.cache_read_input_tokens ?? 0) + (add.cache_read_input_tokens ?? 0)
}

function overTurnCap(usage: AnthropicUsage, model: string): boolean {
  return usage.output_tokens >= MAX_TURN_OUTPUT_TOKENS || estimateCostUsd(usage, model) >= MAX_TURN_COST_USD
}

export async function runChatTurn(deps: ChatLoopDeps): Promise<ChatTurnResult> {
  const { conversation, send, usage } = deps
  /** Hands one call's usage to the caller; never throws (a logging problem must not break the answer). */
  const billCall = async (u: AnthropicUsage, model: string) => {
    if (!deps.onCallBilled) return
    if (u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) === 0) return
    try { await deps.onCallBilled({ ...u }, model) } catch { /* never mask the answer */ }
  }
  const midSystem = supportsMidConversationSystem(deps.model)
  let finalText = ''
  let iterations = 0
  const toolsUsed: string[] = []
  const linkTargets: string[] = []
  let nudged = false
  let nudgeIteration = -10
  const repeats = new RepeatFilter()
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
    // One model call, retried (see shouldRetryCall) only while nothing of it has reached the client.
    let turn!: Awaited<ReturnType<typeof consumeAnthropicStream>>
    let gaveUp = false
    for (let attempt = 0; ; attempt++) {
      let started = false // text of this call was sent to the client
      let received = false // the model sent any text delta in this attempt (it may still be held back by the repeat filter)
      const out = (t: string) => {
        if (t === '') return
        if (!started) {
          started = true
          if (finalText.trim()) emit('\n\n')
        }
        emit(t)
      }
      repeats.discard()
      const progress: StreamProgress = { usage: { ...ZERO_USAGE }, model: '' }
      try {
        const response = await deps.callModel({
          model: deps.model,
          max_tokens: CHAT_MAX_TOKENS,
          system: deps.system,
          messages,
          tools: last && !midSystem ? undefined : deps.tools,
          output_config: { effort: CHAT_EFFORT },
        })
        // Iterations after the first start a new paragraph so words never run together.
        turn = await consumeAnthropicStream(response, (delta) => { received = true; out(repeats.push(delta)) }, { throwOnStreamError: true, progress })
        out(repeats.flush())
        break
      } catch (rawErr) {
        const err = rawErr instanceof StreamEventError ? streamEventToAiError(rawErr) : rawErr
        // Bill the failed attempt before deciding: the caps below must see what it cost.
        addUsage(usage, progress.usage)
        if (progress.model) deps.state.model = progress.model
        await billCall(progress.usage, progress.model || deps.state.model || deps.model)
        progress.usage = { ...ZERO_USAGE }
        const delay = received ? null : retryDelayMs(err, attempt)
        if (delay === null || overTurnCap(usage, deps.state.model || deps.model) || (deps.deadlineAt != null && deps.deadlineAt - Date.now() < delay + MIN_RETRY_ATTEMPT_MS)) {
          out(repeats.flush()) // not retrying: the partial text the person was already reading is completed, not cut mid-sentence
          // The corrective continuation is a bonus: if IT fails, the person keeps the reply they already have.
          if (iteration === nudgeIteration + 1 && finalText.trim()) { gaveUp = true; break }
          throw err
        }
        repeats.discard()
        await (deps.sleep ?? defaultSleep)(delay)
        continue
      } finally {
        addUsage(usage, progress.usage)
        if (progress.model) deps.state.model = progress.model
        await billCall(progress.usage, progress.model || deps.state.model || deps.model)
      }
    }

    if (gaveUp) break

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
        if (tu.name === 'open_screen') linkTargets.push(String((tu.input as { target?: unknown } | null)?.target ?? ''))
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
    // A turn must not end with a button and no facts: one corrective continuation, inside the same caps.
    if (!notice && !nudged && !last && iteration + 1 < deps.maxIterations && turn.content.length > 0 && !overTurnCap(usage, deps.state.model || deps.model)
      && answerNudgeNeeded({ toolsUsed, linkTargets, text: finalText })) {
      nudged = true
      nudgeIteration = iteration
      conversation.push({ role: 'assistant', content: turn.content as AnthropicContentBlock[] })
      conversation.push(answerNudgeMessage(deps.model))
      continue
    }
    if (notice === NOTICE_CUT_SHORT && finalText.trim()) emit(` ${NOTICE_CUT_SHORT}`)
    else if (notice) emitNotice(notice)
    break
  }

  if (!finalText.trim()) emitNotice(NOTICE_EMPTY)
  return { finalText, iterations, toolsUsed }
}
