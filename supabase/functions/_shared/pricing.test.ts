import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { estimateCostUsd, MODEL_PRICES, priceEntryFor } from './pricing.ts'

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }

Deno.test('Sonnet 5.5: $2 in, $10 out, $0.10 cache read, $2.50 cache write', () => {
  assertAlmostEquals(estimateCostUsd(usage, 'claude-sonnet-5-5'), 2 + 10 + 0.1 + 2.5, 1e-9)
})

Deno.test('Sonnet 5: same base price, cache read $0.20', () => {
  assertAlmostEquals(estimateCostUsd(usage, 'claude-sonnet-5'), 2 + 10 + 0.2 + 2.5, 1e-9)
})

Deno.test('Haiku 5.5: $0.10 / $0.50 under 100K prompt tokens', () => {
  const u = { input_tokens: 50_000, output_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000 }
  const expected = (50_000 * 0.1 + 10_000 * 0.5 + 20_000 * 0.01 + 10_000 * 0.125) / 1e6
  assertAlmostEquals(estimateCostUsd(u, 'claude-haiku-5-5'), expected, 1e-12)
})

Deno.test('Haiku 5.5: prompts over 100K tokens use the $0.50 / $2.50 card', () => {
  const u = { input_tokens: 150_000, output_tokens: 1_000 }
  assertAlmostEquals(estimateCostUsd(u, 'claude-haiku-5-5'), (150_000 * 0.5 + 1_000 * 2.5) / 1e6, 1e-12)
  // cache tokens count toward the prompt length
  const v = { input_tokens: 10_000, output_tokens: 0, cache_read_input_tokens: 95_000 }
  assertAlmostEquals(estimateCostUsd(v, 'claude-haiku-5-5'), (10_000 * 0.5 + 95_000 * 0.05) / 1e6, 1e-12)
})

Deno.test('Opus 5.5: $4 / $20', () => {
  assertAlmostEquals(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-5-5'), 24, 1e-9)
})

Deno.test('the logged parse (6242 in, 3066 out, 5709 write, 5709 read) on Sonnet 5.5', () => {
  const u = { input_tokens: 6242, output_tokens: 3066, cache_creation_input_tokens: 5709, cache_read_input_tokens: 5709 }
  const expected = (6242 * 2 + 3066 * 10 + 5709 * 2.5 + 5709 * 0.1) / 1e6
  assertAlmostEquals(estimateCostUsd(u, 'claude-sonnet-5-5'), expected, 1e-12)
})

Deno.test('missing optional cache fields count as zero', () => {
  assertAlmostEquals(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5-5'), 2, 1e-12)
})

Deno.test('model lookup: longest key wins, date suffixes tolerated, unknown models are priced conservatively', () => {
  assertEquals(priceEntryFor('claude-sonnet-5-5').entry, MODEL_PRICES['claude-sonnet-5-5'])
  assertEquals(priceEntryFor('claude-sonnet-5-5-20261001').entry, MODEL_PRICES['claude-sonnet-5-5'])
  assertEquals(priceEntryFor('claude-sonnet-5').entry, MODEL_PRICES['claude-sonnet-5'])
  const unknown = priceEntryFor('claude-future-9')
  assertEquals(unknown.known, false)
  const maxOut = Math.max(...Object.values(MODEL_PRICES).map((p) => p.output))
  assertEquals(unknown.entry.output, maxOut)
  assert(estimateCostUsd({ input_tokens: 1000, output_tokens: 1000 }, null) > 0)
})
