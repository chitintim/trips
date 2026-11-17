/**
 * Fetch-based Anthropic client wrapper for edge functions (plan §13
 * `_shared/` toolkit). Deno edge functions can't use the Node/npm Anthropic
 * SDK reliably in all cases, and the raw fetch surface is small enough that
 * hand-rolling it keeps full control over streaming + structured outputs.
 *
 * MODELS: one constant PER CALL, each overridable by an environment variable
 * (set it with `supabase secrets set`, no redeploy of code needed beyond a
 * function restart) so a model can be rolled back quickly:
 *
 *   parse-receipt   CLAUDE_MODEL_PARSE_RECEIPT   default claude-sonnet-5-5, effort low
 *   ingest          CLAUDE_MODEL_INGEST          default claude-sonnet-5-5, effort low
 *   nudge-draft     CLAUDE_MODEL_NUDGE_DRAFT     default claude-haiku-5-5,  effort low (text only)
 *   reorganize-plan CLAUDE_MODEL_REORGANIZE_PLAN default claude-sonnet-5-5, effort medium (streamed)
 *   trip-chat       TRIP_CHAT_MODEL              default claude-sonnet-5-5, effort low (streamed). Roll back with
 *                   `supabase secrets set TRIP_CHAT_MODEL=claude-sonnet-5` (no code deploy; trip-chat then skips the
 *                   mid-conversation system message, which Sonnet 5 does not support)
 *
 * Request rules (claude-api skill): never send temperature/top_p/top_k, no
 * assistant prefill, no `thinking: {type:'disabled'}` (400 on Sonnet 5.5),
 * no forced tool_choice (400 on Sonnet 5.5). `thinking` is omitted (adaptive
 * default) and depth is controlled with `output_config.effort`, which every
 * call sets explicitly (Haiku 5.5 defaults to `medium`, not `low`).
 * `anthropic-version` stays 2023-06-01. Server-side `fallbacks` is NOT used:
 * it only retries cyber/frontier_llm declines on Sonnet 5, is a beta, and
 * does not exist for Haiku 5.5; refusals are mapped to a coded error instead.
 *
 * Robustness (createMessage / createMessageStreamed): per-attempt timeout
 * plus an optional whole-call deadline, ONE retry with jittered backoff on
 * 429 / 529 / 5xx / network errors / timeouts (never on other 4xx; a longer
 * Retry-After is honoured as long as it fits inside the deadline),
 * `stop_reason` is checked before any content is used, and every failure is
 * an AiCallError with a stable `code`. A failure AFTER the API has charged
 * (max_tokens / refusal, or a stream that died after message_start) is a
 * BilledAiCallError carrying the usage, so callers can still write ai_usage.
 * Prompts, images, keys and model output are never logged.
 */
import { AiCallError } from './aiError.ts'
import { estimateCostUsd as estimateCostUsdForModel } from './pricing.ts'

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Accepts only plain Claude model ids from the environment (guards typos / injection). */
export function resolveModel(envValue: string | undefined | null, fallback: string): string {
  const v = (envValue ?? '').trim()
  return /^claude-[a-z0-9][a-z0-9.-]*$/.test(v) ? v : fallback
}

export function envModel(name: string, fallback: string, read: (name: string) => string | undefined = (n) => Deno.env.get(n)): string {
  let raw: string | undefined
  try {
    raw = read(name)
  } catch {
    raw = undefined // no env permission (unit tests) -> default
  }
  return resolveModel(raw, fallback)
}

export const DEFAULT_MODEL_EXTRACT = 'claude-sonnet-5-5'
export const DEFAULT_MODEL_FAST = 'claude-haiku-5-5'

export const MODEL_PARSE_RECEIPT = envModel('CLAUDE_MODEL_PARSE_RECEIPT', DEFAULT_MODEL_EXTRACT)
export const MODEL_INGEST = envModel('CLAUDE_MODEL_INGEST', DEFAULT_MODEL_EXTRACT)
export const MODEL_NUDGE_DRAFT = envModel('CLAUDE_MODEL_NUDGE_DRAFT', DEFAULT_MODEL_FAST)
export const MODEL_REORGANIZE_PLAN = envModel('CLAUDE_MODEL_REORGANIZE_PLAN', DEFAULT_MODEL_EXTRACT)
export const DEFAULT_MODEL_TRIP_CHAT = 'claude-sonnet-5-5'
export const MODEL_TRIP_CHAT = envModel('TRIP_CHAT_MODEL', DEFAULT_MODEL_TRIP_CHAT)

/**
 * Mid-conversation `role: "system"` messages: supported on Sonnet 5.5, Haiku 5.5,
 * Opus 4.8 / 5 / 5.5, Fable and Mythos; NOT on Sonnet 5 (400). trip-chat uses
 * this to decide whether it may send its last-turn instruction that way.
 */
export function supportsMidConversationSystem(model: string): boolean {
  return /^claude-(sonnet-5-[5-9]|haiku-5-[5-9]|opus-5(-\d+)?|opus-4-8|fable-.+|mythos-.+)$/.test(model)
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: { type: 'ephemeral' } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // Thinking blocks must be replayed to the API exactly as received (signature included).
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: { type: 'ephemeral' } }

export interface AnthropicMessage {
  // 'system' = a mid-conversation operator message (Sonnet 5.5 and later only).
  role: 'user' | 'assistant' | 'system'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface JsonSchemaFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
  name?: string
}

/** Transport controls; never part of the request body. */
export interface CallControl {
  /** Overrides ANTHROPIC_API_KEY (tests, local eval). */
  apiKey?: string
  /** Per-attempt timeout. Default 60s (createMessageStreamed: 120s). */
  timeoutMs?: number
  /** Absolute epoch-ms budget for the whole call including the retry. */
  deadlineAt?: number
  /** Retries after the first attempt, on retryable failures only. Default 1. */
  maxRetries?: number
  /** Test seam for the backoff sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface AnthropicRequestOptions extends CallControl {
  model?: string
  max_tokens: number
  system?: string | AnthropicContentBlock[]
  messages: AnthropicMessage[]
  tools?: AnthropicToolDef[]
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string }
  output_config?: {
    format?: JsonSchemaFormat
    effort?: ClaudeEffort
  }
  stream?: boolean
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AnthropicResponse {
  id: string
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string | null
  stop_details?: { type: string; category?: string | null; explanation?: string } | null
  usage: AnthropicUsage
}

/**
 * An AiCallError for a call the API (probably) charged for. `usage` is what is
 * known from the response (zeros when a timeout hid it); `usageKnown` says
 * which. `modelMayHaveBilled(err)` is the refund rule: keep the user's daily
 * token once any model call has run.
 */
export class BilledAiCallError extends AiCallError {
  usage: AnthropicUsage
  usageKnown: boolean
  model: string
  constructor(base: AiCallError, usage: AnthropicUsage, model: string, usageKnown = true) {
    super(base.code, base.detail, base.message, base.status)
    this.usage = usage
    this.usageKnown = usageKnown
    this.model = model
  }
}

export const ZERO_USAGE: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }

export function sumUsage(a: AnthropicUsage, b: AnthropicUsage): AnthropicUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  }
}

function hasTokens(u: AnthropicUsage): boolean {
  return u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) > 0
}

/** Usage to write to ai_usage for a failed call, or null when nothing is known to have been charged. */
export function billedUsageOf(err: unknown): { usage: AnthropicUsage; model: string } | null {
  if (err instanceof BilledAiCallError && err.usageKnown && hasTokens(err.usage)) return { usage: err.usage, model: err.model }
  return null
}

/** True when the failure happened after the model may have run (known usage, or a timeout that hid it). */
export function modelMayHaveBilled(err: unknown): boolean {
  return err instanceof BilledAiCallError
}

function getApiKey(override?: string): string {
  const key = override ?? Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) {
    throw new AiCallError('unknown', 'ANTHROPIC_API_KEY not configured', undefined, 500)
  }
  return key
}

/**
 * Builds the JSON request body. Pure: the eval script and the functions share
 * it, so the eval exercises the real request shape. Transport controls
 * (CallControl) are never included.
 */
export function buildMessageBody(opts: AnthropicRequestOptions, model: string, stream = false): Record<string, unknown> {
  return {
    model,
    max_tokens: opts.max_tokens,
    ...(stream ? { stream: true } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    ...(opts.output_config ? { output_config: opts.output_config } : {}),
  }
}

// ---------------------------------------------------------------------------
// Errors, retry policy, stop reasons
// ---------------------------------------------------------------------------

const MIN_ATTEMPT_MS = 3_000
/** Longest Retry-After we will sleep when the caller gave no deadline (with a deadline, only the deadline limits it). */
const MAX_RETRY_AFTER_NO_DEADLINE_MS = 30_000
const TOO_LARGE_API_MESSAGE = 'This file is too large to scan (the photo is too big, or the PDF has too many pages). Try a smaller photo, a screenshot, or a shorter PDF.'

/** Internal: a failure worth one retry. Becomes an AiCallError if retries run out. */
class RetryableFailure extends Error {
  final: AiCallError
  retryAfterMs: number | null
  constructor(final: AiCallError, retryAfterMs: number | null = null) {
    super(final.detail ?? final.code)
    this.final = final
    this.retryAfterMs = retryAfterMs
  }
}

function isTimeoutError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/** Maps a non-OK HTTP status to either a retryable failure or a final AiCallError. */
export function classifyHttpFailure(status: number, errType: string | null, errMessage: string | null, retryAfterSec: number | null): RetryableFailure | AiCallError {
  const detail = `http ${status}${errType ? ` ${errType}` : ''}`
  const retryAfterMs = retryAfterSec != null && retryAfterSec >= 0 ? retryAfterSec * 1000 : null
  if (status === 429) return new RetryableFailure(new AiCallError('rate_limited', detail, 'The scanner is busy right now. Please try again in a minute.'), retryAfterMs)
  if (status === 529 || status >= 500) return new RetryableFailure(new AiCallError('busy', detail), retryAfterMs)
  if (status === 413) return new AiCallError('too_large', detail, TOO_LARGE_API_MESSAGE)
  if (status === 400 && errMessage && /image|pdf|document|media type|base64/i.test(errMessage)) {
    // "image exceeds 5 MB maximum", "maximum of 100 PDF pages", "too large": the file is the
    // problem and a clearer photo will not help, so say "too large", not "unreadable".
    if (/exceed|too large|too big|too many|maximum|larger than|more than/i.test(errMessage)) {
      return new AiCallError('too_large', detail, TOO_LARGE_API_MESSAGE)
    }
    return new AiCallError('unreadable', detail)
  }
  return new AiCallError('unknown', detail)
}

async function readHttpFailure(response: Response): Promise<RetryableFailure | AiCallError> {
  let errType: string | null = null
  let errMessage: string | null = null
  try {
    const parsed = JSON.parse(await response.text())
    errType = typeof parsed?.error?.type === 'string' ? parsed.error.type : null
    errMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : null
  } catch {
    // body unreadable: classify on status alone
  }
  const ra = Number(response.headers.get('retry-after'))
  // Log status + error type only: never bodies, prompts or keys.
  console.error('[anthropic] API error:', response.status, errType ?? '', response.headers.get('request-id') ?? '')
  return classifyHttpFailure(response.status, errType, errMessage, Number.isFinite(ra) && response.headers.get('retry-after') !== null ? ra : null)
}

/** Accumulates what failed attempts of ONE call are known to have been charged. */
class UsageTally {
  usage: AnthropicUsage = { ...ZERO_USAGE }
  timedOut = false
  model = ''
  add(u: AnthropicUsage, model?: string) {
    this.usage = sumUsage(this.usage, u)
    if (model) this.model = model
  }
  noteTimeout() {
    this.timedOut = true
  }
  /** Converts a final failure into a BilledAiCallError when anything may have been charged. */
  wrap(err: unknown, fallbackModel: string): unknown {
    if (!(err instanceof AiCallError) || err instanceof BilledAiCallError) return err
    if (hasTokens(this.usage)) return new BilledAiCallError(err, this.usage, this.model || fallbackModel)
    if (this.timedOut) return new BilledAiCallError(err, this.usage, this.model || fallbackModel, false)
    return err
  }
}

/** Throws a coded error unless the model finished normally (end_turn / tool_use). */
export function assertUsableStopReason(resp: { stop_reason: string | null; stop_details?: AnthropicResponse['stop_details'] }): void {
  const sr = resp.stop_reason
  if (sr === 'end_turn' || sr === 'tool_use') return
  if (sr === 'refusal') {
    console.error('[anthropic] refusal', resp.stop_details?.category ?? 'uncategorised')
    throw new AiCallError('refused', `refusal ${resp.stop_details?.category ?? ''}`.trim())
  }
  if (sr === 'max_tokens') throw new AiCallError('unreadable', 'max_tokens: output was cut off')
  throw new AiCallError('unknown', `unexpected stop_reason ${String(sr)}`)
}

/** The first `text` block's text; coded 'unreadable' if the model returned none. */
export function extractText(resp: Pick<AnthropicResponse, 'content'>): string {
  const block = resp.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  if (!block?.text) throw new AiCallError('unreadable', 'no text block in response')
  return block.text
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Runs `attempt` with a per-attempt timeout signal and the retry policy:
 * `maxRetries` (default 1) more tries on RetryableFailure, 1-2 s jittered
 * backoff (or Retry-After, capped at 5 s), never past `deadlineAt`.
 */
async function withRetry<T>(opts: CallControl, defaultTimeoutMs: number, attempt: (signal: AbortSignal) => Promise<T>, tally?: UsageTally): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1
  const sleep = opts.sleep ?? defaultSleep
  for (let n = 0; ; n++) {
    const remaining = opts.deadlineAt != null ? opts.deadlineAt - Date.now() : Infinity
    if (remaining < MIN_ATTEMPT_MS) throw new AiCallError('busy', 'deadline exhausted', undefined, 504)
    const timeout = Math.min(opts.timeoutMs ?? defaultTimeoutMs, remaining)
    try {
      return await attempt(AbortSignal.timeout(timeout))
    } catch (err) {
      let failure: RetryableFailure | null = null
      if (err instanceof RetryableFailure) failure = err
      else if (err instanceof AiCallError) throw err
      else if (isTimeoutError(err)) {
        // The request reached the API; the model may have run (and been charged) before we gave up.
        tally?.noteTimeout()
        failure = new RetryableFailure(new AiCallError('busy', `timeout after ${timeout}ms`, undefined, 504))
      }
      else if (err instanceof TypeError) failure = new RetryableFailure(new AiCallError('busy', 'network error', undefined, 503))
      else throw new AiCallError('unknown', err instanceof Error ? err.name : 'error')

      if (n >= maxRetries) throw failure.final
      // Honour a longer Retry-After (a retry sooner just hits another 429); fail fast only
      // when waiting it out would blow the caller's deadline. No deadline: cap the sleep.
      const asked = failure.retryAfterMs ?? 0
      const backoff = Math.max(1000 + Math.random() * 1000, opts.deadlineAt != null ? asked : Math.min(asked, MAX_RETRY_AFTER_NO_DEADLINE_MS))
      const left = opts.deadlineAt != null ? opts.deadlineAt - Date.now() : Infinity
      if (left < backoff + MIN_ATTEMPT_MS) throw failure.final
      await sleep(backoff)
    }
  }
}

function postHeaders(opts: CallControl): Record<string, string> {
  return {
    'x-api-key': getApiKey(opts.apiKey),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Non-streaming call. Returns the parsed response body; throws AiCallError (BilledAiCallError once charged). */
export async function createMessage(opts: AnthropicRequestOptions): Promise<AnthropicResponse> {
  const model = opts.model ?? MODEL_PARSE_RECEIPT
  const body = JSON.stringify(buildMessageBody(opts, model))
  const headers = postHeaders(opts)
  const tally = new UsageTally()
  let resp: AnthropicResponse
  try {
    resp = await withRetry(opts, 60_000, async (signal) => {
      const response = await fetch(ANTHROPIC_API_URL, { method: 'POST', headers, body, signal })
      if (!response.ok) throw await readHttpFailure(response)
      return await response.json() as AnthropicResponse
    }, tally)
  } catch (err) {
    throw tally.wrap(err, model)
  }
  try {
    assertUsableStopReason(resp)
  } catch (err) {
    // The API charged for this response even though we cannot use it.
    tally.add(resp.usage, resp.model || model)
    throw tally.wrap(err, model)
  }
  return resp
}

/**
 * Non-streaming-shaped call that streams under the hood (long outputs: keeps
 * the connection alive and avoids one huge buffered response). Returns a
 * synthetic AnthropicResponse whose single `text` block holds the full text.
 * A failure mid-stream (timeout, overloaded_error event) is retried once from
 * scratch; partial output is discarded, but the input tokens reported by
 * message_start are kept in the usage (the API charges for them).
 */
export async function createMessageStreamed(opts: AnthropicRequestOptions): Promise<AnthropicResponse> {
  const model = opts.model ?? MODEL_REORGANIZE_PLAN
  const body = JSON.stringify(buildMessageBody(opts, model, true))
  const headers = postHeaders(opts)
  const tally = new UsageTally()
  let resp: AnthropicResponse
  try {
    resp = await withRetry(opts, 120_000, async (signal) => {
      const response = await fetch(ANTHROPIC_API_URL, { method: 'POST', headers, body, signal })
      if (!response.ok) throw await readHttpFailure(response)
      const partial: StreamProgress = { usage: { ...ZERO_USAGE }, model: '' }
      let acc: StreamAccumulation
      try {
        acc = await consumeAnthropicStream(response, undefined, { throwOnStreamError: true, progress: partial })
      } catch (err) {
        // The stream died after the API started (and charged for) this attempt.
        tally.add(partial.usage, partial.model || undefined)
        if (err instanceof StreamEventError) {
          const retryable = err.eventType === 'overloaded_error' || err.eventType === 'api_error'
          const coded = new AiCallError(retryable ? 'busy' : 'unknown', `stream error ${err.eventType}`)
          throw retryable ? new RetryableFailure(coded) : coded
        }
        throw err // timeout / network handled by withRetry
      }
      return {
        id: '',
        model: acc.model,
        content: [{ type: 'text', text: acc.text }],
        stop_reason: acc.stop_reason,
        usage: acc.usage,
      } as AnthropicResponse
    }, tally)
  } catch (err) {
    throw tally.wrap(err, model)
  }
  try {
    assertUsableStopReason(resp)
  } catch (err) {
    tally.add(resp.usage, resp.model || model)
    throw tally.wrap(err, model)
  }
  // A retry after a dead stream: the earlier attempt's input was charged too.
  if (hasTokens(tally.usage)) resp = { ...resp, usage: sumUsage(resp.usage, tally.usage) }
  return resp
}

/**
 * Streaming call. Returns the raw fetch Response (body is an SSE stream) --
 * callers pipe/parse it themselves (see trip-chat's SSE-forwarding loop).
 * Use `accumulateStreamUsage` / manual buffering to recover the final
 * message content + usage once the stream ends. (Used by trip-chat; behaviour
 * unchanged apart from not logging response bodies.)
 */
export async function createMessageStream(opts: AnthropicRequestOptions): Promise<Response> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: postHeaders(opts),
    body: JSON.stringify(buildMessageBody(opts, opts.model ?? MODEL_TRIP_CHAT, true)),
    // Generous stream deadline: aborts the whole SSE stream if the model
    // stalls, before the edge runtime's worker limit does it uncleanly.
    signal: AbortSignal.timeout(120_000),
  })

  if (!response.ok) {
    // Status only: the upstream body is neither logged nor passed on (it can echo request
    // content and is not for end users). Callers get a coded, user-safe AiCallError.
    await response.body?.cancel().catch(() => {})
    console.error('[anthropic] Stream API error:', response.status)
    const ra = Number(response.headers.get('retry-after'))
    const c = classifyHttpFailure(response.status, null, null, Number.isFinite(ra) && response.headers.get('retry-after') !== null ? ra : null)
    throw c instanceof RetryableFailure ? c.final : c
  }

  return response
}

/**
 * Parses a raw Anthropic SSE stream (already ok) into: a per-delta callback
 * for text tokens, and a final accumulated result (content blocks + usage +
 * stop_reason) once the stream ends. This is a *shared* SSE parser so
 * trip-chat doesn't hand-roll its own parsing loop.
 */
export interface StreamAccumulation {
  text: string
  /** Every content block in stream order (thinking, redacted_thinking, text, tool_use, ...), ready to replay. */
  content: AnthropicContentBlock[]
  toolUses: Array<{ id: string; name: string; input: unknown }>
  usage: AnthropicUsage
  stop_reason: string | null
  model: string
}

export class StreamEventError extends Error {
  eventType: string
  constructor(eventType: string) {
    super(`stream error event: ${eventType}`)
    this.eventType = eventType
  }
}

/** Live view of a stream's usage so a failed attempt can still report what was charged. */
export interface StreamProgress {
  usage: AnthropicUsage
  model: string
}

export async function consumeAnthropicStream(
  response: Response,
  onTextDelta?: (delta: string) => void,
  options: { throwOnStreamError?: boolean; progress?: StreamProgress } = {}
): Promise<StreamAccumulation> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let text = ''
  let model = ''
  let stop_reason: string | null = null
  const usage: AnthropicUsage = options.progress?.usage ?? { input_tokens: 0, output_tokens: 0 }
  const toolUses: Array<{ id: string; name: string; input: unknown }> = []
  // Track in-progress tool_use blocks by content index, accumulating their
  // streamed partial_json until content_block_stop.
  const pendingToolUse = new Map<number, { id: string; name: string; jsonBuf: string }>()
  // All blocks by stream index, kept in order so a tool-loop turn can be replayed unchanged.
  const blocks = new Map<number, Record<string, unknown>>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue

      let event: any
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }

      switch (event.type) {
        case 'message_start':
          model = event.message?.model ?? model
          if (options.progress) options.progress.model = model
          if (event.message?.usage) {
            usage.input_tokens = event.message.usage.input_tokens ?? 0
            usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens ?? 0
            usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0
          }
          break
        case 'content_block_start':
          if (event.content_block && typeof event.index === 'number') {
            const b = { ...event.content_block } as Record<string, unknown>
            if (b.type === 'text' && typeof b.text !== 'string') b.text = ''
            if (b.type === 'thinking' && typeof b.thinking !== 'string') b.thinking = ''
            blocks.set(event.index, b)
          }
          if (event.content_block?.type === 'tool_use') {
            pendingToolUse.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonBuf: '',
            })
          }
          break
        case 'content_block_delta':
          {
            const b = blocks.get(event.index)
            if (b) {
              if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') b.text = String(b.text ?? '') + event.delta.text
              else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') b.thinking = String(b.thinking ?? '') + event.delta.thinking
              else if (event.delta?.type === 'signature_delta' && typeof event.delta.signature === 'string') b.signature = String(b.signature ?? '') + event.delta.signature
            }
          }
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            text += event.delta.text
            onTextDelta?.(event.delta.text)
          } else if (event.delta?.type === 'input_json_delta') {
            const pending = pendingToolUse.get(event.index)
            if (pending) pending.jsonBuf += event.delta.partial_json ?? ''
          }
          break
        case 'content_block_stop': {
          const pending = pendingToolUse.get(event.index)
          if (pending) {
            let input: unknown = {}
            try {
              input = pending.jsonBuf ? JSON.parse(pending.jsonBuf) : {}
            } catch {
              console.error('[anthropic] failed to parse tool_use input JSON (length', pending.jsonBuf.length, ')')
            }
            toolUses.push({ id: pending.id, name: pending.name, input })
            const tb = blocks.get(event.index)
            if (tb) tb.input = input
            pendingToolUse.delete(event.index)
          }
          break
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stop_reason = event.delta.stop_reason
          if (event.usage?.output_tokens != null) usage.output_tokens = event.usage.output_tokens
          break
        case 'error':
          if (options.throwOnStreamError) throw new StreamEventError(event.error?.type ?? 'unknown')
          break
        default:
          break
      }
    }
  }

  const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b as unknown as AnthropicContentBlock)
  return { text, content, toolUses, usage, stop_reason, model }
}

/** Cost estimate in USD for one call's usage on `model` (per-model price table in pricing.ts). */
export const estimateCostUsd = estimateCostUsdForModel
