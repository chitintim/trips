/**
 * Per-model price table (USD per million tokens) and cost estimator. Pure
 * (no Deno / Supabase imports) so it can be unit-tested and reused by the
 * eval script. Source: claude-api skill (models table + prompt-caching
 * "Economics": cache reads are 0.1x input, except Sonnet 5.5 $0.10 and
 * Opus 5.5 $0.20; 5-minute cache writes are 1.25x input). Haiku 5.5 has a
 * second rate card for prompts over 100K tokens. Estimates only, not a
 * billing source of truth.
 */

export interface ModelPrices {
  input: number
  output: number
  /** Cache read (hit). */
  cacheRead: number
  /** 5-minute cache write. */
  cacheWrite: number
}

export interface PriceEntry extends ModelPrices {
  /** Rate card used when the whole prompt exceeds `longPromptTokens`. */
  long?: ModelPrices
  longPromptTokens?: number
}

export const MODEL_PRICES: Record<string, PriceEntry> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    longPromptTokens: 100_000,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}

export interface UsageLike {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** The most expensive known entry: used for unknown models so spend is never under-reported. */
function conservativeEntry(): PriceEntry {
  return Object.values(MODEL_PRICES).reduce((a, b) => (b.output > a.output ? b : a))
}

/** Finds the entry for a model id (longest key match; tolerates date suffixes). */
export function priceEntryFor(model: string | null | undefined): { entry: PriceEntry; known: boolean } {
  const m = (model ?? '').trim()
  let bestKey = ''
  for (const key of Object.keys(MODEL_PRICES)) {
    if ((m === key || m.startsWith(key + '-')) && key.length > bestKey.length) bestKey = key
  }
  if (bestKey) return { entry: MODEL_PRICES[bestKey], known: true }
  return { entry: conservativeEntry(), known: false }
}

export function estimateCostUsd(usage: UsageLike, model: string | null | undefined): number {
  const { entry } = priceEntryFor(model)
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite
  const p: ModelPrices =
    entry.long && entry.longPromptTokens && promptTokens > entry.longPromptTokens ? entry.long : entry
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.cacheWrite) / 1_000_000
  )
}
