/**
 * Fetch-based Anthropic client wrapper for edge functions (plan §13
 * `_shared/` toolkit). Deno edge functions can't use the Node/npm Anthropic
 * SDK reliably in all cases, and the raw fetch surface is small enough that
 * hand-rolling it keeps full control over streaming + structured outputs.
 *
 * MODEL: claude-sonnet-5 (alias, no date suffix) for every AI feature in v2
 * (plan §13 "one model everywhere"). Do NOT send temperature/top_p/top_k
 * (rejected on Sonnet 5). No assistant prefill. Adaptive thinking is the
 * only "on" mode -- we do not enable thinking for these features (structured
 * extraction / tool use / short drafts don't need it); omit `thinking`
 * entirely rather than passing {type:"disabled"} unless a call site has a
 * specific reason to.
 */

export const CLAUDE_MODEL = 'claude-sonnet-5'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: { type: 'ephemeral' } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
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
}

export interface AnthropicRequestOptions {
  model?: string
  max_tokens: number
  system?: string | AnthropicContentBlock[]
  messages: AnthropicMessage[]
  tools?: AnthropicToolDef[]
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string }
  output_config?: {
    format?: { type: 'json_schema'; schema: Record<string, unknown>; name?: string }
    effort?: 'low' | 'medium' | 'high' | 'max'
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

function getApiKey(): string {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }
  return key
}

/** Non-streaming call. Returns the parsed response body. */
export async function createMessage(opts: AnthropicRequestOptions): Promise<AnthropicResponse> {
  const body = {
    model: opts.model ?? CLAUDE_MODEL,
    max_tokens: opts.max_tokens,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    ...(opts.output_config ? { output_config: opts.output_config } : {}),
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('[anthropic] API error:', response.status, errorText)
    throw new Error(`Claude API error (${response.status}): ${errorText}`)
  }

  return await response.json() as AnthropicResponse
}

/**
 * Streaming call. Returns the raw fetch Response (body is an SSE stream) --
 * callers pipe/parse it themselves (see trip-chat's SSE-forwarding loop).
 * Use `accumulateStreamUsage` / manual buffering to recover the final
 * message content + usage once the stream ends.
 */
export async function createMessageStream(opts: AnthropicRequestOptions): Promise<Response> {
  const body = {
    model: opts.model ?? CLAUDE_MODEL,
    max_tokens: opts.max_tokens,
    stream: true,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    ...(opts.output_config ? { output_config: opts.output_config } : {}),
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('[anthropic] Stream API error:', response.status, errorText)
    throw new Error(`Claude API error (${response.status}): ${errorText}`)
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
  toolUses: Array<{ id: string; name: string; input: unknown }>
  usage: AnthropicUsage
  stop_reason: string | null
  model: string
}

export async function consumeAnthropicStream(
  response: Response,
  onTextDelta?: (delta: string) => void
): Promise<StreamAccumulation> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let text = ''
  let model = ''
  let stop_reason: string | null = null
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }
  const toolUses: Array<{ id: string; name: string; input: unknown }> = []
  // Track in-progress tool_use blocks by content index, accumulating their
  // streamed partial_json until content_block_stop.
  const pendingToolUse = new Map<number, { id: string; name: string; jsonBuf: string }>()

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
          if (event.message?.usage) {
            usage.input_tokens = event.message.usage.input_tokens ?? 0
            usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens ?? 0
            usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0
          }
          break
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            pendingToolUse.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonBuf: '',
            })
          }
          break
        case 'content_block_delta':
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
              console.error('[anthropic] failed to parse tool_use input JSON:', pending.jsonBuf)
            }
            toolUses.push({ id: pending.id, name: pending.name, input })
            pendingToolUse.delete(event.index)
          }
          break
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stop_reason = event.delta.stop_reason
          if (event.usage?.output_tokens != null) usage.output_tokens = event.usage.output_tokens
          break
        default:
          break
      }
    }
  }

  return { text, toolUses, usage, stop_reason, model }
}

/**
 * Rough cost estimate in USD from token usage, using Sonnet 5 intro pricing
 * ($2/$10 per MTok through 2026-08-31, then $3/$15 -- plan §10/§13). Cache
 * reads are ~0.1x input price, cache writes ~1.25x (5-minute TTL default).
 * This is an estimate for the admin dashboard/circuit-breaker, not a billing
 * source of truth.
 */
const SONNET5_INTRO_CUTOFF = Date.UTC(2026, 7, 31, 23, 59, 59) // 2026-08-31 end of day UTC
const PRICES_INTRO = { input: 2, output: 10 } // USD per MTok
const PRICES_STANDARD = { input: 3, output: 15 }

export function estimateCostUsd(usage: AnthropicUsage, at: Date = new Date()): number {
  const prices = at.getTime() <= SONNET5_INTRO_CUTOFF ? PRICES_INTRO : PRICES_STANDARD
  const inputCost = (usage.input_tokens / 1_000_000) * prices.input
  const outputCost = (usage.output_tokens / 1_000_000) * prices.output
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * prices.input * 0.1
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * prices.input * 1.25
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

/**
 * Pads a static prefix with an invisible-to-behavior filler comment so it
 * clears the prompt-cache minimum cacheable prefix (2048 tokens on Sonnet 5;
 * see claude-api skill prompt-caching reference). Only pad if the real
 * content is likely under the minimum -- check token count if precision
 * matters; this is a cheap heuristic (approx 4 chars/token).
 */
export function padForCaching(staticPrefix: string, minTokens = 2048): string {
  const approxTokens = Math.ceil(staticPrefix.length / 4)
  if (approxTokens >= minTokens) return staticPrefix
  const paddingTokensNeeded = minTokens - approxTokens + 32 // small safety margin
  const filler =
    '\n\n<!-- cache-padding: this section intentionally verbose to satisfy the prompt-cache minimum ' +
    'prefix length; it is not part of the operative instructions above. -->\n' +
    '<!-- padding-filler '.repeat(Math.ceil(paddingTokensNeeded / 4)) + '-->'
  return staticPrefix + filler
}
