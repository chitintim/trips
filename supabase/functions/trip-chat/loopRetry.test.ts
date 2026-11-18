import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import type { AnthropicMessage, AnthropicRequestOptions, AnthropicUsage } from '../_shared/anthropic.ts'
import { MAX_CALL_RETRIES, retryDelayMs, runChatTurn } from './loop.ts'

type Ev = Record<string, unknown>
const sse = (events: Ev[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
const start = (): Ev => ({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10 } } })
const end = (): Ev => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
const textTurn = (t: string): Ev[] => [
  start(),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: 0 },
  end(),
]

type Step = Response | Error
async function run(steps: Step[], extra: { deadlineAt?: number } = {}) {
  const queue = [...steps]
  const sent: Ev[] = []
  const sleeps: number[] = []
  let calls = 0
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }
  const conversation: AnthropicMessage[] = [{ role: 'user', content: 'hi' }]
  let error: unknown
  let finalText = ''
  try {
    const r = await runChatTurn({
      callModel: (_o: AnthropicRequestOptions) => {
        calls++
        const next = queue.shift()
        if (!next) return Promise.reject(new Error('no more canned responses'))
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      },
      model: 'claude-sonnet-5-5', system: [], tools: [], conversation,
      executeTool: () => Promise.resolve({ content: '{}' }),
      send: (o) => sent.push(o as Ev), usage, state: { model: 'claude-sonnet-5-5' }, maxIterations: 4,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() }, ...extra,
    })
    finalText = r.finalText
  } catch (e) {
    error = e
  }
  return { calls, sent, sleeps, usage, error, finalText }
}

const busy = () => new AiCallError('busy', 'http 529')

Deno.test('retry: a 529 on the first call is retried and the second succeeds, text sent once', async () => {
  const r = await run([busy(), sse(textTurn('Hello'))])
  assertEquals(r.error, undefined)
  assertEquals(r.calls, 2)
  assertEquals(r.finalText, 'Hello')
  assertEquals(r.sent.filter((e) => e.type === 'text').length, 1)
  assertEquals(r.sleeps.length, 1)
  assert(r.sleeps[0] >= 300 && r.sleeps[0] <= 700)
})

Deno.test('retry: a network failure (TypeError) is retried', async () => {
  const r = await run([new TypeError('fetch failed'), sse(textTurn('ok'))])
  assertEquals(r.error, undefined)
  assertEquals(r.calls, 2)
})

Deno.test('retry: an overloaded_error stream event before any text is retried; the failed attempt is billed', async () => {
  const r = await run([
    sse([start(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
    sse(textTurn('fine')),
  ])
  assertEquals(r.error, undefined)
  assertEquals(r.calls, 2)
  assertEquals(r.usage.input_tokens, 20) // 10 for the failed attempt + 10
})

Deno.test('retry: retries exhausted -> the busy AiCallError surfaces after 1 + 2 calls, nothing sent', async () => {
  const r = await run([busy(), busy(), busy(), sse(textTurn('never'))])
  assert(r.error instanceof AiCallError)
  assertEquals((r.error as AiCallError).code, 'busy')
  assertEquals(r.calls, 1 + MAX_CALL_RETRIES)
  assertEquals(r.sleeps.length, MAX_CALL_RETRIES)
  assertEquals(r.sent.length, 0)
})

Deno.test('retry: no retry once text has streamed (a mid-stream overload is final, no duplicate text)', async () => {
  const r = await run([
    sse([start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'x' } }]),
    sse(textTurn('again')),
  ])
  assert(r.error instanceof AiCallError)
  assertEquals((r.error as AiCallError).code, 'busy')
  assertEquals(r.calls, 1)
  assertEquals(r.sent.filter((e) => e.type === 'text').length, 1)
})

Deno.test('retry: no retry on 400-class (unknown), refused, too_large, or rate_limited errors', async () => {
  for (const e of [new AiCallError('unknown', 'http 400'), new AiCallError('too_large', 'http 413'), new AiCallError('rate_limited', 'http 429'), new AiCallError('refused')]) {
    const r = await run([e, sse(textTurn('x'))])
    assertEquals(r.calls, 1, e.code)
    await assertRejects(() => Promise.reject(r.error))
    assertEquals(r.sleeps.length, 0)
  }
})

Deno.test('retry: skipped when the time budget cannot fit the wait plus an attempt', async () => {
  const r = await run([busy(), sse(textTurn('x'))], { deadlineAt: Date.now() + 2000 })
  assert(r.error instanceof AiCallError)
  assertEquals(r.calls, 1)
})

Deno.test('retry: skipped when the failed attempt already hit the per-turn output cap', async () => {
  const capped = sse([start(), { type: 'message_delta', delta: {}, usage: { output_tokens: 30_000 } },
    { type: 'error', error: { type: 'overloaded_error', message: 'x' } }])
  const r = await run([capped, sse(textTurn('x'))])
  assert(r.error instanceof AiCallError)
  assertEquals(r.calls, 1)
})

Deno.test('retryDelayMs: jittered 0.5 s then 1.5 s, none past the limit', () => {
  assertEquals(retryDelayMs(busy(), 0, () => 0.5), 500)
  assertEquals(retryDelayMs(busy(), 1, () => 0.5), 1500)
  assertEquals(retryDelayMs(busy(), 2), null)
})
