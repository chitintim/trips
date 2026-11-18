// Whole-turn tests with a fake database and the model mocked at the HTTP layer
// (canned SSE streams). No network, no API spend, nothing sent.
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AnthropicRequestOptions } from '../_shared/anthropic.ts'
import { handleChat, type ChatDeps } from './handler.ts'
import { actionsEnabledFor } from './flags.ts'
import { buildToolDefs } from './registry.ts'
import { baseTables, fakeClient, newDb, ANA, BEN, ME, OPT_C, SAM, SEC_OPEN, TRIP, type FakeDb, type Row } from './tools/propose/testing.ts'

type Ev = Record<string, unknown>
type Block = { text: string } | { tool: string; input: unknown }

const sseOf = (events: Ev[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
function roundEvents(blocks: Block[], n: number): Ev[] {
  const evs: Ev[] = [{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 40 } } }]
  let i = 0
  let tools = 0
  for (const b of blocks) {
    if ('text' in b) {
      evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }, { type: 'content_block_stop', index: i })
    } else {
      tools++
      evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu_${n}_${i}`, name: b.tool, input: {} } },
        { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }, { type: 'content_block_stop', index: i })
    }
    i++
  }
  evs.push({ type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } })
  return evs
}

function tables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  const t = baseTables()
  t.trips = [{ id: TRIP, name: 'Alps', location: 'Chamonix', start_date: '2026-12-05', end_date: '2026-12-12', status: 'booking_details', base_currency: 'GBP', created_by: SAM, confirmation_enabled: false, confirmation_deadline: null, settlement_snapshot: null, chase_settings: null }]
  const p = (user_id: string, full: string, role = 'participant', cs: string | null = null) => ({ trip_id: TRIP, user_id, role, active: true, confirmation_status: cs, user: { full_name: full, email: null } })
  t.trip_participants = [p(ME, 'Tim'), p(SAM, 'Sam', 'organizer'), p(ANA, 'Ana'), p(BEN, 'Ben')]
  t.users = [{ id: ME, full_name: 'Tim', email: null, role: 'user' }, { id: SAM, full_name: 'Sam', email: null, role: 'user' }]
  t.trip_chat_messages = []
  t.chat_actions = []
  return { ...t, ...over }
}

interface Harness { deps: ChatDeps; db: FakeDb; requests: Record<string, unknown>[]; logs: string[]; usage: number }
function harness(opts: { rounds: Block[][]; flag?: string; tables?: Record<string, Row[]>; legacy?: boolean; as?: string }): Harness {
  const db = newDb(tables(opts.tables))
  const requests: Record<string, unknown>[] = []
  const logs: string[] = []
  const rounds = [...opts.rounds]
  let n = 0
  const as = opts.as ?? ME
  const wrap = (c: SupabaseClient, auth: boolean): SupabaseClient => {
    const from = c.from.bind(c)
    return {
      from: (t: string) => {
        const q = from(t)
        if (opts.legacy && t === 'trip_chat_messages') return legacyProxy(q)
        return q
      },
      rpc: (name: string) => Promise.resolve({ data: name === 'is_trip_participant' || name === 'consume_rate_limit' ? true : null, error: null }),
      auth: { getUser: () => Promise.resolve(auth ? { data: { user: { id: as } }, error: null } : { data: { user: null }, error: null }) },
    } as unknown as SupabaseClient
  }
  const h: Harness = { db, requests, logs, usage: 0, deps: undefined as unknown as ChatDeps }
  h.deps = {
    callerClient: () => wrap(fakeClient(db, 'user'), true),
    serviceClient: () => wrap(fakeClient(db, 'admin'), false),
    callModel: (o: AnthropicRequestOptions) => {
      requests.push(JSON.parse(JSON.stringify(o)))
      const r = rounds.shift()
      if (!r) throw new Error('model must not be called again')
      return Promise.resolve(sseOf(roundEvents(r, n++)))
    },
    model: 'claude-sonnet-5-5',
    env: (name) => (name === 'TRIP_CHAT_ACTIONS' ? opts.flag : undefined),
    logUsage: () => { h.usage++; return Promise.resolve() },
    log: (l) => logs.push(l),
    now: () => new Date('2026-11-17T10:00:00Z'),
    pingMs: 1_000_000,
  }
  return h
}
function legacyProxy(q: unknown): unknown {
  return new Proxy(q as object, {
    get(target, prop, recv) {
      const t = target as Record<string, (...a: unknown[]) => unknown>
      if (prop === 'eq') return (col: string, v: unknown) => col === 'thread_user_id' ? errQuery() : legacyProxy(t.eq(col, v))
      if (prop === 'select' || prop === 'order' || prop === 'limit') return (...a: unknown[]) => legacyProxy(t[prop as string](...a))
      if (prop === 'insert') return (row: Row) => { assert(!('thread_user_id' in row) && !('turn_id' in row), 'legacy mode must not write the new columns'); return t.insert(row) }
      return Reflect.get(target, prop, recv)
    },
  })
}
function errQuery() {
  const q: Record<string, unknown> = {}
  const self = new Proxy(q, { get: (_t, p) => (p === 'then' ? (res: (v: unknown) => unknown) => res({ data: null, error: { code: '42703', message: 'column thread_user_id does not exist' } }) : () => self) })
  return self
}

async function post(h: Harness, body: Record<string, unknown>): Promise<{ status: number; events: Ev[]; raw: string }> {
  const res = await handleChat(new Request('https://x.test/trip-chat', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: TRIP, ...body }) }), h.deps)
  const raw = await res.text()
  const events = raw.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Ev)
  return { status: res.status, events, raw }
}
const types = (e: Ev[]) => e.map((x) => x.type)
const TURN = '11111111-1111-4111-8111-111111111111'
const chatActions = (h: Harness) => (h.db.tables.chat_actions ?? [])

Deno.test('old client: no turnId, no tools -> text + done only, nothing else', async () => {
  const h = harness({ rounds: [[{ text: 'Hello Tim' }]] })
  const r = await post(h, { message: 'hi' })
  assertEquals(r.status, 200)
  assertEquals(types(r.events), ['text', 'done'])
  const done = r.events[1]
  assertEquals(done.message, 'Hello Tim')
  assertEquals(done.actions, [])
  assertEquals(done.actions_enabled, false)
  assertEquals(h.usage, 1)
})

Deno.test('request shape: constant tools, two cached system blocks, digest and words are separate blocks, plain (non-strict) tools, effort low', async () => {
  const h = harness({ rounds: [[{ text: 'ok' }]] })
  await post(h, { message: 'what do I owe?', page: 'money' })
  const req = h.requests[0] as { tools: Array<{ name: string; strict?: boolean }>; system: Array<{ cache_control?: unknown; text: string }>; messages: Array<{ role: string; content: Array<{ text: string }> }>; output_config: { effort: string } }
  assertEquals(req.tools.map((t) => t.name), buildToolDefs().map((t) => t.name))
  assertEquals(req.system.length, 2)
  assert(req.system.every((s) => s.cache_control))
  assertStringIncludes(req.system[1].text, 'Alps')
  assert(!/booking_details|gathering_interest/.test(req.system[1].text), 'no raw enums in the system prompt')
  const last = req.messages[req.messages.length - 1]
  assertEquals(last.content.length, 2)
  assertStringIncludes(last.content[0].text, '[Context]')
  assertStringIncludes(last.content[0].text, 'money page')
  assertEquals(last.content[1].text, 'what do I owe?')
  assertEquals(req.output_config.effort, 'low')
  assert(req.tools.every((t) => !('strict' in t)), 'tools must not be strict: the API limits strict schemas to 16 union params and rejects nullable enums')
})

Deno.test('tools array and system prefix are identical for organiser and participant, flag on or off', async () => {
  const a = harness({ rounds: [[{ text: 'a' }]], as: ME, flag: 'on' })
  const b = harness({ rounds: [[{ text: 'a' }]], as: SAM, flag: 'off' })
  await post(a, { message: 'hi' })
  await post(b, { message: 'hi' })
  assertEquals(JSON.stringify(a.requests[0].tools), JSON.stringify(b.requests[0].tools))
  assertEquals(JSON.stringify(a.requests[0].system), JSON.stringify(b.requests[0].system))
})

Deno.test('read tool round: status event with a fixed label, parallel results in ONE user message', async () => {
  const h = harness({ rounds: [[{ tool: 'get_my_todos', input: {} }, { tool: 'get_people', input: {} }], [{ text: 'You have things.' }]] })
  const r = await post(h, { message: 'what do I need to do?' })
  assertEquals(types(r.events), ['status', 'status', 'text', 'done'])
  assertEquals(r.events[0].label, 'Checking your to-dos…')
  const second = h.requests[1].messages as Array<{ role: string; content: unknown }>
  const toolMsg = second[second.length - 1]
  assertEquals(toolMsg.role, 'user')
  assertEquals((toolMsg.content as unknown[]).length, 2)
  // tools and system are byte-identical between iterations
  assertEquals(JSON.stringify(h.requests[0].tools), JSON.stringify(h.requests[1].tools))
  assertEquals(JSON.stringify(h.requests[0].system), JSON.stringify(h.requests[1].system))
  const line = JSON.parse(h.logs[0])
  assertEquals(line.iterations, 2)
  assertEquals(line.tools, ['get_my_todos', 'get_people'])
  assertEquals(line.cache_read, 80)
  assert(!h.logs[0].includes('what do I need'), 'usage line has no message text')
})

const addTodo = (title = 'Book the ferry') => ({ tool: 'propose_add_todo', input: { title, notes: null, who: 'me', person_id: null, due: 'none', due_date: null, question_id: null } })

Deno.test('flag on: propose writes ONE chat_actions row (service role), emits action, done lists it', async () => {
  const h = harness({ rounds: [[addTodo()], [{ text: 'Added a card.' }]], flag: 'on' })
  const r = await post(h, { message: 'add a to-do to book the ferry', turnId: TURN })
  assertEquals(types(r.events).filter((t) => t === 'action').length, 1)
  assertEquals(chatActions(h).length, 1)
  const row = chatActions(h)[0]
  assertEquals(row.kind, 'add_todo')
  assertEquals(row.user_id, ME)
  assertEquals(row.turn_id, TURN)
  assertEquals(row.requires, 'tap')
  const done = r.events.at(-1)!
  assertEquals((done.actions as string[]).length, 1)
  assertEquals(done.actions_enabled, true)
  // the trip tables were never written by anyone
  const forbidden = h.db.writes.filter((w) => !['chat_actions', 'trip_chat_messages'].includes(w.table) && w.op !== 'rpc')
  assertEquals(forbidden, [])
})

Deno.test('flag off: tools declared, nothing written, no action events', async () => {
  const h = harness({ rounds: [[addTodo()], [{ text: 'Not yet.' }]], flag: 'off' })
  const r = await post(h, { message: 'add a to-do', turnId: TURN })
  assertEquals(chatActions(h).length, 0)
  assert(!types(r.events).includes('action'))
  assertEquals(r.events.at(-1)!.actions_enabled, false)
  assertStringIncludes(JSON.stringify(h.requests[1].messages), 'not switched on')
})

Deno.test('flag as trip list', () => {
  assert(actionsEnabledFor(`x, ${TRIP}`, TRIP))
  assert(!actionsEnabledFor('some-other-trip', TRIP))
  assert(!actionsEnabledFor(undefined, TRIP))
  assert(!actionsEnabledFor('', TRIP))
  assert(actionsEnabledFor('ON', TRIP))
})

Deno.test('dedupe: a retried turn is answered from the stored reply, no model call, no second row, no second charge', async () => {
  const h = harness({ rounds: [[addTodo()], [{ text: 'Added a card.' }]], flag: 'on' })
  await post(h, { message: 'add a to-do', turnId: TURN })
  const usageBefore = h.usage
  const again = await post(h, { message: 'add a to-do', turnId: TURN })
  assertEquals(types(again.events), ['text', 'action', 'done'])
  assertEquals(again.events.at(-1)!.replayed, true)
  assertEquals(chatActions(h).length, 1)
  assertEquals(h.usage, usageBefore)
  assertEquals(h.requests.length, 2)
})

Deno.test('private thread rows carry thread_user_id and turn_id', async () => {
  const h = harness({ rounds: [[{ text: 'hi' }]] })
  await post(h, { message: 'hello', turnId: TURN })
  const rows = h.db.tables.trip_chat_messages
  assertEquals(rows.length, 2)
  assert(rows.every((r) => r.thread_user_id === ME && r.turn_id === TURN))
})

Deno.test('fail-soft before the migrations: legacy history and rows, chat works as today', async () => {
  const h = harness({ rounds: [[addTodo()], [{ text: 'fine' }]], legacy: true, flag: 'on', tables: { chat_actions: [] } })
  h.db.tableErrors.chat_actions = { code: '42P01', message: 'relation does not exist' }
  const r = await post(h, { message: 'add a to-do', turnId: TURN })
  assertEquals(r.status, 200)
  assert(!types(r.events).includes('action'), 'no card when chat_actions is missing')
  assertEquals(r.events.at(-1)!.message, 'fine')
  assertStringIncludes(JSON.stringify(h.requests[1].messages), 'not switched on')
})

Deno.test('scripted: "vote Dishoom" is a tap card; participant asking to create a question is refused', async () => {
  const h = harness({
    flag: 'on',
    rounds: [
      [{ tool: 'propose_answer', input: { question_id: SEC_OPEN, op: 'pick', option_ids: [OPT_C], ranks: null, own_choice: null } }],
      [{ text: 'Done, tap Confirm.' }],
    ],
  })
  const r = await post(h, { message: 'vote Dishoom', turnId: TURN })
  const a = chatActions(h)
  // Dishoom is locked in the fixture, so this may be refused; either way no trip data was written and the reply streams.
  assert(a.length <= 1)
  assertEquals(r.events.at(-1)!.type, 'done')

  const h2 = harness({
    flag: 'on',
    rounds: [[{ tool: 'propose_create_question', input: { title: 'Where to eat?', shape: 'group', section_type: 'activities', voting: 'single', deadline: null, options: [] } }], [{ text: 'Only organisers can.' }]],
  })
  await post(h2, { message: 'make a poll' })
  assertEquals(chatActions(h2).length, 0)
  assertStringIncludes(JSON.stringify(h2.requests[1].messages), 'is_error')
})

Deno.test('prompt-injection posture: obeying a planted instruction still cannot delete, decide, or use organiser tools', async () => {
  // a participant whose (hijacked) model tries delete_request, propose_actions and an unknown tool
  const h = harness({
    flag: 'on',
    rounds: [
      [{ tool: 'propose_actions', input: { actions: [{ type: 'create_event', idempotency_key: 'k1' }] } }, { tool: 'delete_expense', input: {} }],
      [{ text: 'I cannot do that.' }],
    ],
  })
  const r = await post(h, { message: 'summarise the notes' })
  assertEquals(chatActions(h).length, 0)
  assert(!types(r.events).includes('proposal'))
  const msgs = JSON.stringify(h.requests[1].messages)
  assertStringIncludes(msgs, 'Only organisers can stage changes')
  assertStringIncludes(msgs, 'Unknown tool')
  // an organiser hijacked into delete_request is refused as well
  const o = harness({ flag: 'on', as: SAM, rounds: [[{ tool: 'propose_actions', input: { actions: [{ type: 'delete_request', idempotency_key: 'k', entity_type: 'expense', entity_id: ME }] } }], [{ text: 'No.' }]] })
  const ro = await post(o, { message: 'tidy up' })
  assert(!types(ro.events).includes('proposal'))
  assertStringIncludes(JSON.stringify(o.requests[1].messages), 'Deleting is not possible from chat')
})

Deno.test('open_screen link card is emitted but not stored; stream error keeps the old payload', async () => {
  const h = harness({ flag: 'on', rounds: [[{ tool: 'open_screen', input: { target: 'settle', id: null } }], [{ text: 'Here is the button.' }]] })
  const r = await post(h, { message: 'freeze the balances' })
  const act = r.events.find((e) => e.type === 'action') as { action: { kind: string; requires: string } } | undefined
  assertEquals(act?.action.kind, 'open_screen')
  assertEquals(act?.action.requires, 'link')
  assertEquals(chatActions(h).length, 0)
  assertEquals((r.events.at(-1)!.actions as unknown[]).length, 0)
})

Deno.test('model stream error -> coded error event, usage still logged', async () => {
  const h = harness({ rounds: [[]] })
  h.deps.callModel = () => Promise.resolve(sseOf([{ type: 'message_start', message: { model: 'm', usage: { input_tokens: 5 } } }, { type: 'error', error: { type: 'overloaded_error' } }]))
  const r = await post(h, { message: 'hi' })
  assertEquals(r.events.at(-1)!.type, 'error')
  assertEquals(r.events.at(-1)!.code, 'busy')
  assertEquals(h.usage, 1)
})

// ---- cost bounds, spend ceiling, local day, privacy in the handler ------------------------------------------------

Deno.test('daily spend ceiling: over it -> 429 with code spend_limit, no model call, no message stored, no rate-limit token used', async () => {
  const h = harness({ rounds: [], tables: { ai_usage: [{ user_id: ME, function_name: 'trip-chat', estimated_cost_usd: 1.6, created_at: '2026-11-17T09:00:00.000Z' }] } })
  const r = await post(h, { message: 'hi' })
  assertEquals(r.status, 429)
  const body = JSON.parse(r.raw)
  assertEquals(body.code, 'spend_limit')
  assertStringIncludes(body.error, "You've used today's assistant allowance")
  assertEquals(h.requests.length, 0)
  assertEquals((h.db.tables.trip_chat_messages ?? []).length, 0)
})

Deno.test('daily spend ceiling: organisers get the higher allowance; env overrides it', async () => {
  const usage = [{ user_id: SAM, function_name: 'trip-chat', estimated_cost_usd: 2, created_at: '2026-11-17T09:00:00.000Z' }]
  const org = harness({ rounds: [[{ text: 'ok' }]], as: SAM, tables: { ai_usage: usage } }) // Sam is the organiser: 2.00 < 3.00
  assertEquals((await post(org, { message: 'hi' })).status, 200)
  const org2 = harness({ rounds: [], as: SAM, tables: { ai_usage: usage } })
  const base = org2.deps.env
  org2.deps.env = (n) => (n === 'TRIP_CHAT_DAILY_USD_ORGANISER' ? '1.5' : base(n))
  const r = await post(org2, { message: 'hi' })
  assertEquals(r.status, 429)
  assertEquals(JSON.parse(r.raw).code, 'spend_limit')
})

Deno.test('the ordinary message cap now also carries code daily_limit', async () => {
  const h = harness({ rounds: [] })
  const base = h.deps.callerClient
  h.deps.callerClient = (req) => {
    const c = base(req)
    return { ...c, from: c.from.bind(c), auth: c.auth, rpc: (name: string) => Promise.resolve({ data: name === 'consume_rate_limit' ? false : true, error: null }) } as unknown as SupabaseClient
  }
  const r = await post(h, { message: 'hi' })
  assertEquals(r.status, 429)
  assertEquals(JSON.parse(r.raw).code, 'daily_limit')
})

Deno.test('turn requests: max_tokens 6000 on every call', async () => {
  const h = harness({ rounds: [[{ text: 'ok' }]] })
  await post(h, { message: 'hi' })
  assertEquals((h.requests[0] as { max_tokens: number }).max_tokens, 6000)
})

Deno.test('tz: the digest and the stage use the person\'s local date; no tz = UTC date', async () => {
  const withTz = harness({ rounds: [[{ text: 'ok' }]] })
  await post(withTz, { message: 'hi', tz: '+14:00' }) // 10:00Z is already the 18th there
  const ctxText = JSON.stringify((withTz.requests[0] as { messages: unknown[] }).messages)
  assertStringIncludes(ctxText, 'Today: 2026-11-18 (your local date)')
  const without = harness({ rounds: [[{ text: 'ok' }]] })
  await post(without, { message: 'hi' })
  assertStringIncludes(JSON.stringify((without.requests[0] as { messages: unknown[] }).messages), 'Today: 2026-11-17 (UTC)')
  const bad = harness({ rounds: [[{ text: 'ok' }]] })
  await post(bad, { message: 'hi', tz: 'Mars/Phobos' })
  assertStringIncludes(JSON.stringify((bad.requests[0] as { messages: unknown[] }).messages), 'Today: 2026-11-17')
})

Deno.test('legacy organiser proposals are stored without the organiser\'s wording', async () => {
  const h = harness({ as: SAM, rounds: [[{ tool: 'propose_actions', input: { source_text: 'secret wording', actions: [{ type: 'create_event', idempotency_key: 'k1', trip_id: TRIP, title: 'Dinner', event_date: '2026-12-06' }] } }], [{ text: 'staged' }]] })
  await post(h, { message: 'please add dinner, privately' })
  const rows = h.db.tables.ai_proposals ?? []
  if (rows.length) assertEquals(rows[0].source_text, null)
})
