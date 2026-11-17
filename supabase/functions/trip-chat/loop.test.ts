import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import type { AnthropicMessage, AnthropicRequestOptions, AnthropicUsage } from '../_shared/anthropic.ts'
import { buildMessageBody } from '../_shared/anthropic.ts'
import {
  CHAT_MAX_TOKENS, FINAL_ITERATION_INSTRUCTION, NOTICE_CUT_SHORT, NOTICE_EMPTY, NOTICE_REFUSAL, NOTICE_TOOLS_EXHAUSTED,
  runChatTurn, stopReasonNotice,
} from './loop.ts'

type Ev = Record<string, unknown>
const sse = (events: Ev[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
const start = (input = 10, cacheRead = 0): Ev => ({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: input, cache_read_input_tokens: cacheRead } } })
const end = (stop: string, out = 5): Ev => ({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: out } })
const thinking = (i: number, text: string, sig: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: sig } },
  { type: 'content_block_stop', index: i },
]
const text = (i: number, t: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: i },
]
const toolUse = (i: number, id: string, json: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name: 'get_expenses', input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index: i },
]
const toolTurn = (id: string, ...pre: Ev[][]): Ev[] => [start(), ...pre.flat(), ...toolUse(pre.length, id, '{"x":1}'), end('tool_use')]

const TOOLS = [{ name: 'get_expenses', description: 'd', input_schema: { type: 'object' } }]
const SYSTEM = [{ type: 'text' as const, text: 'SYS', cache_control: { type: 'ephemeral' as const } }]

async function run(model: string, responses: Ev[][], opts: { maxIterations?: number; toolThrows?: boolean } = {}) {
  const requests: string[] = []
  const bodies: Record<string, unknown>[] = []
  const sent: Ev[] = []
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const state = { model }
  const queue = [...responses]
  const conversation: AnthropicMessage[] = [{ role: 'user', content: '[Tim]: who owes what' }]
  const callModel = (o: AnthropicRequestOptions) => {
    const body = buildMessageBody(o, o.model!, true)
    requests.push(JSON.stringify(body))
    bodies.push(JSON.parse(JSON.stringify(body)))
    const next = queue.shift()
    if (!next) throw new Error('no more canned responses')
    return Promise.resolve(sse(next))
  }
  let result: { finalText: string } | undefined
  let error: unknown
  try {
    result = await runChatTurn({
      callModel, model, system: SYSTEM, tools: TOOLS, conversation,
      executeTool: (tu) => opts.toolThrows ? Promise.reject(new Error('boom')) : Promise.resolve({ content: JSON.stringify({ ok: tu.id }) }),
      send: (o) => sent.push(o as Ev), usage, state, maxIterations: opts.maxIterations ?? 6,
    })
  } catch (e) {
    error = e
  }
  return { result, error, requests, bodies, sent, usage, state, conversation }
}

Deno.test('thinking blocks are replayed byte-identical in the next request', async () => {
  const r = await run('claude-sonnet-5-5', [
    toolTurn('t1', thinking(0, 'plan it', 'SIG1'), text(1, 'Looking.')),
    [start(), ...text(0, 'Tim owes 5.'), end('end_turn')],
  ])
  const second = r.bodies[1].messages as AnthropicMessage[]
  assertEquals(second[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan it', signature: 'SIG1' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'get_expenses', input: { x: 1 } },
    ],
  })
  assertEquals((second[2] as { content: unknown[] }).content, [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":"t1"}' }])
})

Deno.test('redacted_thinking is replayed too', async () => {
  const red: Ev[] = [{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } }, { type: 'content_block_stop', index: 0 }]
  const r = await run('claude-sonnet-5-5', [toolTurn('t1', red), [start(), ...text(0, 'ok'), end('end_turn')]])
  const asst = (r.bodies[1].messages as AnthropicMessage[])[1]
  assertEquals((asst.content as unknown[])[0], { type: 'redacted_thinking', data: 'ENCRYPTED' })
})

Deno.test('tools and system are identical on every iteration; request carries effort low, no forbidden fields', async () => {
  const r = await run('claude-sonnet-5-5', [
    toolTurn('t1'), toolTurn('t2'), [start(), ...text(0, 'done'), end('end_turn')],
  ])
  assertEquals(r.bodies.length, 3)
  for (const b of r.bodies) {
    assertEquals(JSON.stringify(b.tools), JSON.stringify(TOOLS))
    assertEquals(JSON.stringify(b.system), JSON.stringify(SYSTEM))
    assertEquals(b.output_config, { effort: 'low' })
    assertEquals(b.max_tokens, CHAT_MAX_TOKENS)
    for (const f of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert(!(f in b), `unexpected ${f}`)
    assertEquals(b.stream, true)
  }
})

Deno.test('Sonnet 5.5: the last iteration keeps tools and appends the trailing system message (only there)', async () => {
  const r = await run('claude-sonnet-5-5', [toolTurn('t1'), toolTurn('t2'), toolTurn('t3')], { maxIterations: 3 })
  const hasSys = (b: Record<string, unknown>) => (b.messages as AnthropicMessage[]).some((m) => m.role === 'system')
  assertEquals(r.bodies.map(hasSys), [false, false, true])
  const msgs = r.bodies[2].messages as AnthropicMessage[]
  assertEquals(msgs[msgs.length - 1], { role: 'system', content: FINAL_ITERATION_INSTRUCTION })
  assertEquals(msgs[msgs.length - 2].role, 'user') // follows the tool_result turn
  assertEquals(JSON.stringify(r.bodies[2].tools), JSON.stringify(TOOLS))
  // The model still asked for a tool on the last turn: a fixed message, no tool run, nothing persisted as tool state.
  assertEquals(r.result?.finalText, NOTICE_TOOLS_EXHAUSTED)
  assert(!r.conversation.some((m) => m.role === 'system'))
})

Deno.test('rollback model (claude-sonnet-5): no system message ever, tools dropped on the last iteration as before', async () => {
  const r = await run('claude-sonnet-5', [toolTurn('t1'), [start(), ...text(0, 'final'), end('end_turn')]], { maxIterations: 2 })
  for (const b of r.bodies) assert(!(b.messages as AnthropicMessage[]).some((m) => m.role === 'system'))
  assert('tools' in r.bodies[0])
  assert(!('tools' in r.bodies[1]))
  assertEquals(r.result?.finalText, 'final')
})

Deno.test('text of each iteration is joined with a blank line and streamed as text events', async () => {
  const r = await run('claude-sonnet-5-5', [
    toolTurn('t1', text(0, 'Checking.')),
    [start(), ...text(0, 'Tim owes 5.'), end('end_turn')],
  ])
  assertEquals(r.result?.finalText, 'Checking.\n\nTim owes 5.')
  assertEquals(r.sent.map((e) => e.text).join(''), 'Checking.\n\nTim owes 5.')
})

Deno.test('usage is summed across iterations', async () => {
  const r = await run('claude-sonnet-5-5', [
    [start(100, 0), ...toolUse(0, 't1', '{}'), end('tool_use', 20)],
    [start(150, 90), ...text(0, 'ok'), end('end_turn', 30)],
  ])
  assertEquals(r.usage.input_tokens, 250)
  assertEquals(r.usage.output_tokens, 50)
  assertEquals(r.usage.cache_read_input_tokens, 90)
  assertEquals(r.state.model, 'claude-sonnet-5-5')
})

Deno.test('a failing tool goes back as an is_error result, the loop continues', async () => {
  const r = await run('claude-sonnet-5-5', [toolTurn('t1'), [start(), ...text(0, 'sorry'), end('end_turn')]], { toolThrows: true })
  const results = ((r.bodies[1].messages as AnthropicMessage[])[2].content as Array<Record<string, unknown>>)
  assertEquals(results[0].is_error, true)
  assertEquals(results[0].content, 'boom')
})

Deno.test('mid-stream error event: coded AiCallError, usage so far still counted, partial text was streamed', async () => {
  const r = await run('claude-sonnet-5-5', [[
    start(40), ...text(0, 'Tim ow'), { type: 'error', error: { type: 'overloaded_error', message: 'secret upstream text' } },
  ]])
  assert(r.error instanceof AiCallError)
  assertEquals((r.error as AiCallError).code, 'busy')
  assert(!String((r.error as Error).message).includes('secret'))
  assertEquals(r.usage.input_tokens, 40)
  await assertRejects(async () => { throw r.error }, AiCallError)
})

Deno.test('stop reasons all end in user-visible text', async () => {
  const refusal = await run('claude-sonnet-5-5', [[start(), ...text(0, 'I will'), end('refusal')]])
  assertEquals(refusal.result?.finalText, `I will\n\n${NOTICE_REFUSAL}`)
  const refusalEmpty = await run('claude-sonnet-5-5', [[start(), end('refusal')]])
  assertEquals(refusalEmpty.result?.finalText, NOTICE_REFUSAL)
  const cut = await run('claude-sonnet-5-5', [[start(), ...text(0, 'Tim owes'), end('max_tokens')]])
  assertEquals(cut.result?.finalText, `Tim owes ${NOTICE_CUT_SHORT}`)
  const truncated = await run('claude-sonnet-5-5', [[start(), ...text(0, 'Tim owes')]]) // no message_delta
  assertEquals(truncated.result?.finalText, `Tim owes ${NOTICE_CUT_SHORT}`)
  const empty = await run('claude-sonnet-5-5', [[start(), end('end_turn')]])
  assertEquals(empty.result?.finalText, NOTICE_EMPTY)
  const toolCut = await run('claude-sonnet-5-5', [[start(), ...toolUse(0, 't1', '{"x'), end('max_tokens')]])
  assertEquals(toolCut.result?.finalText, NOTICE_CUT_SHORT)
  assertEquals(toolCut.bodies.length, 1) // a cut-off tool call is not run
})

Deno.test('stopReasonNotice maps every documented reason', () => {
  assertEquals(stopReasonNotice('end_turn'), null)
  assertEquals(stopReasonNotice('stop_sequence'), null)
  for (const r of ['max_tokens', 'refusal', 'model_context_window_exceeded', 'pause_turn', 'something_new', null]) {
    assert(typeof stopReasonNotice(r) === 'string', String(r))
  }
})
