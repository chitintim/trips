// Pure metric helpers for scripts/eval-receipts.ts (unit-tested). Nothing here
// prints or stores receipt text; names are only compared in memory.

import { toMinorUnits } from '../_shared/money/minorUnits.ts'

/** Dice coefficient over character bigrams of the normalised names: works for Latin and CJK alike. */
export function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string) => {
    const m = new Map<string, number>()
    if (s.length === 1) m.set(s, 1)
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let overlap = 0
  let nx = 0
  let ny = 0
  for (const v of gx.values()) nx += v
  for (const v of gy.values()) ny += v
  for (const [g, c] of gx) overlap += Math.min(c, gy.get(g) ?? 0)
  return (2 * overlap) / (nx + ny)
}

export interface LineForMatch {
  names: string[]
  /** Line amount in major units (stored `subtotal` / parsed `line_total`). */
  amount: number
}

export interface LineMatchResult {
  matched: number
  /** Matches whose best name similarity is >= 0.5. */
  nameAgree: number
  storedCount: number
  parsedCount: number
  recall: number
  precision: number
}

function bestSimilarity(a: string[], b: string[]): number {
  let best = 0
  for (const x of a) for (const y of b) best = Math.max(best, nameSimilarity(x, y))
  return best
}

/**
 * Greedy match of parsed lines to stored lines: a pair is eligible when the
 * amounts agree within 1 minor unit; among eligible pairs the highest name
 * similarity is taken first, so equal prices (two beers) pair by name.
 */
export function matchLines(stored: LineForMatch[], parsed: LineForMatch[], currency: string): LineMatchResult {
  const minor = (n: number) => toMinorUnits(n, currency)
  const pairs: { s: number; p: number; sim: number }[] = []
  stored.forEach((s, si) =>
    parsed.forEach((p, pi) => {
      if (Math.abs(minor(s.amount) - minor(p.amount)) <= 1) {
        pairs.push({ s: si, p: pi, sim: bestSimilarity(s.names, p.names) })
      }
    })
  )
  pairs.sort((a, b) => b.sim - a.sim)
  const usedS = new Set<number>()
  const usedP = new Set<number>()
  let matched = 0
  let nameAgree = 0
  for (const pair of pairs) {
    if (usedS.has(pair.s) || usedP.has(pair.p)) continue
    usedS.add(pair.s)
    usedP.add(pair.p)
    matched++
    if (pair.sim >= 0.5) nameAgree++
  }
  return {
    matched,
    nameAgree,
    storedCount: stored.length,
    parsedCount: parsed.length,
    recall: stored.length ? matched / stored.length : 0,
    precision: parsed.length ? matched / parsed.length : 0,
  }
}

/** Parsed total equals the stored expense amount within 1 minor unit. */
export function isTotalCorrect(parsedTotal: number, storedAmount: number, currency: string): boolean {
  return Math.abs(toMinorUnits(parsedTotal, currency) - toMinorUnits(storedAmount, currency)) <= 1
}

/** Nearest-rank percentile; NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export interface Candidate {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** "claude-haiku-5-5@low,claude-sonnet-5-5@medium" -> candidates. Throws on a bad entry. */
export function parseCandidates(spec: string): Candidate[] {
  return spec.split(',').map((raw) => {
    const [model, effort = 'low'] = raw.trim().split('@')
    if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new Error(`bad model in candidate "${raw}"`)
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`bad effort in candidate "${raw}"`)
    return { model, effort: effort as Candidate['effort'] }
  })
}

export const candidateLabel = (c: Candidate) => `${c.model}@${c.effort}`
