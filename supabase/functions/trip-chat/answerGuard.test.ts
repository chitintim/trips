// "Never end a turn with a button and no facts" (answerNudgeNeeded + the corrective continuation in runChatTurn),
// repeated-sentence filtering, and per-call usage reporting.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import type { AnthropicMessage, AnthropicRequestOptions, AnthropicUsage } from '../_shared/anthropic.ts'
import { buildMessageBody } from '../_shared/anthropic.ts'
import { ANSWER_NUDGE, answerNudgeNeeded, refusalAlreadyGiven, RepeatFilter, runChatTurn } from './loop.ts'

type Ev = Record<string, unknown>
const sse = (events: Ev[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
const start = (input = 10): Ev => ({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: input } } })
const end = (stop: string, out = 5): Ev => ({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: out } })
const textBlock = (i: number, t: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: i },
]
const toolBlock = (i: number, id: string, name: string, json: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index: i },
]
/** A tool round: optional text, then these tool calls. */
const toolRound = (pre: string | null, ...calls: Array<[string, string, string]>): Ev[] => {
  const evs: Ev[] = [start()]
  let i = 0
  if (pre) evs.push(...textBlock(i++, pre))
  for (const [id, name, json] of calls) evs.push(...toolBlock(i++, id, name, json))
  return [...evs, end('tool_use')]
}
const finalRound = (t: string): Ev[] => [start(), ...textBlock(0, t), end('end_turn')]

const SYSTEM = [{ type: 'text' as const, text: 'SYS' }]
const TOOLS = [{ name: 'get_balances', description: 'd', input_schema: { type: 'object' } }, { name: 'open_screen', description: 'd', input_schema: { type: 'object' } }]

async function run(responses: Array<Ev[] | Error>) {
  const bodies: Record<string, unknown>[] = []
  const sent: Ev[] = []
  const billed: Array<{ usage: AnthropicUsage; model: string }> = []
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const queue = [...responses]
  const conversation: AnthropicMessage[] = [{ role: 'user', content: 'who owes what' }]
  let error: unknown
  let result: Awaited<ReturnType<typeof runChatTurn>> | undefined
  try {
    result = await runChatTurn({
      callModel: (o: AnthropicRequestOptions) => {
        bodies.push(JSON.parse(JSON.stringify(buildMessageBody(o, o.model!, true))))
        const next = queue.shift()
        if (!next) throw new Error('no more canned responses')
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(sse(next))
      },
      model: 'claude-sonnet-5-5', system: SYSTEM, tools: TOOLS, conversation,
      executeTool: (tu) => Promise.resolve({ content: JSON.stringify({ ok: tu.id }) }),
      send: (o) => sent.push(o as Ev), usage, state: { model: 'claude-sonnet-5-5' }, maxIterations: 6,
      onCallBilled: (u, model) => { billed.push({ usage: u, model }) },
      sleep: () => Promise.resolve(),
    })
  } catch (e) {
    error = e
  }
  return { result, error, bodies, sent, billed, usage }
}

Deno.test('answerNudgeNeeded: button-only and figure-less money replies are caught; real answers and refusals are not', () => {
  const need = (toolsUsed: string[], linkTargets: string[], text: string) => answerNudgeNeeded({ toolsUsed, linkTargets, text })
  // the live defect: money read, then a button, then a line about the button
  assertEquals(need(['get_balances', 'open_screen'], ['settle'], 'Here is the Settle up page.'), true)
  assertEquals(need(['get_my_money', 'open_screen'], ['settle'], "I've opened Settle up for you, where you can see who owes what."), true)
  assertEquals(need(['open_screen'], ['settle'], "Here's the Settle up page with all the balances in it."), true) // no read at all
  assertEquals(need(['open_screen'], ['todos'], 'Done.'), true) // trivial text next to a button
  assertEquals(need(['list_questions', 'open_screen'], ['question'], 'There are two open questions; here is the button.'), true) // a lookup, then only a line about the button
  // complete answers
  assertEquals(need(['get_balances', 'open_screen'], ['settle'], 'Sam owes Tim £12.50. Everyone else is all square.'), false)
  assertEquals(need(['get_my_money'], [], "You're all square, you don't owe anything."), false)
  assertEquals(need(['get_balances'], [], 'x'.repeat(250)), false)
  // refusals with a button are complete
  assertEquals(need(['open_screen'], ['settle'], "I can't freeze the balances from chat; use the button."), false)
  assertEquals(need(['open_screen'], ['decide'], 'Only an organiser can decide a question.'), false)
  // nothing looked up, no button: leave it
  assertEquals(need([], [], 'Hello.'), false)
})

Deno.test('a money read then a button and a line about the button gets ONE corrective continuation that carries the figures', async () => {
  const r = await run([
    toolRound(null, ['b1', 'get_balances', '{}'], ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound('Here is the Settle up page.'),
    finalRound('Sam owes Tim £12.50; everyone else is all square.'),
  ])
  assertEquals(r.error, undefined)
  assertEquals(r.bodies.length, 3)
  const last = (r.bodies[2].messages as AnthropicMessage[]).at(-1)!
  assertEquals(last.role, 'user') // a `system` message may not follow an assistant reply (HTTP 400)
  assertEquals(last.content, ANSWER_NUDGE)
  assert(r.result!.finalText.includes('£12.50'))
  assertEquals(r.billed.length, 3) // one usage report per model call
})

Deno.test('the continuation happens once, and not for a complete refusal', async () => {
  const twice = await run([
    toolRound(null, ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound('Opened.'),
    finalRound('Still nothing.'),
    finalRound('should never be asked'),
  ])
  assertEquals(twice.bodies.length, 3)
  const refusal = await run([
    toolRound(null, ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound("I can't freeze the balances from chat. The button takes you to Settle up, where an organiser can do it."),
  ])
  assertEquals(refusal.bodies.length, 2)
})

Deno.test('if the corrective continuation itself fails, the person keeps the reply they already have', async () => {
  const r = await run([
    toolRound(null, ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound('Opened it.'),
    new AiCallError('unknown', 'boom'),
  ])
  assertEquals(r.error, undefined)
  assertEquals(r.result!.finalText, 'Opened it.')
})

Deno.test('a sentence said before the tool call and again after it is sent once', async () => {
  const r = await run([
    toolRound('Let me check the balances for you.', ['b1', 'get_balances', '{}']),
    finalRound('Let me check the balances for you. Sam owes Tim £12.50 in total.'),
  ])
  const text = r.sent.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assertEquals(text.split('Let me check the balances for you.').length - 1, 1)
  assert(text.includes('Sam owes Tim £12.50 in total.'))
  assertEquals(r.result!.finalText, text)
})

Deno.test('RepeatFilter: drops repeated sentences and lines, keeps short repeats, never holds text back past the end', () => {
  const f = new RepeatFilter()
  const feed = (...parts: string[]) => parts.map((p) => f.push(p)).join('') + f.flush()
  assertEquals(feed('Sam owes you £12.50 for the taxi. ', 'Sam owes you £12.50 for the taxi. ', 'Thanks!'), 'Sam owes you £12.50 for the taxi. Thanks!')
  const g = new RepeatFilter()
  assertEquals(g.push('Yes. ') + g.push('Yes. ') + g.flush(), 'Yes. Yes. ')
  const h = new RepeatFilter()
  assertEquals(h.push('- Tim paid the airport taxi\n') + h.push('- Tim paid the airport taxi\n') + h.push('- Sam paid lunch') + h.flush(), '- Tim paid the airport taxi\n- Sam paid lunch')
  // split across deltas
  const k = new RepeatFilter()
  assertEquals(k.push('Everything is settled u') + k.push('p between you now. ') + k.push('Everything is settled up') + k.push(' between you now.') + k.flush(), 'Everything is settled up between you now. ')
})

const streamed = (sent: Ev[]) => sent.filter((e) => e.type === 'text').map((e) => e.text).join('')

Deno.test('parity: the text kept for storage is exactly the text streamed, on the nudge path', async () => {
  const r = await run([
    toolRound('Let me look at that for you.', ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound('Here is the Settle up page. Let me look at that for you.'),
    finalRound('Sam owes Tim £12.50; everyone else is all square.'),
  ])
  assertEquals(r.error, undefined)
  assertEquals(r.result!.finalText, streamed(r.sent))
  assertEquals(r.result!.finalText.split('Let me look at that for you.').length - 1, 1) // the repeat is in neither
})

Deno.test('parity: after a retried call, only the attempt that streamed is kept and stored', async () => {
  const r = await run([new AiCallError('busy', 'overloaded'), finalRound('Sam owes Tim £12.50 in total.')])
  assertEquals(r.error, undefined)
  assertEquals(r.result!.finalText, 'Sam owes Tim £12.50 in total.')
  assertEquals(r.result!.finalText, streamed(r.sent))
})

Deno.test('parity: notices and the cut-short marker are streamed and kept alike', async () => {
  const cut = await run([[start(), ...textBlock(0, 'Sam owes Tim '), end('max_tokens')]])
  assertEquals(cut.result!.finalText, streamed(cut.sent))
  assert(cut.result!.finalText.endsWith('(cut short)'))
  const empty = await run([[start(), end('end_turn')]])
  assertEquals(empty.result!.finalText, streamed(empty.sent))
  assert(empty.result!.finalText.length > 0)
})

Deno.test('a refusal written before open_screen ends the turn: no second paragraph about the button', async () => {
  const r = await run([
    toolRound("You can't delete an expense from chat; an organiser can remove it from its screen.", ['o1', 'open_screen', '{"target":"claim","id":null}']),
    finalRound("I've put a button there that opens the expense."),
  ])
  assertEquals(r.bodies.length, 1)
  assertEquals(r.result!.finalText, "You can't delete an expense from chat; an organiser can remove it from its screen.")
  assertEquals(r.result!.finalText, streamed(r.sent))
  // other tools in the round, or a preamble, still get their answer
  const withRead = await run([
    toolRound("You can't do that from chat.", ['b1', 'get_balances', '{}'], ['o1', 'open_screen', '{"target":"settle","id":null}']),
    finalRound('Sam owes Tim £12.50.'),
  ])
  assertEquals(withRead.bodies.length, 2)
  assertEquals(refusalAlreadyGiven('Let me check that for you.'), false)
  assertEquals(refusalAlreadyGiven("I can't"), false)
})
