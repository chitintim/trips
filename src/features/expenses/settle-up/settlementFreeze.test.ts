import { describe, it, expect } from 'vitest'
import {
  buildFreezeSuggestions,
  findProvingDuplicate,
  canRemoveAsDuplicate,
  knownPaidIds,
  paymentsChangedSince,
  partitionStaleSuggested,
} from './settlementFreeze'
import type { Settlement } from '../../../lib/queries/useSettlements'

function row(o: Partial<Settlement> & { id: string }): Settlement {
  return {
    trip_id: 't1',
    from_user_id: 'a',
    to_user_id: 'b',
    amount: 10,
    currency: 'GBP',
    status: 'marked_paid',
    created_at: '2026-11-01T00:00:00Z',
    created_by: 'a',
    settled_at: '2026-11-01T00:00:00Z',
    notes: null,
    payment_method: null,
    ...o,
  } as Settlement
}

describe('buildFreezeSuggestions', () => {
  it('shapes transactions with the base currency and drops zero or self payments', () => {
    const out = buildFreezeSuggestions(
      [
        { from: 'a', to: 'b', amount: 12.5, fromName: 'A', toName: 'B' },
        { from: 'a', to: 'a', amount: 3, fromName: 'A', toName: 'A' },
        { from: 'b', to: 'a', amount: 0, fromName: 'B', toName: 'A' },
      ],
      'EUR'
    )
    expect(out).toEqual([{ from: 'a', to: 'b', amount: 12.5, currency: 'EUR' }])
  })
})

describe('findProvingDuplicate (mirrors remove_duplicate_settlement)', () => {
  const a = row({ id: 'a1', created_at: '2026-11-01T00:00:00Z' })
  const b = row({ id: 'b1', created_at: '2026-11-01T10:00:00Z' })

  it('proves a duplicate when another non-suggested identical row exists', () => {
    expect(findProvingDuplicate(b, [a, b], 'GBP')?.id).toBe('a1')
    expect(canRemoveAsDuplicate(a, [a, b], 'GBP')).toBe(true)
  })
  it('never removes a confirmed row', () => {
    expect(canRemoveAsDuplicate(row({ id: 'c', status: 'confirmed' }), [a, row({ id: 'c', status: 'confirmed' })], 'GBP')).toBe(false)
  })
  it('may remove a marked_paid row duplicating a confirmed one', () => {
    const c = row({ id: 'c', status: 'confirmed' })
    expect(findProvingDuplicate(b, [b, c], 'GBP')?.id).toBe('c')
  })
  it('a suggested row is not proof, and a lone row has no duplicate', () => {
    expect(canRemoveAsDuplicate(a, [a, row({ id: 's', status: 'suggested' })], 'GBP')).toBe(false)
    expect(canRemoveAsDuplicate(a, [a], 'GBP')).toBe(false)
  })
  it('requires the same pair, amount and currency (null currency = base)', () => {
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', to_user_id: 'z' })], 'GBP')).toBe(false)
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', from_user_id: 'b', to_user_id: 'a' })], 'GBP')).toBe(false)
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', amount: 10.01 })], 'GBP')).toBe(false)
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', currency: 'EUR' })], 'GBP')).toBe(false)
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', currency: null })], 'GBP')).toBe(true)
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', currency: null })], 'EUR')).toBe(false)
  })
  it('ignores other trips', () => {
    expect(canRemoveAsDuplicate(a, [a, row({ id: 'x', trip_id: 't2' })], 'GBP')).toBe(false)
  })
})

describe('duplicate window (24h)', () => {
  it('rows 24h or more apart are separate payments', () => {
    const a = row({ id: 'a1', created_at: '2026-11-01T00:00:00Z' })
    const b = row({ id: 'b1', created_at: '2026-11-02T00:00:00Z' })
    expect(canRemoveAsDuplicate(b, [a, b], 'GBP')).toBe(false)
    const c = row({ id: 'c1', created_at: '2026-11-01T23:59:00Z' })
    expect(canRemoveAsDuplicate(c, [a, c], 'GBP')).toBe(true)
  })
  it('lets the organiser choose either row of a pair', () => {
    const a = row({ id: 'a1', created_at: '2026-11-01T00:00:00Z' })
    const b = row({ id: 'b1', created_at: '2026-11-01T10:00:00Z' })
    expect(canRemoveAsDuplicate(a, [a, b], 'GBP')).toBe(true)
    expect(canRemoveAsDuplicate(b, [a, b], 'GBP')).toBe(true)
  })
})

describe('knownPaidIds / paymentsChangedSince', () => {
  const rows = [row({ id: 'm1' }), row({ id: 'c1', status: 'confirmed' }), row({ id: 's1', status: 'suggested' })]
  it('lists only unconfirmed, non-suggested rows', () => {
    expect(knownPaidIds(rows)).toEqual(['m1'])
  })
  it('detects a payment marked after the client read', () => {
    expect(paymentsChangedSince(rows, ['m1'])).toBe(false)
    expect(paymentsChangedSince([...rows, row({ id: 'm2' })], ['m1'])).toBe(true)
    expect(paymentsChangedSince([...rows, row({ id: 'c2', status: 'confirmed' })], ['m1'])).toBe(false)
  })
})

describe('partitionStaleSuggested', () => {
  const rows = [row({ id: 's', status: 'suggested' }), row({ id: 'm', status: 'marked_paid' }), row({ id: 'c', status: 'confirmed' })]
  it('while frozen every row is current', () => {
    const r = partitionStaleSuggested(rows, true)
    expect(r.current.map((x) => x.id)).toEqual(['s', 'm', 'c'])
    expect(r.fromLastFreeze).toEqual([])
  })
  it('while unfrozen suggested rows from the last freeze are set apart; real payments stay current', () => {
    const r = partitionStaleSuggested(rows, false)
    expect(r.current.map((x) => x.id)).toEqual(['m', 'c'])
    expect(r.fromLastFreeze.map((x) => x.id)).toEqual(['s'])
  })
})
