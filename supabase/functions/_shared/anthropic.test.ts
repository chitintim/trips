import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  assertUsableStopReason,
  BilledAiCallError,
  billedUsageOf,
  modelMayHaveBilled,
  createMessageStream,
  buildMessageBody,
  CLAUDE_MODEL,
  createMessage,
  createMessageStreamed,
  extractText,
  MODEL_INGEST,
  MODEL_NUDGE_DRAFT,
  MODEL_PARSE_RECEIPT,
  MODEL_REORGANIZE_PLAN,
  MODEL_TRIP_CHAT,
  resolveModel,
  type AnthropicResponse,
} from './anthropic.ts'
import { AiCallError } from './aiError.ts'
import { MODEL_PRICES, priceEntryFor } from './pricing.ts'

// --- helpers ---------------------------------------------------------------

type Step = Response | Error
function mockFetch(steps: Step[]) {
  const original = globalThis.fetch
  const originalError = console.error
  const logged: string[] = []
  const calls: { url: string; init: RequestInit }[] = []
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = steps.shift()
    if (!next) throw new Error('unexpected extra fetch')
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }) as typeof fetch
  return {
    calls,
    logged,
    restore() {
      globalThis.fetch = original
      console.error = originalError
    },
  }
}

const OK_BODY: AnthropicResponse = {
  id: 'msg_1',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: '{"ok":true}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const apiError = (status: number, type: string, message = 'x', headers: Record<string, string> = {}) =>
  json({ type: 'error', error: { type, message } }, status, headers)

function opts(extra: Record<string, unknown> = {}) {
  const slept: number[] = []
  return {
    slept,
    o: {
      apiKey: 'sk-test-key',
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'SECRET PROMPT TEXT' }],
      sleep: (ms: number) => { slept.push(ms); return Promise.resolve() },
      ...extra,
    },
  }
}

async function codeOf(p: Promise<unknown>): Promise<AiCallError> {
  return await assertRejects(() => p, AiCallError)
}

// --- model constants -------------------------------------------------------

Deno.test('every per-call model constant resolves to a priced Claude id', () => {
  for (const m of [MODEL_PARSE_RECEIPT, MODEL_INGEST, MODEL_NUDGE_DRAFT, MODEL_REORGANIZE_PLAN, MODEL_TRIP_CHAT]) {
    assert(/^claude-[a-z0-9.-]+$/.test(m), m)
    assert(priceEntryFor(m).known, `no price for ${m}`)
    assert(m in MODEL_PRICES, `price table key missing for ${m}`)
  }
})

Deno.test('defaults: receipts and ingest on Sonnet 5.5, nudges on Haiku 5.5, plan on Sonnet 5.5', () => {
  // Env overrides are not readable under the default test permissions, so these are the defaults.
  assertEquals(MODEL_PARSE_RECEIPT, 'claude-sonnet-5-5')
  assertEquals(MODEL_INGEST, 'claude-sonnet-5-5')
  assertEquals(MODEL_NUDGE_DRAFT, 'claude-haiku-5-5')
  assertEquals(MODEL_REORGANIZE_PLAN, 'claude-sonnet-5-5')
})

Deno.test('trip-chat model is pinned and unchanged (claude-sonnet-5)', () => {
  assertEquals(MODEL_TRIP_CHAT, 'claude-sonnet-5')
  assertEquals(CLAUDE_MODEL, 'claude-sonnet-5')
})

Deno.test('resolveModel only accepts plain claude ids from the environment', () => {
  assertEquals(resolveModel('claude-haiku-5-5', 'x'), 'claude-haiku-5-5')
  assertEquals(resolveModel(' claude-sonnet-5 ', 'x'), 'claude-sonnet-5')
  assertEquals(resolveModel('', 'fallback'), 'fallback')
  assertEquals(resolveModel(undefined, 'fallback'), 'fallback')
  assertEquals(resolveModel('gpt-5', 'fallback'), 'fallback')
  assertEquals(resolveModel('claude-sonnet-5; drop', 'fallback'), 'fallback')
})

// --- request body ----------------------------------------------------------

Deno.test('buildMessageBody: effort and format pass through, transport controls and forbidden params never appear', () => {
  const body = buildMessageBody(
    { max_tokens: 50, apiKey: 'k', timeoutMs: 5, deadlineAt: 1, messages: [], output_config: { effort: 'low' } },
    'claude-haiku-5-5',
  )
  assertEquals(body.model, 'claude-haiku-5-5')
  assertEquals(body.output_config, { effort: 'low' })
  for (const k of ['apiKey', 'timeoutMs', 'deadlineAt', 'temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'stream']) {
    assert(!(k in body), k)
  }
})

// --- stop reasons ----------------------------------------------------------

Deno.test('stop_reason is checked before the content is used', async () => {
  for (const [stop, code] of [['refusal', 'refused'], ['max_tokens', 'unreadable'], ['pause_turn', 'unknown'], [null, 'unknown']] as const) {
    const m = mockFetch([json({ ...OK_BODY, stop_reason: stop, stop_details: stop === 'refusal' ? { type: 'refusal', category: 'general_harms' } : null })])
    try {
      const err = await codeOf(createMessage(opts().o))
      assertEquals(err.code, code, String(stop))
      assertEquals(err.status, code === 'unknown' ? 502 : 422)
    } finally { m.restore() }
  }
  assertUsableStopReason({ stop_reason: 'end_turn' })
  assertUsableStopReason({ stop_reason: 'tool_use' })
})

Deno.test('extractText: first text block, or coded unreadable', async () => {
  assertEquals(extractText(OK_BODY), '{"ok":true}')
  const err = await assertRejects(async () => extractText({ content: [] }), AiCallError)
  assertEquals(err.code, 'unreadable')
})

// --- success path ----------------------------------------------------------

Deno.test('createMessage: one POST with the key and version headers, returns the body', async () => {
  const m = mockFetch([json(OK_BODY)])
  try {
    const { o } = opts({ model: 'claude-sonnet-5-5' })
    const resp = await createMessage(o)
    assertEquals(resp.content[0], OK_BODY.content[0])
    assertEquals(m.calls.length, 1)
    const h = m.calls[0].init.headers as Record<string, string>
    assertEquals(h['x-api-key'], 'sk-test-key')
    assertEquals(h['anthropic-version'], '2023-06-01')
    assert(m.calls[0].init.signal)
  } finally { m.restore() }
})

// --- retry policy ----------------------------------------------------------

Deno.test('429 then success: exactly one retry after a 1-2 s backoff', async () => {
  const m = mockFetch([apiError(429, 'rate_limit_error'), json(OK_BODY)])
  try {
    const { o, slept } = opts()
    await createMessage(o)
    assertEquals(m.calls.length, 2)
    assertEquals(slept.length, 1)
    assert(slept[0] >= 1000 && slept[0] <= 2000, String(slept[0]))
  } finally { m.restore() }
})

Deno.test('Retry-After longer than 5 s is honoured when it fits the deadline, else fail fast', async () => {
  let m = mockFetch([apiError(429, 'rate_limit_error', 'x', { 'retry-after': '20' }), json(OK_BODY)])
  try {
    const { o, slept } = opts({ deadlineAt: Date.now() + 60_000 })
    await createMessage(o)
    assertEquals(slept[0], 20_000)
  } finally { m.restore() }
  m = mockFetch([apiError(429, 'rate_limit_error', 'x', { 'retry-after': '20' })])
  try {
    const { o, slept } = opts({ deadlineAt: Date.now() + 10_000 })
    const err = await codeOf(createMessage(o))
    assertEquals([err.code, m.calls.length, slept.length], ['rate_limited', 1, 0])
  } finally { m.restore() }
})

Deno.test('Retry-After is honoured', async () => {
  const m = mockFetch([apiError(429, 'rate_limit_error', 'x', { 'retry-after': '4' }), json(OK_BODY)])
  try {
    const { o, slept } = opts()
    await createMessage(o)
    assertEquals(slept[0], 4000)
  } finally { m.restore() }
})

Deno.test('429 twice -> rate_limited (429); 529 twice -> busy (503); 500 then ok succeeds', async () => {
  let m = mockFetch([apiError(429, 'rate_limit_error'), apiError(429, 'rate_limit_error')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([err.code, err.status, m.calls.length], ['rate_limited', 429, 2])
  } finally { m.restore() }

  m = mockFetch([apiError(529, 'overloaded_error'), apiError(529, 'overloaded_error')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([err.code, err.status, m.calls.length], ['busy', 503, 2])
  } finally { m.restore() }

  m = mockFetch([apiError(500, 'api_error'), json(OK_BODY)])
  try {
    await createMessage(opts().o)
    assertEquals(m.calls.length, 2)
  } finally { m.restore() }
})

Deno.test('other 4xx are never retried', async () => {
  for (const [status, code] of [[400, 'unknown'], [401, 'unknown'], [403, 'unknown'], [404, 'unknown'], [413, 'too_large']] as const) {
    const m = mockFetch([apiError(status, 'invalid_request_error', 'bad request')])
    try {
      const err = await codeOf(createMessage(opts().o))
      assertEquals([err.code, m.calls.length], [code, 1], String(status))
    } finally { m.restore() }
  }
})

Deno.test('400 about an unreadable image/PDF is the coded unreadable', async () => {
  const m = mockFetch([apiError(400, 'invalid_request_error', 'Could not process image')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([err.code, err.status], ['unreadable', 422])
  } finally { m.restore() }
})

Deno.test('400 "image exceeds ... maximum" / too many PDF pages is too_large, not unreadable', async () => {
  for (const msg of ['messages.0.content.0.image.source.base64: image exceeds 5 MB maximum', 'A maximum of 100 PDF pages may be provided', 'document is too large']) {
    const m = mockFetch([apiError(400, 'invalid_request_error', msg)])
    try {
      const err = await codeOf(createMessage(opts().o))
      assertEquals([err.code, err.status], ['too_large', 413], msg)
      assertStringIncludes(err.message, 'too large')
    } finally { m.restore() }
  }
  const m = mockFetch([apiError(413, 'request_too_large')])
  try {
    assertEquals((await codeOf(createMessage(opts().o))).code, 'too_large')
  } finally { m.restore() }
})

Deno.test('charged-then-failed calls carry usage: max_tokens, refusal; plain API errors do not', async () => {
  for (const stop of ['max_tokens', 'refusal']) {
    const m = mockFetch([json({ ...OK_BODY, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200 } })])
    try {
      const err = await codeOf(createMessage(opts().o))
      assert(err instanceof BilledAiCallError)
      assertEquals(billedUsageOf(err), { usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model: 'claude-sonnet-5-5' })
      assert(modelMayHaveBilled(err))
    } finally { m.restore() }
  }
  const m = mockFetch([apiError(400, 'invalid_request_error', 'bad')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([billedUsageOf(err), modelMayHaveBilled(err)], [null, false])
  } finally { m.restore() }
})

Deno.test('timeouts: usage unknown but the model may have billed (kept token); streamed death keeps message_start input tokens', async () => {
  let m = mockFetch([new DOMException('t', 'TimeoutError'), new DOMException('t', 'TimeoutError')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([modelMayHaveBilled(err), billedUsageOf(err)], [true, null])
  } finally { m.restore() }

  const dead = () => sse([{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 700 } } }, { type: 'error', error: { type: 'overloaded_error' } }])
  m = mockFetch([dead(), dead()])
  try {
    const err = await codeOf(createMessageStreamed(opts().o))
    assertEquals(err.code, 'busy')
    assertEquals(billedUsageOf(err)?.usage.input_tokens, 1400) // both attempts were charged for their input
  } finally { m.restore() }

  m = mockFetch([dead(), streamOk()])
  try {
    const resp = await createMessageStreamed(opts().o)
    assertEquals(resp.usage.input_tokens, 707) // 700 from the dead attempt + 7
  } finally { m.restore() }
})

Deno.test('createMessageStream: upstream error body never reaches the thrown error', async () => {
  const m = mockFetch([new Response('{"error":{"message":"SECRET PROMPT TEXT echoed"}}', { status: 400 })])
  try {
    const err = await assertRejects(() => createMessageStream(opts().o), AiCallError)
    assert(!JSON.stringify([err.message, err.detail]).includes('SECRET'))
    assert(!m.logged.join(' ').includes('SECRET'))
  } finally { m.restore() }
})

Deno.test('network error and timeout are retried once, then coded busy', async () => {
  let m = mockFetch([new TypeError('connection reset'), json(OK_BODY)])
  try {
    await createMessage(opts().o)
    assertEquals(m.calls.length, 2)
  } finally { m.restore() }

  m = mockFetch([new TypeError('down'), new TypeError('down')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([err.code, err.status, m.calls.length], ['busy', 503, 2])
  } finally { m.restore() }

  m = mockFetch([new DOMException('t', 'TimeoutError'), new DOMException('t', 'TimeoutError')])
  try {
    const err = await codeOf(createMessage(opts().o))
    assertEquals([err.code, err.status, m.calls.length], ['busy', 504, 2])
  } finally { m.restore() }
})

Deno.test('deadline: no attempt starts with less than 3 s left, and no retry is scheduled past it', async () => {
  let m = mockFetch([])
  try {
    const err = await codeOf(createMessage(opts({ deadlineAt: Date.now() + 1000 }).o))
    assertEquals([err.code, m.calls.length], ['busy', 0])
  } finally { m.restore() }

  m = mockFetch([apiError(529, 'overloaded_error')])
  try {
    const { o, slept } = opts({ deadlineAt: Date.now() + 4000 })
    const err = await codeOf(createMessage(o))
    assertEquals([err.code, m.calls.length, slept.length], ['busy', 1, 0])
  } finally { m.restore() }
})

Deno.test('maxRetries: 0 disables the retry', async () => {
  const m = mockFetch([apiError(529, 'overloaded_error')])
  try {
    const err = await codeOf(createMessage(opts({ maxRetries: 0 }).o))
    assertEquals([err.code, m.calls.length], ['busy', 1])
  } finally { m.restore() }
})

Deno.test('never logs prompts, keys or response bodies', async () => {
  const m = mockFetch([apiError(500, 'api_error', 'SECRET PROMPT TEXT leaked in error'), apiError(400, 'invalid_request_error', 'sk-test-key SECRET PROMPT TEXT')])
  try {
    await codeOf(createMessage(opts().o))
    const all = m.logged.join('\n')
    assert(!all.includes('SECRET PROMPT TEXT'))
    assert(!all.includes('sk-test-key'))
    assertStringIncludes(all, '500')
  } finally { m.restore() }
})

Deno.test('missing API key is a coded error, not a leak', async () => {
  const m = mockFetch([])
  try {
    const { o } = opts({ apiKey: '' })
    const err = await codeOf(createMessage(o))
    assertEquals(err.code, 'unknown')
    assertEquals(m.calls.length, 0)
  } finally { m.restore() }
})

// --- streamed variant ------------------------------------------------------

function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const streamOk = (stop = 'end_turn') => sse([
  { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 7, cache_read_input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"actions"' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ':[]}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 11 } },
  { type: 'message_stop' },
])

Deno.test('createMessageStreamed assembles text, usage and model; sends stream:true', async () => {
  const m = mockFetch([streamOk()])
  try {
    const resp = await createMessageStreamed(opts().o)
    assertEquals(extractText(resp), '{"actions":[]}')
    assertEquals(resp.usage.output_tokens, 11)
    assertEquals(resp.usage.input_tokens, 7)
    assertEquals(resp.model, 'claude-sonnet-5-5')
    assertEquals(JSON.parse(String(m.calls[0].init.body)).stream, true)
  } finally { m.restore() }
})

Deno.test('createMessageStreamed: refusal and max_tokens are coded; overloaded mid-stream is retried once', async () => {
  let m = mockFetch([streamOk('refusal')])
  try {
    assertEquals((await codeOf(createMessageStreamed(opts().o))).code, 'refused')
  } finally { m.restore() }

  m = mockFetch([streamOk('max_tokens')])
  try {
    assertEquals((await codeOf(createMessageStreamed(opts().o))).code, 'unreadable')
  } finally { m.restore() }

  m = mockFetch([sse([{ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } }, { type: 'error', error: { type: 'overloaded_error' } }]), streamOk()])
  try {
    const resp = await createMessageStreamed(opts().o)
    assertEquals(extractText(resp), '{"actions":[]}')
    assertEquals(m.calls.length, 2)
  } finally { m.restore() }

  m = mockFetch([apiError(529, 'overloaded_error'), apiError(529, 'overloaded_error')])
  try {
    assertEquals((await codeOf(createMessageStreamed(opts().o))).code, 'busy')
  } finally { m.restore() }
})
