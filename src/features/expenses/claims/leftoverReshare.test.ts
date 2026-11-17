import { describe, it, expect } from 'vitest'
import { receiptHasLeftovers, leftoverFollowUp, everythingSharedOut } from './leftoverReshare'
import { shareLineMinor } from './claimMath'
import { toMinorUnits } from '../../../lib/money'

const row = (line: string, user: string, q: number, a: number, lq = 0, la = 0) =>
  ({ line_item_id: line, user_id: user, quantity_claimed: q, amount_owed: a, leftover_quantity: lq, leftover_amount: la })

describe('receiptHasLeftovers / leftoverFollowUp', () => {
  it('re-shares when ANY row has a leftover part, even if the edited line had none (dust merged into another line)', () => {
    const claims = [row('l1', 'a', 1, 5), row('l2', 'b', 1, 5.1, 0.01, 0.1)]
    expect(receiptHasLeftovers(null, claims)).toBe(true)
    expect(leftoverFollowUp({ expense: {}, claims, canShare: true })).toBe('reshare')
  })
  it('re-shares when the expense remembers a mode, even with no leftover rows left', () => {
    expect(leftoverFollowUp({ expense: { leftover_mode: 'everyone' }, claims: [row('l1', 'a', 1, 5)], canShare: true })).toBe('reshare')
  })
  it('an ordinary person is never asked to re-share (the server refuses); the payer is told instead', () => {
    expect(leftoverFollowUp({ expense: { leftover_mode: 'payer' }, claims: [], canShare: false })).toBe('tell_payer')
  })
  it('does nothing when no leftovers were ever shared', () => {
    expect(leftoverFollowUp({ expense: { leftover_mode: null }, claims: [row('l1', 'a', 1, 5)], canShare: true })).toBe('none')
  })
})

describe('an ordinary person edits a line that carried a leftover part', () => {
  // Server: set_receipt_claims replaces EVERY row on the line with an equal split of the people picked (leftover parts go with the rows).
  const lines = [{ id: 'l1', quantity: 2, total_amount: 20 }, { id: 'l2', quantity: 1, total_amount: 10 }]
  const before = [row('l1', 'a', 2, 20), row('l2', 'a', 0.5, 5), row('l2', 'b', 0.5, 5, 0.5, 5)]
  const applySelfRemoval = (rows: typeof before, lineId: string, me: string) => {
    const keep = rows.filter((r) => r.line_item_id === lineId && r.user_id !== me && r.quantity_claimed - r.leftover_quantity > 0)
    const rest = rows.filter((r) => r.line_item_id !== lineId)
    const line = lines.find((l) => l.id === lineId)!
    const shares = shareLineMinor(toMinorUnits(line.total_amount, 'GBP'), keep.map((r) => r.user_id))
    return [...rest, ...keep.map((r) => row(lineId, r.user_id, line.quantity / keep.length, (shares.get(r.user_id) ?? 0) / 100))]
  }
  const lineSum = (rows: typeof before, id: string) => rows.filter((r) => r.line_item_id === id).reduce((s, r) => s + r.amount_owed, 0)

  it('sums never exceed the line totals and the removed leftover value shows as unclaimed again', () => {
    expect(everythingSharedOut(lines, before, 'GBP')).toBe(true)
    // b (who only holds a leftover share on l2) edits l2: the line is rebuilt from OWN parts only.
    const after = applySelfRemoval(before, 'l2', 'b')
    for (const l of lines) expect(toMinorUnits(lineSum(after, l.id), 'GBP')).toBeLessThanOrEqual(toMinorUnits(l.total_amount, 'GBP'))
    expect(everythingSharedOut(lines, after, 'GBP')).toBe(true)
    // a person with an own claim taking themselves off returns the line to unclaimed
    const gone = applySelfRemoval(before, 'l1', 'a')
    expect(everythingSharedOut(lines, gone, 'GBP')).toBe(false)
    expect(leftoverFollowUp({ expense: { leftover_mode: 'everyone' }, claims: gone, canShare: false })).toBe('tell_payer')
  })
  it('everythingSharedOut ignores zero-money lines and empty receipts', () => {
    expect(everythingSharedOut([{ id: 'z', quantity: 1, total_amount: 0 }], [], 'GBP')).toBe(false)
    expect(everythingSharedOut([{ id: 'l1', quantity: 1, total_amount: 5 }], [row('l1', 'a', 0.99, 5)], 'GBP')).toBe(true)
    expect(everythingSharedOut([{ id: 'l1', quantity: 1, total_amount: 5 }], [row('l1', 'a', 0.5, 2.5)], 'GBP')).toBe(false)
  })
})
