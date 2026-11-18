// Trip-chat assistant eval (OWNER RUNS THIS; it spends real money).
//
//   ANTHROPIC_API_KEY=... npx -y deno run -A --node-modules-dir=none scripts/eval-trip-chat.ts [options]
//
//   --dry-run            DEFAULT. Prints the plan and the estimated cost, calls NO API, exits. A paid run needs --run.
//   --run                actually call the Anthropic API (needs ANTHROPIC_API_KEY in the environment; nothing else is read)
//   --max-spend <usd>    hard cap (default 5.00). EVERY attempted call is charged a conservative upper bound computed BEFORE it
//                        is sent (request chars -> input tokens priced as cache writes, output = max_tokens); the run stops
//                        before a call whose bound would push the total over the cap. No retries (maxRetries 0).
//   --only <prefix>      only cases whose id or group starts with this (e.g. "injection", "todo-")
//   --model <id>         model under test (default claude-sonnet-5-5); --effort low|medium|high (default low)
//   --csv <path>         also write one numeric row per case (no text)
//   --no-nudge           turn off the "never end a turn with a button and no facts" continuation (loop.ts answerNudgeNeeded) to
//                        measure what the prompt alone achieves. By default the eval applies the same rule the edge function does,
//                        once per turn, and prints "nudged" for a case where it fired.
//
// What it does: replays scripted conversations (scripts/fixtures/trip-chat/cases.json) against a frozen fixture trip
// (trip.json). The request is built from the SAME tool list, system prompt and capability text the edge function uses
// (supabase/functions/trip-chat/{registry,prompt,context}.ts). Read tools answer from the fixture; propose_* tools and
// open_screen only RECORD what the model asked for (nothing is written anywhere, no database, no Supabase client).
// Grading is deterministic: proposed tool + input fields, no-action / no-link / forbidden tools, required facts in the
// answer, and no raw snake_case names or uuids in the answer.
//
// Privacy / safety: the API key is read only from ANTHROPIC_API_KEY and never printed. Output contains only case ids,
// pass/fail, the fixture's own check labels, token counts and cost. The model's text is NEVER printed or written.

import { billedUsageOf, createMessage, type AnthropicContentBlock, type AnthropicMessage, type AnthropicRequestOptions } from '../supabase/functions/_shared/anthropic.ts'
import { estimateCostUsd, priceEntryFor } from '../supabase/functions/_shared/pricing.ts'
import { buildToolDefs, TOOL_BY_NAME } from '../supabase/functions/trip-chat/registry.ts'
import { normalizeToolInput } from '../supabase/functions/trip-chat/toolSchema.ts'
import { STATIC_SYSTEM, tripBlock } from '../supabase/functions/trip-chat/prompt.ts'
import { capabilitiesText, CONTEXT_FOOTER } from '../supabase/functions/trip-chat/context.ts'
import * as chatLoop from '../supabase/functions/trip-chat/loop.ts'
import { CHAT_MAX_TOKENS } from '../supabase/functions/trip-chat/loop.ts'
import { formatOpenParam, TARGET_LABELS, type OpenTargetName } from '../supabase/functions/trip-chat/tools/propose/deepLinks.ts'
import * as openScreenTool from '../supabase/functions/trip-chat/tools/propose/openScreen.ts'

const FIXTURE_DIR = new URL('./fixtures/trip-chat/', import.meta.url)
const DEFAULT_MODEL = 'claude-sonnet-5-5'
const MAX_ITERATIONS = 6
const MAX_ACTIONS_PER_TURN = 5
const CHARS_PER_TOKEN_UPPER = 2
/** Planning assumption per model call (prompt mostly cached): used only for the dry-run estimate. */
const ASSUMED_CALL = { input_tokens: 2000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 900 }
const ASSUMED_CALLS_PER_TURN = 2.5

const PROPOSE_PREFIX = 'propose_'
const OPEN_SCREEN = 'open_screen'

// ---------------------------------------------------------------------------
// Types (fixtures)
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

interface Expect {
  actions?: { tool: string; input: Record<string, Json> }[]
  noActions?: boolean
  link?: Record<string, Json>
  noLink?: boolean
  noTools?: string[]
  answerIncludes?: string[]
  answerIncludesAny?: string[][]
  answerExcludes?: string[]
}
interface Turn { say: string; expect?: Expect }
interface Case { id: string; group: string; as: 'organiser' | 'participant'; turns: Turn[] }
interface Fixture {
  today: string
  trip: Record<string, unknown> & { start_date: string; end_date: string; name: string; location: string | null; base_currency: string }
  stage: string
  roster: { userId: string; name: string; role: string | null; active: boolean; confirmationStatus: string | null }[]
  viewers: Record<string, { userId: string; name: string; canManageTrip: boolean; isSiteAdmin: boolean; isOnRoster: boolean; isComing: boolean; isOut: boolean }>
  context: Record<string, string[]>
  reads: Record<string, unknown>
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a, next)
      i++
    } else flags.set(a, true)
  }
  const str = (name: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : null)
  const maxSpend = flags.has('--max-spend') ? Number(flags.get('--max-spend')) : 5
  if (!Number.isFinite(maxSpend) || maxSpend <= 0) throw new Error('--max-spend must be a positive number')
  const effort = str('--effort') ?? 'low'
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('--effort must be low, medium or high')
  // Dry run is the default: spending needs the explicit --run.
  const live = flags.has('--run') && !flags.has('--dry-run')
  return {
    dryRun: !live,
    maxSpend,
    only: str('--only'),
    model: str('--model') ?? DEFAULT_MODEL,
    effort: effort as 'low' | 'medium' | 'high',
    csv: str('--csv'),
    nudge: !flags.has('--no-nudge'),
  }
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

/**
 * The shared client keeps only "http 400 invalid_request_error" in its error. A 4xx from the API means the request
 * itself is wrong (a bad tool schema, say) and every following call will fail the same way, so remember the API's
 * own message (it describes the request shape, never a key) and abort the run on the first one.
 */
let lastClientError: string | null = null
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init)
  if (res.status >= 400 && res.status < 500 && String(input instanceof Request ? input.url : input).includes('api.anthropic.com')) {
    try {
      const body = await res.clone().json()
      lastClientError = `HTTP ${res.status} ${body?.error?.type ?? ''}: ${String(body?.error?.message ?? '').slice(0, 600)}`
    } catch {
      lastClientError = `HTTP ${res.status} (unreadable body)`
    }
  }
  return res
}

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(new URL(name, FIXTURE_DIR))) as T
}

// ---------------------------------------------------------------------------
// Request building (mirrors the edge function)
// ---------------------------------------------------------------------------

function buildSystem(fx: Fixture): AnthropicContentBlock[] {
  return [
    { type: 'text', text: STATIC_SYSTEM },
    { type: 'text', text: tripBlock(fx.trip as never, fx.roster, fx.stage), cache_control: { type: 'ephemeral' } },
  ]
}

function contextBlock(fx: Fixture, c: Case): string {
  const viewer = fx.viewers[c.as]
  return [
    '[Context]',
    `Today: ${fx.today} (UTC). Talking to: ${viewer.name}.`,
    capabilitiesText(viewer, true, false),
    ...(fx.context[c.as] ?? []),
    CONTEXT_FOOTER,
  ].join('\n')
}

/** Upper bound of one call's cost from the request alone, before sending. */
function callCostUpperBound(o: AnthropicRequestOptions, model: string): number {
  const chars = JSON.stringify(o.system ?? '').length + JSON.stringify(o.messages).length + JSON.stringify(o.tools ?? []).length
  const inputUpper = Math.ceil(chars / CHARS_PER_TOKEN_UPPER)
  return estimateCostUsd({ input_tokens: 0, cache_creation_input_tokens: inputUpper, output_tokens: o.max_tokens }, model)
}

// ---------------------------------------------------------------------------
// Fixture tool executor
// ---------------------------------------------------------------------------

interface Recorded { tool: string; input: Record<string, unknown> }

/** The result the real open_screen returns (same builder as the edge function when this checkout has it). */
function openScreenResult(input: Record<string, unknown>): string {
  const target = String(input.target ?? '') as OpenTargetName
  const id = typeof input.id === 'string' ? input.id : null
  const build = (openScreenTool as { openScreenResultContent?: (t: OpenTargetName, id: string | null) => unknown }).openScreenResultContent
  if (build) return JSON.stringify(build(target, id))
  return JSON.stringify({ ok: true, link: { label: TARGET_LABELS[target] ?? target, target, open_param: formatOpenParam(target, id) } })
}

function readFromFixture(fx: Fixture, name: string, input: Record<string, unknown>, as: string): { content: string; is_error?: boolean } {
  const entry = fx.reads[name] as { $by?: string; $viewer?: Record<string, unknown>; values?: Record<string, unknown> } | undefined
  if (entry && typeof entry === 'object' && entry.$viewer) return { content: JSON.stringify(entry.$viewer[as] ?? { ok: false, error: 'No data for this person.' }) }
  if (entry === undefined) return { content: JSON.stringify({ ok: false, error: 'No data for this tool in the eval fixture.' }), is_error: true }
  if (entry && typeof entry === 'object' && '$by' in entry && entry.$by && entry.values) {
    const hit = entry.values[String(input[entry.$by])]
    return hit === undefined ? { content: JSON.stringify({ ok: false, error: 'That id is not on this trip.' }), is_error: true } : { content: JSON.stringify(hit) }
  }
  return { content: JSON.stringify(entry) }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Subset match: objects match on the expected keys; {includes}/{oneOf} are matchers; arrays match as sets of the same size. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const e = expected as Record<string, unknown>
    if ('includes' in e) return typeof actual === 'string' && actual.toLowerCase().includes(String(e.includes).toLowerCase())
    if ('oneOf' in e) return (e.oneOf as unknown[]).some((o) => matches(o, actual))
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(e).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]))
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((x) => actual.some((y) => matches(x, y)))
  }
  return deepEq(expected, actual)
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
/** Internal names (enums, tool names, field names) are snake_case; ordinary words never are. */
const SNAKE_RE = /\b[a-z]+(?:_[a-z0-9]+)+\b/

function grade(expect: Expect | undefined, calls: Recorded[], answer: string): { passed: string[]; failed: string[] } {
  const passed: string[] = []
  const failed: string[] = []
  const check = (label: string, ok: boolean) => (ok ? passed : failed).push(label)
  const lower = answer.toLowerCase()
  const proposes = calls.filter((c) => c.tool.startsWith(PROPOSE_PREFIX))
  const links = calls.filter((c) => c.tool === OPEN_SCREEN)

  check('answer has no internal names', !SNAKE_RE.test(answer))
  check('answer has no ids', !UUID_RE.test(answer))
  check('answer is not empty', answer.trim().length > 0)
  const e = expect ?? {}
  for (const a of e.actions ?? []) {
    check(`proposes ${a.tool} ${JSON.stringify(a.input)}`, calls.some((c) => c.tool === a.tool && matches(a.input, c.input)))
  }
  if (e.noActions) check('proposes nothing', proposes.length === 0)
  if (e.link) check(`links ${JSON.stringify(e.link)}`, links.some((c) => matches(e.link, c.input)))
  if (e.noLink) check('no link card', links.length === 0)
  for (const t of e.noTools ?? []) check(`does not call ${t}`, !calls.some((c) => c.tool === t))
  for (const s of e.answerIncludes ?? []) check(`answer includes "${s}"`, lower.includes(s.toLowerCase()))
  for (const group of e.answerIncludesAny ?? []) check(`answer includes one of ${JSON.stringify(group)}`, group.some((s) => lower.includes(s.toLowerCase())))
  for (const s of e.answerExcludes ?? []) check(`answer excludes "${s}"`, !lower.includes(s.toLowerCase()))
  return { passed, failed }
}

// ---------------------------------------------------------------------------

class StopEval extends Error {}

interface CaseRow { nudged: number; id: string; group: string; passedChecks: number; failedChecks: number; ok: boolean; calls: number; inTokens: number; outTokens: number; cost: number; latencyMs: number }

async function main() {
  const args = parseArgs(Deno.args)
  const fx = await loadJson<Fixture>('trip.json')
  const all = (await loadJson<{ cases: Case[] }>('cases.json')).cases
  const cases = args.only ? all.filter((c) => c.id.startsWith(args.only!) || c.group.startsWith(args.only!)) : all
  if (cases.length === 0) throw new Error('no cases selected')

  const tools = buildToolDefs()
  const readNames = tools.map((t) => t.name).filter((n) => !n.startsWith(PROPOSE_PREFIX) && n !== OPEN_SCREEN && n !== 'propose_actions')
  const unmapped = readNames.filter((n) => !(n in fx.reads))
  const turns = cases.reduce((s, c) => s + c.turns.length, 0)
  const perCall = estimateCostUsd(ASSUMED_CALL, args.model)
  const estimate = perCall * ASSUMED_CALLS_PER_TURN * turns

  console.log(`mode: ${args.dryRun ? 'DRY RUN (no Anthropic calls; add --run to spend)' : 'LIVE'}   max-spend: ${money(args.maxSpend)}   model: ${args.model}@${args.effort}`)
  console.log(`plan: ${cases.length} cases, ${turns} user turns, ${tools.length} tools declared`)
  const groups = new Map<string, number>()
  for (const c of cases) groups.set(c.group, (groups.get(c.group) ?? 0) + 1)
  console.log(`  groups: ${[...groups].map(([g, n]) => `${g} x${n}`).join(', ')}`)
  if (unmapped.length) console.log(`  note: read tools with no fixture data (they will answer "no data"): ${unmapped.join(', ')}`)
  console.log(`  estimated spend: ${money(estimate)} (~${ASSUMED_CALLS_PER_TURN} calls/turn at ~${money(perCall)}${priceEntryFor(args.model).known ? '' : ', price unknown: conservative'})   cap: ${money(args.maxSpend)}${estimate > args.maxSpend ? '   (the cap will stop the run early)' : ''}`)
  if (args.dryRun) {
    for (const c of cases) console.log(`  - ${c.id} [${c.group}, ${c.as}] ${c.turns.length} turn(s)`)
    console.log('\ndry run finished: no API was called.')
    return
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for a live run')

  const system = buildSystem(fx)
  let spent = 0
  let stopped = false
  let fatal = false
  const rows: CaseRow[] = []

  for (const c of cases) {
    if (stopped) break
    const t0 = performance.now()
    const row: CaseRow = { nudged: 0, id: c.id, group: c.group, passedChecks: 0, failedChecks: 0, ok: false, calls: 0, inTokens: 0, outTokens: 0, cost: 0, latencyMs: 0 }
    const failures: string[] = []
    const conversation: AnthropicMessage[] = []
    try {
      for (let ti = 0; ti < c.turns.length; ti++) {
        const turn = c.turns[ti]
        conversation.push({ role: 'user', content: [{ type: 'text', text: contextBlock(fx, c) }, { type: 'text', text: turn.say }] })
        const recorded: Recorded[] = []
        let answer = ''
        let finished = false
        let nudgedThisTurn = false
        for (let it = 0; it < MAX_ITERATIONS && !finished; it++) {
          const opts: AnthropicRequestOptions = {
            model: args.model,
            max_tokens: CHAT_MAX_TOKENS,
            system,
            messages: conversation,
            tools: tools as never,
            output_config: { effort: args.effort },
            apiKey,
            maxRetries: 0,
          }
          const bound = callCostUpperBound(opts, args.model)
          if (spent + bound > args.maxSpend) {
            stopped = true
            throw new StopEval()
          }
          spent += bound
          let resp
          try {
            resp = await createMessage(opts)
          } catch (err) {
            const billed = billedUsageOf(err)
            if (billed) {
              const cost = estimateCostUsd(billed.usage, billed.model)
              spent += cost - bound
              row.cost += cost
            } else row.cost += bound
            throw err
          }
          const cost = estimateCostUsd(resp.usage, resp.model)
          spent += cost - bound
          row.cost += cost
          row.calls++
          row.inTokens += resp.usage.input_tokens + (resp.usage.cache_read_input_tokens ?? 0) + (resp.usage.cache_creation_input_tokens ?? 0)
          row.outTokens += resp.usage.output_tokens

          for (const b of resp.content) if (b.type === 'text') answer += (answer ? '\n\n' : '') + b.text
          const uses = resp.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          if (resp.stop_reason === 'tool_use' && uses.length > 0) {
            conversation.push({ role: 'assistant', content: resp.content })
            const results: AnthropicContentBlock[] = uses.map((u) => {
              // The edge function normalises the model's input (omitted optional -> null) before the tool sees it: grade that.
              const schema = TOOL_BY_NAME.get(u.name)?.inputSchema
              const input = (schema ? normalizeToolInput(schema, u.input ?? {}) : (u.input ?? {})) as Record<string, unknown>
              if (u.name.startsWith(PROPOSE_PREFIX) || u.name === OPEN_SCREEN) {
                recorded.push({ tool: u.name, input })
                const proposals = recorded.filter((r) => r.tool.startsWith(PROPOSE_PREFIX)).length
                if (proposals > MAX_ACTIONS_PER_TURN) return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ ok: false, error: 'Too many actions this turn.' }), is_error: true }
                if (u.name === OPEN_SCREEN) return { type: 'tool_result', tool_use_id: u.id, content: openScreenResult(input) } // same content as the real open_screen result
                return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ ok: true, note: 'Stored. The person will see a card and must tap Confirm.' }) }
              }
              recorded.push({ tool: u.name, input })
              const r = readFromFixture(fx, u.name, input, c.as)
              return { type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) }
            })
            conversation.push({ role: 'user', content: results })
          } else {
            conversation.push({ role: 'assistant', content: resp.content })
            const { answerNudgeNeeded, answerNudgeMessage } = chatLoop as Partial<typeof chatLoop>
            const text = answer
            const linkTargets = recorded.filter((r) => r.tool === OPEN_SCREEN).map((r) => String(r.input.target ?? ''))
            if (args.nudge && answerNudgeNeeded && answerNudgeMessage && !nudgedThisTurn && resp.stop_reason === 'end_turn' && it < MAX_ITERATIONS - 1
              && answerNudgeNeeded({ toolsUsed: recorded.map((r) => r.tool), linkTargets, text })) {
              nudgedThisTurn = true
              row.nudged++
              conversation.push(answerNudgeMessage(args.model))
            } else finished = true
          }
        }
        if (!finished) failures.push(`turn ${ti + 1}: tool rounds used up`)
        const g = grade(turn.expect, recorded, answer)
        row.passedChecks += g.passed.length
        row.failedChecks += g.failed.length + (finished ? 0 : 1)
        for (const f of g.failed) failures.push(`turn ${ti + 1}: ${f}`)
        if (g.failed.length) failures.push(`turn ${ti + 1}: tools called: ${recorded.map((r) => r.tool).join(', ') || '(none)'}; answer length ${answer.trim().length} chars`)
      }
      row.ok = row.failedChecks === 0
    } catch (err) {
      if (err instanceof StopEval || stopped) {
        stopped = true
      } else if (lastClientError) {
        // First 4xx: stop spending, say why.
        console.error(`\nABORT: the API rejected the request, so the rest of the run would fail the same way.\n  ${lastClientError}`)
        fatal = true
        stopped = true
        row.failedChecks++
        failures.push(`error: ${lastClientError}`)
      } else {
        row.failedChecks++
        failures.push(`error: ${err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'call failed'}`)
      }
    }
    row.latencyMs = performance.now() - t0
    if (!stopped || row.calls > 0) rows.push(row)
    console.log(`${row.ok ? 'PASS' : stopped && row.calls === 0 ? 'SKIP' : 'FAIL'}  ${c.id}  (${row.calls} calls, ${money(row.cost)}${row.nudged ? `, nudged x${row.nudged}` : ''})`)
    for (const f of failures) console.log(`      - ${f}`)
  }

  const ok = rows.filter((r) => r.ok).length
  console.log(`\nresults: ${ok}/${rows.length} cases passed, spent ${money(spent)} of ${money(args.maxSpend)} cap${stopped ? '   STOPPED EARLY by --max-spend' : ''}`)
  for (const g of new Set(rows.map((r) => r.group))) {
    const rs = rows.filter((r) => r.group === g)
    console.log(`  ${g.padEnd(10)} ${rs.filter((r) => r.ok).length}/${rs.length}`)
  }
  console.log(`  tokens in / out  ${rows.reduce((s, r) => s + r.inTokens, 0)} / ${rows.reduce((s, r) => s + r.outTokens, 0)}`)
  console.log(`  estimated cost   ${money(rows.reduce((s, r) => s + r.cost, 0))}`)

  if (args.csv) {
    const head = 'case,group,ok,checks_passed,checks_failed,calls,in_tokens,out_tokens,cost_usd,latency_ms'
    const lines = rows.map((r) => [r.id, r.group, r.ok, r.passedChecks, r.failedChecks, r.calls, r.inTokens, r.outTokens, r.cost.toFixed(5), Math.round(r.latencyMs)].join(','))
    await Deno.writeTextFile(args.csv, [head, ...lines].join('\n') + '\n')
    console.log(`\nper-case numbers written to ${args.csv} (no text)`)
  }
  if (fatal) Deno.exit(2)
}

if (import.meta.main) {
  main().catch((e) => {
    // Message only: never a stack that could embed a request body.
    console.error('eval failed:', e instanceof Error ? e.message : 'unknown error')
    Deno.exit(1)
  })
}
