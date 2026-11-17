// Receipt-parsing model eval (OWNER RUNS THIS; it spends real money).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
//     npx -y deno run -A --node-modules-dir=none scripts/eval-receipts.ts [options]
//
//   --dry-run            list what would run and the estimated spend; calls NO Anthropic API
//   --max-spend <usd>    hard cap (default 1.00). EVERY attempted call (first pass, repair, failures) is charged a conservative
//                        upper bound computed BEFORE it is sent (file size -> input tokens, output = max_tokens); the run stops
//                        before a call whose bound would push the total over the cap. No retries (maxRetries 0).
//   --limit <n>          receipts to use (default 6); --runs <n> repeats per candidate (default 1)
//   --trip <uuid>        only receipts from one trip
//   --candidates <list>  "model@effort,..." (default: sonnet-5 low [baseline], sonnet-5-5 low, sonnet-5-5 medium,
//                        haiku-5-5 low, haiku-5-5 medium)
//   --csv <path>         also write one numeric row per run (no names, no text)
//
// What it does: (0) asks the Models API what each candidate can do (vision, PDF) and drops candidates that cannot;
// selects itemised expenses that have human-corrected expense_line_items AND a stored receipt file; downloads each
// file to a temp dir (never printed or displayed; deleted at the end); re-parses with each candidate through the SAME
// request builder + pipeline the edge function uses (parse-receipt/receiptRequest.ts + pipeline.ts); prints ONLY
// numbers. Receipt contents (names, text, images) are never printed or written.
//
// Golden-set caveat: stored lines came from the v1 parser plus human fixes and may include distributed tax; lines are
// compared on `subtotal` (pre-tax) and the total on expenses.amount. A few mismatches can be the golden set's fault.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { billedUsageOf, createMessage, type AnthropicContentBlock, type AnthropicRequestOptions } from '../supabase/functions/_shared/anthropic.ts'
import { AiCallError } from '../supabase/functions/_shared/aiError.ts'
import { estimateCostUsd, priceEntryFor } from '../supabase/functions/_shared/pricing.ts'
import { runReceiptPipeline } from '../supabase/functions/parse-receipt/pipeline.ts'
import { checkReceiptFile, countPdfPages, toBase64 } from '../supabase/functions/parse-receipt/fileType.ts'
import {
  candidateLabel,
  isTotalCorrect,
  matchLines,
  parseCandidates,
  percentile,
  type Candidate,
} from '../supabase/functions/parse-receipt/evalMetrics.ts'

const DEFAULT_CANDIDATES =
  'claude-sonnet-5@low,claude-sonnet-5-5@low,claude-sonnet-5-5@medium,claude-haiku-5-5@low,claude-haiku-5-5@medium'
/** Planning assumption per model call, from the one logged production parse (6.2k in, 3k out). */
const ASSUMED_CALL = { input_tokens: 6500, output_tokens: 3000 }

/** Prompt overhead we cannot see from the file: ~2 chars per token is a deliberate over-estimate of text. */
const CHARS_PER_TOKEN_UPPER = 2
/** Upper bound for one image's tokens: ~3.75 MP at 28x28 px patches is ~4.8k; doubled for safety. */
const IMAGE_TOKENS_UPPER = 10_000
/** Upper bound per PDF page (text plus page image). */
const PDF_PAGE_TOKENS_UPPER = 5_000

/** Share of receipts expected to need the repair call. */
const ASSUMED_REPAIR_RATE = 0.3

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
  const num = (name: string, dflt: number) => {
    const v = flags.get(name)
    if (v === undefined) return dflt
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
    return n
  }
  return {
    dryRun: flags.has('--dry-run'),
    maxSpend: num('--max-spend', 1),
    limit: Math.floor(num('--limit', 6)),
    runs: Math.floor(num('--runs', 1)),
    trip: typeof flags.get('--trip') === 'string' ? (flags.get('--trip') as string) : null,
    candidates: parseCandidates(typeof flags.get('--candidates') === 'string' ? (flags.get('--candidates') as string) : DEFAULT_CANDIDATES),
    csv: typeof flags.get('--csv') === 'string' ? (flags.get('--csv') as string) : null,
  }
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`)
const sec = (ms: number) => (Number.isNaN(ms) ? 'n/a' : `${(ms / 1000).toFixed(1)}s`)

/**
 * Conservative UPPER BOUND of one call's cost, computed from the request alone, before sending:
 * non-file text at 2 chars/token, each file block at a fixed per-image / per-page ceiling (capped by
 * bytes/2), all input priced as 5-minute cache writes (1.25x), output = max_tokens.
 */
export function callCostUpperBound(o: AnthropicRequestOptions, model: string): number {
  let textChars = 0
  let fileTokens = 0
  const visit = (b: AnthropicContentBlock) => {
    if (b.type === 'text') textChars += b.text.length
    else if (b.type === 'image') fileTokens += Math.min(IMAGE_TOKENS_UPPER, Math.ceil(b.source.data.length / 2))
    else if (b.type === 'document') {
      const raw = Uint8Array.from(atob(b.source.data), (c) => c.charCodeAt(0))
      const pages = Math.max(1, countPdfPages(raw))
      fileTokens += Math.min(pages * PDF_PAGE_TOKENS_UPPER, Math.ceil(b.source.data.length / 2))
    } else textChars += JSON.stringify(b).length
  }
  const blocks = (c: string | AnthropicContentBlock[]) => (typeof c === 'string' ? (textChars += c.length) : c.forEach(visit))
  if (o.system) blocks(o.system)
  for (const m of o.messages) blocks(m.content)
  if (o.output_config?.format) textChars += JSON.stringify(o.output_config.format).length
  const inputUpper = fileTokens + Math.ceil(textChars / CHARS_PER_TOKEN_UPPER)
  return estimateCostUsd({ input_tokens: 0, cache_creation_input_tokens: inputUpper, output_tokens: o.max_tokens }, model)
}

function assumedCallCost(model: string) {
  return estimateCostUsd(ASSUMED_CALL, model)
}
/** Expected spend for one run of a candidate: one call plus the repair call for some receipts. */
function assumedRunCost(model: string) {
  return assumedCallCost(model) * (1 + ASSUMED_REPAIR_RATE)
}

// ---------------------------------------------------------------------------
// Step 0: capabilities
// ---------------------------------------------------------------------------

interface Capability {
  vision: boolean
  /** true / false when the Models API reports it, null when it does not. */
  pdf: boolean | null
}

async function fetchCapabilities(model: string, apiKey: string): Promise<Capability | { error: string }> {
  const r = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) return { error: `Models API ${r.status}` }
  const body = await r.json()
  const caps = body?.capabilities ?? {}
  return {
    vision: caps?.image_input?.supported === true,
    pdf: typeof caps?.pdf_input?.supported === 'boolean' ? caps.pdf_input.supported : null,
  }
}

// ---------------------------------------------------------------------------
// Golden set
// ---------------------------------------------------------------------------

interface GoldenReceipt {
  expenseId: string
  amount: number
  currency: string
  receiptPath: string
  lines: { names: string[]; amount: number }[]
}

// deno-lint-ignore no-explicit-any
async function loadGolden(supabase: any, trip: string | null, limit: number): Promise<GoldenReceipt[]> {
  const { data: lineRows, error: lineErr } = await supabase
    .from('expense_line_items')
    .select('expense_id, name_original, name_english, subtotal')
    .limit(20000)
  if (lineErr) throw new Error(`line items query failed: ${lineErr.message}`)
  const byExpense = new Map<string, GoldenReceipt['lines']>()
  for (const l of lineRows ?? []) {
    const arr = byExpense.get(l.expense_id) ?? []
    arr.push({ names: [l.name_original, l.name_english].filter(Boolean), amount: Number(l.subtotal) })
    byExpense.set(l.expense_id, arr)
  }
  const ids = [...byExpense.keys()]
  const out: GoldenReceipt[] = []
  for (let i = 0; i < ids.length; i += 100) {
    let q = supabase
      .from('expenses')
      .select('id, amount, currency, receipt_url, trip_id')
      .in('id', ids.slice(i, i + 100))
      .not('receipt_url', 'is', null)
    if (trip) q = q.eq('trip_id', trip)
    const { data, error } = await q
    if (error) throw new Error(`expenses query failed: ${error.message}`)
    for (const e of data ?? []) {
      // receipt_url is normally a storage path; tolerate a full URL.
      const path = String(e.receipt_url).replace(/^.*\/receipts\//, '')
      out.push({ expenseId: e.id, amount: Number(e.amount), currency: e.currency, receiptPath: path, lines: byExpense.get(e.id)! })
    }
  }
  out.sort((a, b) => a.expenseId.localeCompare(b.expenseId))
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------

interface RunRow {
  receipt: number
  candidate: string
  run: number
  ok: boolean
  errorCode: string
  totalOk: boolean
  currencyOk: boolean
  recall: number
  precision: number
  stored: number
  parsed: number
  reconciled: boolean
  repairAttempted: boolean
  repairAdopted: boolean
  latencyMs: number
  inTokens: number
  outTokens: number
  cost: number
}

class StopEval extends Error {}

async function main() {
  const args = parseArgs(Deno.args)
  const supaUrl = Deno.env.get('SUPABASE_URL')
  const supaKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')

  console.log(`mode: ${args.dryRun ? 'DRY RUN (no Anthropic calls)' : 'LIVE'}   max-spend: ${money(args.maxSpend)}   receipts<=${args.limit}   runs/candidate: ${args.runs}`)
  console.log(`candidates: ${args.candidates.map(candidateLabel).join(', ')}`)

  // Golden set (Supabase only; read-only).
  let golden: GoldenReceipt[] = []
  // deno-lint-ignore no-explicit-any
  let supabase: any = null
  if (supaUrl && supaKey) {
    supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })
    golden = await loadGolden(supabase, args.trip, args.limit)
    console.log(`golden set: ${golden.length} itemised receipts with a stored file`)
  } else if (args.dryRun) {
    console.log(`golden set: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; dry run assumes ${args.limit} receipts`)
  } else {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }

  const receiptCount = golden.length || args.limit

  // Step 0: capabilities (live only).
  let candidates: Candidate[] = args.candidates
  if (!args.dryRun) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required')
    console.log('\nstep 0: model capabilities (Models API)')
    const kept: Candidate[] = []
    const seen = new Map<string, Capability | { error: string }>()
    for (const c of candidates) {
      if (!seen.has(c.model)) seen.set(c.model, await fetchCapabilities(c.model, apiKey))
      const cap = seen.get(c.model)!
      if ('error' in cap) {
        console.log(`  ${candidateLabel(c)}: ABORTED (${cap.error})`)
      } else if (!cap.vision) {
        console.log(`  ${candidateLabel(c)}: ABORTED (no image input)`)
      } else if (cap.pdf === false) {
        console.log(`  ${candidateLabel(c)}: ABORTED (no PDF input)`)
      } else {
        console.log(`  ${candidateLabel(c)}: vision yes, pdf ${cap.pdf === null ? 'not reported (PDF receipts judged by their results)' : 'yes'}`)
        kept.push(c)
      }
    }
    candidates = kept
    if (candidates.length === 0) throw new Error('no candidate passed the capability check')
  }

  // Plan + estimate.
  const estimate = candidates.reduce((s, c) => s + assumedRunCost(c.model) * receiptCount * args.runs, 0)
  console.log('\nplan')
  for (const c of candidates) {
    const known = priceEntryFor(c.model).known
    console.log(`  ${candidateLabel(c)}: ${receiptCount * args.runs} runs, ~${money(assumedRunCost(c.model))}/run${known ? '' : ' (price unknown: conservative)'}`)
  }
  console.log(`  estimated spend: ${money(estimate)}   cap: ${money(args.maxSpend)}${estimate > args.maxSpend ? '   (the cap will stop the run early)' : ''}`)
  if (args.dryRun) {
    console.log('\ndry run finished: nothing was downloaded or sent.')
    return
  }
  if (golden.length === 0) throw new Error('golden set is empty')

  // Download to a temp dir (never printed).
  const dir = await Deno.makeTempDir({ prefix: 'receipt-eval-' })
  const files: (string | null)[] = []
  try {
    let dl = 0
    for (const g of golden) {
      const { data, error } = await supabase.storage.from('receipts').download(g.receiptPath)
      if (error || !data) {
        files.push(null)
        continue
      }
      const file = `${dir}/${files.length}`
      await Deno.writeFile(file, new Uint8Array(await data.arrayBuffer()))
      files.push(file)
      dl++
    }
    console.log(`\ndownloaded ${dl}/${golden.length} receipt files to a temp dir (not displayed)`)

    // Spend tracking: every model call is checked BEFORE it is sent.
    let spent = 0
    const rows: RunRow[] = []
    let stopped = false

    for (let r = 0; r < golden.length && !stopped; r++) {
      const path = files[r]
      if (!path) continue
      const bytes = await Deno.readFile(path)
      let fileBlock: AnthropicContentBlock
      try {
        const type = checkReceiptFile(bytes, null, golden[r].receiptPath)
        const b64 = toBase64(bytes)
        fileBlock = type === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
          : { type: 'image', source: { type: 'base64', media_type: type, data: b64 } }
      } catch {
        continue // unsupported/too large for production too: skip
      }

      for (let run = 1; run <= args.runs && !stopped; run++) {
        for (const c of candidates) {
          const label = candidateLabel(c)
          let runCost = 0
          let runIn = 0
          let runOut = 0
          const guardedCall = async (o: AnthropicRequestOptions) => {
            // Upper bound BEFORE the call; reserved until the real cost is known. A throw (timeout,
            // 429, max_tokens, ...) keeps the bound unless the error reports the real usage.
            const bound = callCostUpperBound(o, o.model ?? c.model)
            if (spent + bound > args.maxSpend) {
              stopped = true
              throw new StopEval()
            }
            spent += bound
            try {
              // maxRetries: 0 -> every attempt is one call that this guard has already counted.
              const resp = await createMessage({ ...o, apiKey, maxRetries: 0 })
              const cost = estimateCostUsd(resp.usage, resp.model)
              spent += cost - bound
              runCost += cost
              runIn += resp.usage.input_tokens + (resp.usage.cache_read_input_tokens ?? 0) + (resp.usage.cache_creation_input_tokens ?? 0)
              runOut += resp.usage.output_tokens
              return resp
            } catch (err) {
              const billed = billedUsageOf(err)
              if (billed) {
                const cost = estimateCostUsd(billed.usage, billed.model)
                spent += cost - bound
                runCost += cost
              } else {
                runCost += bound // unknown: stays charged at the bound
              }
              throw err
            }
          }

          const g = golden[r]
          const t0 = performance.now()
          const row: RunRow = {
            receipt: r + 1, candidate: label, run, ok: false, errorCode: '', totalOk: false, currencyOk: false,
            recall: 0, precision: 0, stored: g.lines.length, parsed: 0, reconciled: false,
            repairAttempted: false, repairAdopted: false, latencyMs: 0, inTokens: 0, outTokens: 0, cost: 0,
          }
          try {
            const res = await runReceiptPipeline(fileBlock, { model: c.model, effort: c.effort, call: guardedCall as typeof createMessage })
            const m = matchLines(
              g.lines,
              res.parsed.line_items.map((l) => ({ names: [l.name_original, l.name_english ?? ''].filter(Boolean), amount: l.line_total })),
              g.currency,
            )
            row.ok = true
            row.currencyOk = res.parsed.currency === g.currency
            row.totalOk = row.currencyOk && isTotalCorrect(res.parsed.total, g.amount, g.currency)
            row.recall = m.recall
            row.precision = m.precision
            row.parsed = m.parsedCount
            row.reconciled = res.reconciliation.reconciled
            row.repairAttempted = res.repairAttempted
            row.repairAdopted = res.repairAdopted
          } catch (err) {
            if (err instanceof StopEval || stopped) {
              stopped = true
              break
            }
            row.errorCode = err instanceof AiCallError ? err.code : 'error'
          }
          row.latencyMs = performance.now() - t0
          row.cost = runCost
          row.inTokens = runIn
          row.outTokens = runOut
          rows.push(row)
        }
      }
    }

    // Report (numbers only).
    console.log(`\nresults: ${rows.length} runs, spent ${money(spent)} of ${money(args.maxSpend)} cap${stopped ? '   STOPPED EARLY by --max-spend' : ''}`)
    for (const c of candidates) {
      const label = candidateLabel(c)
      const rs = rows.filter((x) => x.candidate === label)
      const ok = rs.filter((x) => x.ok)
      const sum = (f: (x: RunRow) => number) => ok.reduce((s, x) => s + f(x), 0)
      const storedLines = sum((x) => x.stored)
      const recalled = ok.reduce((s, x) => s + x.recall * x.stored, 0)
      const parsedLines = sum((x) => x.parsed)
      const precise = ok.reduce((s, x) => s + x.precision * x.parsed, 0)
      const lat = ok.map((x) => x.latencyMs)
      const errCodes = new Map<string, number>()
      for (const x of rs.filter((y) => !y.ok)) errCodes.set(x.errorCode, (errCodes.get(x.errorCode) ?? 0) + 1)
      console.log(`\n${label}`)
      console.log(`  receipts parsed        ${ok.length}/${rs.length}${errCodes.size ? `   errors: ${[...errCodes].map(([k, v]) => `${k} x${v}`).join(', ')}` : ''}`)
      console.log(`  total correct          ${pct(ok.filter((x) => x.totalOk).length, ok.length)}`)
      console.log(`  line recall            ${pct(recalled, storedLines)}   precision ${pct(precise, parsedLines)}`)
      console.log(`  reconciled             ${pct(ok.filter((x) => x.reconciled).length, ok.length)}`)
      console.log(`  repair attempted/adopted ${pct(ok.filter((x) => x.repairAttempted).length, ok.length)} / ${pct(ok.filter((x) => x.repairAdopted).length, ok.length)}`)
      console.log(`  latency p50 / p95      ${sec(percentile(lat, 50))} / ${sec(percentile(lat, 95))}`)
      console.log(`  tokens in / out        ${rs.reduce((s, x) => s + x.inTokens, 0)} / ${rs.reduce((s, x) => s + x.outTokens, 0)}`)
      console.log(`  estimated cost         ${money(rs.reduce((s, x) => s + x.cost, 0))}`)
    }

    if (args.csv) {
      const head = 'receipt,candidate,run,ok,error,total_ok,currency_ok,recall,precision,stored_lines,parsed_lines,reconciled,repair_attempted,repair_adopted,latency_ms,in_tokens,out_tokens,cost_usd'
      const lines = rows.map((x) =>
        [x.receipt, x.candidate, x.run, x.ok, x.errorCode, x.totalOk, x.currencyOk, x.recall.toFixed(3), x.precision.toFixed(3), x.stored, x.parsed,
          x.reconciled, x.repairAttempted, x.repairAdopted, Math.round(x.latencyMs), x.inTokens, x.outTokens, x.cost.toFixed(5)].join(',')
      )
      await Deno.writeTextFile(args.csv, [head, ...lines].join('\n') + '\n')
      console.log(`\nper-run numbers written to ${args.csv} (no names or text)`)
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

if (import.meta.main) {
  main().catch((e) => {
    // Message only: never a stack that could embed a request body.
    console.error('eval failed:', e instanceof Error ? e.message : 'unknown error')
    Deno.exit(1)
  })
}
