// Per-turn cost bounds, moving cache breakpoint, tool-result caps, local day, history window, daily spend.
// All mocked: no network, no spend.
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import type { AnthropicContentBlock, AnthropicMessage, AnthropicRequestOptions, AnthropicUsage } from '../_shared/anthropic.ts'
import { buildMessageBody } from '../_shared/anthropic.ts'
import { estimateCostUsd } from '../_shared/pricing.ts'
import {
  capRoundResults, CHAT_MAX_TOKENS, MAX_ROUND_RESULT_CHARS, MAX_TOOLS_PER_ROUND, MAX_TURN_COST_USD, MAX_TURN_OUTPUT_TOKENS,
  moveToolBreakpoint, NOTICE_TURN_LIMIT, runChatTurn, TRUNCATION_NOTE,
} from './loop.ts'
import { dailyLimitUsd, enforceDailySpend, SpendLimitError } from './spend.ts'
import { localNow, parseOffsetMinutes } from './localTime.ts'
import { historyWindowStart, loadHistory } from './context.ts'
import { baseTables, fakeClient, newDb, ME, TRIP } from './tools/propose/testing.ts'

type Ev = Record<string, unknown>
const sse = (events: Ev[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
function toolRound(n: number, tools: number, out: number, input = 100, cacheRead = 0): Ev[] {
  const evs: Ev[] = [{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: input, cache_read_input_tokens: cacheRead } } }]
  for (let i = 0; i < tools; i++) {
    evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `t${n}_${i}`, name: 'get_expenses', input: {} } },
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'content_block_stop', index: i })
  }
  evs.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: out } })
  return evs
}
async function run(rounds: Ev[][], opts: { toolChars?: number; max?: number } = {}) {
  const bodies: Array<{ max_tokens: number; messages: Array<{ role: string; content: unknown }> }> = []
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const queue = [...rounds]
  let executed = 0
  const conversation: AnthropicMessage[] = [{ role: 'user', content: 'q' }]
  const result = await runChatTurn({
    callModel: (o: AnthropicRequestOptions) => {
      bodies.push(JSON.parse(JSON.stringify(buildMessageBody(o, o.model!, true))))
      const next = queue.shift()
      if (!next) throw new Error('model called more often than the bound allows')
      return Promise.resolve(sse(next))
    },
    model: 'claude-sonnet-5-5', system: [], tools: [], conversation,
    executeTool: () => { executed++; return Promise.resolve({ content: 'x'.repeat(opts.toolChars ?? 10) }) },
    send: () => {}, usage, state: { model: 'claude-sonnet-5-5' }, maxIterations: opts.max ?? 6,
  })
  return { result, bodies, usage, executed, conversation }
}

Deno.test('every model call asks for at most 6000 tokens', async () => {
  const r = await run([[{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]])
  assertEquals(CHAT_MAX_TOKENS, 6000)
  assertEquals(r.bodies[0].max_tokens, 6000)
})

Deno.test('output bound: the turn stops with a plain message once 24k tokens were written, and makes no further call', async () => {
  const r = await run([toolRound(0, 1, 9000), toolRound(1, 1, 9000), toolRound(2, 1, 9000), toolRound(3, 1, 9000)])
  assertEquals(r.bodies.length, 3) // 27k >= 24k after the third call: the fourth is never made
  assert(r.usage.output_tokens >= MAX_TURN_OUTPUT_TOKENS)
  assertStringIncludes(r.result.finalText, NOTICE_TURN_LIMIT)
  assertEquals(r.executed, 2) // the tool of the call that crossed the line is not run either
})

Deno.test('cost bound: a huge uncached prompt trips the dollar ceiling after one call', async () => {
  const r = await run([toolRound(0, 1, 100, 400_000), toolRound(1, 1, 100)])
  assert(estimateCostUsd(r.usage, 'claude-sonnet-5-5') >= MAX_TURN_COST_USD)
  assertEquals(r.bodies.length, 1)
  assertStringIncludes(r.result.finalText, NOTICE_TURN_LIMIT)
})

Deno.test('worst-case arithmetic stays under the documented per-turn bound', () => {
  // cold 31k prompt, 6 rounds, 4k output each (24k total), 8k-token tool results per round
  const base = 31_000, add = 4_000 + 8_000
  const u: AnthropicUsage = { input_tokens: 4_000, output_tokens: 24_000, cache_creation_input_tokens: base - 4_000, cache_read_input_tokens: 0 }
  for (let k = 2; k <= 6; k++) { u.cache_read_input_tokens! += base + add * (k - 2); u.cache_creation_input_tokens! += add }
  const cost = estimateCostUsd(u, 'claude-sonnet-5-5')
  assert(cost < 0.55, `worst case ${cost}`)
  assert(cost > 0.4)
})

Deno.test('tool calls: at most 6 run per round, every tool_use still gets a result', async () => {
  const r = await run([toolRound(0, 8, 10), [{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]])
  assertEquals(r.executed, MAX_TOOLS_PER_ROUND)
  const results = (r.bodies[1].messages[2].content as Array<{ type: string; is_error?: boolean; content: string }>)
  assertEquals(results.length, 8)
  assertEquals(results.filter((b) => b.is_error).length, 2)
  assertStringIncludes(results[7].content, 'at most 6')
})

Deno.test('tool results: the round total is capped and the model sees the truncation marker', () => {
  const big = (id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'y'.repeat(8000) })
  const capped = capRoundResults([big('a'), big('b'), big('c'), big('d'), big('e')], MAX_ROUND_RESULT_CHARS)
  const total = capped.reduce((a, b) => a + (b.type === 'tool_result' ? b.content.length : 0), 0)
  assert(total <= MAX_ROUND_RESULT_CHARS, `total ${total}`)
  assert(capped.every((b) => b.type === 'tool_result' && b.content.endsWith(TRUNCATION_NOTE)))
  assertStringIncludes(TRUNCATION_NOTE, 'narrower question')
  // small results are left exactly as they are
  const small = [{ type: 'tool_result' as const, tool_use_id: 'a', content: '{"ok":1}' }]
  assertEquals(capRoundResults(small, MAX_ROUND_RESULT_CHARS), small)
})

Deno.test('cache: exactly one moving breakpoint, always on the latest tool_result', async () => {
  const r = await run([toolRound(0, 2, 10), toolRound(1, 2, 10), toolRound(2, 1, 10), [{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]])
  assertEquals(r.bodies.length, 4)
  for (let i = 1; i < 4; i++) {
    const marked: string[] = []
    r.bodies[i].messages.forEach((m, mi) => {
      if (Array.isArray(m.content)) (m.content as Array<{ type: string; tool_use_id?: string; cache_control?: unknown }>).forEach((b, bi) => { if (b.cache_control) marked.push(`${mi}.${bi}:${b.type}`) })
    })
    assertEquals(marked.length, 1, `request ${i}: ${marked}`)
    const lastMsg = r.bodies[i].messages.length - 1
    const content = r.bodies[i].messages[lastMsg].content as unknown[]
    assertEquals(marked[0], `${lastMsg}.${content.length - 1}:tool_result`)
  }
})

Deno.test('moveToolBreakpoint leaves text history breakpoints and thinking blocks alone', () => {
  const think: AnthropicContentBlock = { type: 'thinking', thinking: 't', signature: 's' } as AnthropicContentBlock
  const conv: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'h', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [think, { type: 'tool_use', id: '1', name: 'n', input: {} } as AnthropicContentBlock] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'r', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'n', input: {} } as AnthropicContentBlock] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: 'r2' }] },
  ]
  moveToolBreakpoint(conv)
  const flat = conv.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<{ type: string; cache_control?: unknown }>
  assertEquals(flat.filter((b) => b.cache_control).map((b) => b.type), ['text', 'tool_result'])
  assert((conv[2].content as Array<{ cache_control?: unknown }>)[0].cache_control === undefined)
  assert((conv[4].content as Array<{ cache_control?: unknown }>)[0].cache_control !== undefined)
  assertEquals((conv[1].content as unknown[])[0], think)
})

Deno.test('history window slides in blocks of 6 turns, so the cached prefix stays put', () => {
  const starts = [10, 24, 25, 30, 35, 36, 37, 47, 48, 49].map(historyWindowStart)
  assertEquals(starts, [0, 0, 0, 0, 0, 12, 12, 12, 24, 24])
  // for 11 consecutive new turns (22 rows) the first replayed row only changes twice
  const seq = Array.from({ length: 12 }, (_, i) => historyWindowStart(24 + i * 2))
  assert(new Set(seq).size <= 3)
})

Deno.test('loadHistory: window start is stable, current turn skipped, size bounded', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    trip_id: TRIP, thread_user_id: ME, role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, turn_id: `turn-${Math.floor(i / 2)}`, created_at: `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  const t = baseTables(); t.trip_chat_messages = [...rows].reverse() // the fake ignores order(): store newest first
  const db = newDb(t)
  // the fake client sorts by insertion order; emulate a count the way PostgREST returns it
  const base = fakeClient(db, 'user')
  const client = { from: (name: string) => {
    const q = base.from(name) as unknown as Record<string, (...a: unknown[]) => unknown>
    if (name !== 'trip_chat_messages') return q
    return new Proxy(q, { get(tg, p, rc) { if (p === 'then') return (res: (v: unknown) => unknown) => (tg.then as (f: (v: { data: unknown[] }) => unknown) => unknown)((v) => res({ ...v, count: 60 })); return Reflect.get(tg, p, rc) } })
  } } as never
  const h = await loadHistory(client, TRIP, ME, null, new Map(), null)
  // 60 rows -> start = floor((60-24)/12)*12 = 36 -> 24 rows, first is m36
  assertEquals(h.messages.length, 24)
  assertEquals((h.messages[0] as { content: string }).content, 'm36')
})

Deno.test('daily spend limit: defaults 1.50 / 3.00, env overrides, 24h rolling sum, plain error code', async () => {
  const env = (m: Record<string, string>) => (n: string) => m[n]
  assertEquals(dailyLimitUsd(env({}), false), 1.5)
  assertEquals(dailyLimitUsd(env({}), true), 3)
  assertEquals(dailyLimitUsd(env({ TRIP_CHAT_DAILY_USD_PARTICIPANT: '0.5', TRIP_CHAT_DAILY_USD_ORGANISER: '9' }), true), 9)
  assertEquals(dailyLimitUsd(env({ TRIP_CHAT_DAILY_USD_PARTICIPANT: 'abc' }), false), 1.5)
  const now = new Date('2026-11-17T10:00:00Z')
  const t = baseTables()
  t.ai_usage = [
    { user_id: ME, function_name: 'trip-chat', estimated_cost_usd: '1.00', created_at: '2026-11-17T09:00:00.000Z' },
    { user_id: ME, function_name: 'trip-chat', estimated_cost_usd: 0.4, created_at: '2026-11-16T11:00:00.000Z' },
    { user_id: ME, function_name: 'trip-chat', estimated_cost_usd: 5, created_at: '2026-11-16T09:00:00.000Z' }, // older than 24h
    { user_id: ME, function_name: 'parse-receipt', estimated_cost_usd: 5, created_at: '2026-11-17T09:00:00.000Z' },
  ]
  const admin = fakeClient(newDb(t), 'admin')
  await enforceDailySpend(admin, ME, false, env({}), now) // 1.40 < 1.50
  let err: unknown
  try { await enforceDailySpend(admin, ME, false, env({ TRIP_CHAT_DAILY_USD_PARTICIPANT: '1.4' }), now) } catch (e) { err = e }
  assert(err instanceof SpendLimitError)
  assertEquals((err as SpendLimitError).status, 429)
  assertStringIncludes((err as Error).message, "You've used today's assistant allowance")
  await enforceDailySpend(admin, ME, true, env({}), now) // organiser allowance 3.00
})

Deno.test('local day: tz moves the calendar day, not the instant', () => {
  const at = new Date('2026-11-18T02:30:00Z') // evening of the 17th in Los Angeles
  assertEquals(localNow(at, null).today, '2026-11-18')
  assertEquals(localNow(at, 'America/Los_Angeles').today, '2026-11-17')
  assertEquals(localNow(at, '-08:00').today, '2026-11-17')
  assertEquals(localNow(at, 'Pacific/Auckland').today, '2026-11-18')
  assertEquals(localNow(at, 'Not/AZone').today, '2026-11-18')
  assertEquals(parseOffsetMinutes('+05:30'), 330)
  const l = localNow(at, 'America/Los_Angeles').now
  assertEquals(l.getTime(), at.getTime()) // deadlines still compare against the real instant
  assertEquals(l.getDate(), 17)
})
