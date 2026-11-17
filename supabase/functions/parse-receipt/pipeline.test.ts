import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import { BilledAiCallError, billedUsageOf } from '../_shared/anthropic.ts'
import type { AnthropicRequestOptions, AnthropicResponse } from '../_shared/anthropic.ts'
import type { ReceiptParseResult } from '../_shared/contracts/receiptParseResult.ts'
import { runReceiptPipeline } from './pipeline.ts'
import { buildReceiptRequest, RECEIPT_SYSTEM_PROMPT } from './receiptRequest.ts'

const FILE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg', data: 'AAAA' } }

function receipt(total: number): ReceiptParseResult {
  return {
    vendor_name: 'Cafe', vendor_name_english: null, vendor_address: null, receipt_date: '2026-06-01', currency: 'GBP',
    line_items: [
      { line_number: 1, name_original: 'Tea', name_english: null, quantity: 1, unit_price: 3, line_total: 3, printed_field: 'both', discounts: [] },
      { line_number: 2, name_original: 'Cake', name_english: null, quantity: 1, unit_price: 5, line_total: 5, printed_field: 'both', discounts: [] },
    ],
    tax: [], service_charge: null, tip: null, discounts: [], rounding_adjustment: null,
    subtotal: 8, total, confidence: [], notes: null,
  }
}
const reply = (r: ReceiptParseResult | string, usage = { input_tokens: 100, output_tokens: 50 }): AnthropicResponse => ({
  id: 'm', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage,
  content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }],
})

function fake(replies: Array<AnthropicResponse | Error>) {
  const seen: AnthropicRequestOptions[] = []
  const call = (o: AnthropicRequestOptions) => {
    seen.push(o)
    const n = replies.shift()!
    return n instanceof Error ? Promise.reject(n) : Promise.resolve(n)
  }
  return { seen, call: call as never }
}

Deno.test('request: model, low effort, schema, cached system prompt, no padding, no forbidden params', () => {
  const req = buildReceiptRequest(FILE)
  assertEquals(req.model, 'claude-sonnet-5-5')
  assertEquals(req.output_config?.effort, 'low')
  assertEquals(req.output_config?.format?.type, 'json_schema')
  const sys = req.system as Array<{ text: string; cache_control?: unknown }>
  assertEquals(sys[0].text, RECEIPT_SYSTEM_PROMPT)
  assert(!sys[0].text.includes('padding'))
  assertEquals(sys[0].cache_control, { type: 'ephemeral' })
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert(!(k in req), k)
})

Deno.test('overrides: model and effort flow through (what the eval uses)', () => {
  const req = buildReceiptRequest(FILE, { model: 'claude-haiku-5-5', effort: 'medium' })
  assertEquals([req.model, req.output_config?.effort], ['claude-haiku-5-5', 'medium'])
})

Deno.test('reconciles first time: one call, no repair', async () => {
  const f = fake([reply(receipt(8))])
  const r = await runReceiptPipeline(FILE, { call: f.call })
  assertEquals([r.reconciliation.reconciled, r.repairAttempted, f.seen.length], [true, false, 1])
})

Deno.test('does not reconcile: ONE repair, adopted only if it reconciles, usage summed', async () => {
  const f = fake([reply(receipt(9.5), { input_tokens: 100, output_tokens: 50 }), reply(receipt(8), { input_tokens: 10, output_tokens: 5 })])
  const r = await runReceiptPipeline(FILE, { call: f.call })
  assertEquals([r.repairAttempted, r.repairAdopted, r.reconciliation.reconciled, r.parsed.total], [true, true, true, 8])
  assertEquals([r.usage.input_tokens, r.usage.output_tokens], [110, 55])
  assertEquals(f.seen.length, 2)
  assertEquals(f.seen[1].messages.length, 3) // user, assistant (previous JSON), repair prompt
})

Deno.test('repair that still fails is not adopted; repair that errors keeps the first pass', async () => {
  let f = fake([reply(receipt(9.5)), reply(receipt(9.7))])
  let r = await runReceiptPipeline(FILE, { call: f.call })
  assertEquals([r.repairAttempted, r.repairAdopted, r.parsed.total], [true, false, 9.5])

  f = fake([reply(receipt(9.5)), new AiCallError('busy')])
  r = await runReceiptPipeline(FILE, { call: f.call })
  assertEquals([r.repairAttempted, r.repairAdopted, r.parsed.total, f.seen.length], [true, false, 9.5, 2])
})

Deno.test('first pass: garbage or schema mismatch is the coded unreadable; call errors propagate', async () => {
  for (const bad of ['not json', '{"vendor_name":1}']) {
    const err = await assertRejects(() => runReceiptPipeline(FILE, { call: fake([reply(bad)]).call }), AiCallError)
    assertEquals(err.code, 'unreadable')
  }
  const err = await assertRejects(() => runReceiptPipeline(FILE, { call: fake([new AiCallError('refused')]).call }), AiCallError)
  assertEquals(err.code, 'refused')
})

Deno.test('first pass charged but unparseable: usage is carried on the error', async () => {
  const f = fake([reply('not json', { input_tokens: 400, output_tokens: 90 })])
  const err = await assertRejects(() => runReceiptPipeline(FILE, { call: f.call }), AiCallError)
  assertEquals(billedUsageOf(err), { usage: { input_tokens: 400, output_tokens: 90 }, model: 'claude-sonnet-5-5' })
})

Deno.test('a billed failing repair call still adds its usage to the result', async () => {
  const billedErr = new BilledAiCallError(new AiCallError('unreadable', 'max_tokens'), { input_tokens: 30, output_tokens: 8192 }, 'claude-sonnet-5-5')
  const f = fake([reply(receipt(9.5), { input_tokens: 100, output_tokens: 50 }), billedErr])
  const r = await runReceiptPipeline(FILE, { call: f.call })
  assertEquals([r.repairAttempted, r.repairAdopted, r.usage.input_tokens, r.usage.output_tokens], [true, false, 130, 8242])
})
