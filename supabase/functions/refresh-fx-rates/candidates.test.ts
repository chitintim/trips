import { assertEquals } from 'jsr:@std/assert@1'
import { isFrozenRow, selectFxCandidates, type FxCandidateRow } from './candidates.ts'

const open = { base_currency: 'GBP', settlement_snapshot: null }
const frozen = { base_currency: 'GBP', settlement_snapshot: { rows: [] } }
const row = (id: string, trips: FxCandidateRow['trips'], extra: Partial<FxCandidateRow> = {}): FxCandidateRow => ({
  id, payment_date: '2026-11-10', fx_rate_date: '2026-11-07', rate_source: 'frankfurter', trips, ...extra,
})

Deno.test('frozen trips are skipped and counted; open trips are kept', () => {
  const { candidates, skippedFrozen } = selectFxCandidates([row('a', open), row('b', frozen), row('c', open)])
  assertEquals(candidates.map((c) => c.id), ['a', 'c'])
  assertEquals(skippedFrozen, 1)
})

Deno.test('an empty-object snapshot still counts as frozen; only null/absent is open', () => {
  assertEquals(isFrozenRow(row('x', { settlement_snapshot: {} })), true)
  assertEquals(isFrozenRow(row('x', { settlement_snapshot: [] })), true)
  assertEquals(isFrozenRow(row('x', { settlement_snapshot: null })), false)
})

Deno.test('embed as a one-element array works; a missing trip fails safe (skipped)', () => {
  assertEquals(isFrozenRow(row('x', [frozen])), true)
  assertEquals(isFrozenRow(row('x', [open])), false)
  assertEquals(isFrozenRow(row('x', null)), true)
  assertEquals(selectFxCandidates([row('x', undefined)]).skippedFrozen, 1)
})

Deno.test('existing filters are unchanged: manual rates, current rates and missing dates are not candidates (and not counted as frozen skips)', () => {
  const { candidates, skippedFrozen } = selectFxCandidates([
    row('manual', frozen, { rate_source: 'manual' }),
    row('current', frozen, { fx_rate_date: '2026-11-10' }),
    row('nodate', frozen, { fx_rate_date: null }),
    row('ok', open),
  ])
  assertEquals(candidates.map((c) => c.id), ['ok'])
  assertEquals(skippedFrozen, 0)
})
