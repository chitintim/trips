import { assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { isTotalCorrect, matchLines, nameSimilarity, parseCandidates, percentile } from './evalMetrics.ts'

Deno.test('nameSimilarity: identical, near, different, CJK, empty', () => {
  assertEquals(nameSimilarity('Pad Thai', 'pad  thai!'), 1)
  assertEquals(nameSimilarity('Margherita Pizza', 'Pizza Margherita') > 0.7, true)
  assertEquals(nameSimilarity('Beer', 'Tiramisu') < 0.2, true)
  assertEquals(nameSimilarity('生ビール', '生ビール 中'), nameSimilarity('生ビール 中', '生ビール'))
  assertEquals(nameSimilarity('生ビール', '生ビール') , 1)
  assertEquals(nameSimilarity('', 'x'), 0)
})

Deno.test('matchLines: price within 1 minor unit, equal prices paired by name, recall and precision', () => {
  const stored = [
    { names: ['Beer'], amount: 5 },
    { names: ['Wine'], amount: 5 },
    { names: ['Steak'], amount: 24 },
    { names: ['Missed dish'], amount: 9.99 },
  ]
  const parsed = [
    { names: ['Wine'], amount: 5 },
    { names: ['Beer'], amount: 5.01 },
    { names: ['Steak'], amount: 24 },
    { names: ['Invented'], amount: 3 },
  ]
  const r = matchLines(stored, parsed, 'GBP')
  assertEquals([r.matched, r.nameAgree, r.storedCount, r.parsedCount], [3, 3, 4, 4])
  assertAlmostEquals(r.recall, 0.75)
  assertAlmostEquals(r.precision, 0.75)
})

Deno.test('matchLines: zero-decimal currency compares whole yen; empty sides give 0', () => {
  const r = matchLines([{ names: ['ラーメン'], amount: 900 }], [{ names: ['Ramen'], amount: 901 }], 'JPY')
  assertEquals(r.matched, 1)
  assertEquals(r.nameAgree, 0)
  const none = matchLines([], [], 'GBP')
  assertEquals([none.recall, none.precision], [0, 0])
})

Deno.test('isTotalCorrect: within 1 minor unit only', () => {
  assertEquals(isTotalCorrect(45.01, 45, 'GBP'), true)
  assertEquals(isTotalCorrect(45.02, 45, 'GBP'), false)
  assertEquals(isTotalCorrect(3200, 3201, 'JPY'), true)
  assertEquals(isTotalCorrect(3200, 3203, 'JPY'), false)
})

Deno.test('percentile: nearest rank', () => {
  assertEquals(percentile([5, 1, 3, 2, 4], 50), 3)
  assertEquals(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
  assertEquals(Number.isNaN(percentile([], 50)), true)
})

Deno.test('parseCandidates', () => {
  assertEquals(parseCandidates('claude-haiku-5-5@medium, claude-sonnet-5-5'), [
    { model: 'claude-haiku-5-5', effort: 'medium' },
    { model: 'claude-sonnet-5-5', effort: 'low' },
  ])
  assertThrows(() => parseCandidates('gpt-5@low'))
  assertThrows(() => parseCandidates('claude-sonnet-5-5@turbo'))
})
