import { describe, it, expect } from 'vitest'
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { shareLineMinor, splitLineByQuantities, claimAmountMinor, unclaimedMinor, isWholeQuantity } from './claimMath'
import type { ExpenseLineItem } from '../../../lib/queries/useExpenses'

// Small deterministic generator so the "property" tests are repeatable.
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const line = (total: number, quantity = 1): ExpenseLineItem =>
  ({ id: 'l1', total_amount: total, quantity } as unknown as ExpenseLineItem)

describe('shareLineMinor', () => {
  it('splits a tenner three ways to the penny, lowest id gets the extra', () => {
    const m = shareLineMinor(1000, ['c', 'a', 'b'])
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(1000)
    expect(m.get('a')).toBe(334)
    expect(m.get('b')).toBe(333)
    expect(m.get('c')).toBe(333)
  })
  it('thirds, sevenths and JPY always add up exactly', () => {
    const rand = rng(7)
    for (const people of [3, 7, 2, 5, 9]) {
      for (let i = 0; i < 200; i++) {
        const total = 1 + Math.floor(rand() * 100000)
        const ids = Array.from({ length: people }, (_, k) => `u${k}`)
        const m = shareLineMinor(total, ids)
        expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(total)
        const vals = [...m.values()]
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1)
      }
    }
    // JPY has no minor unit: 1000 yen between 3 is 334/333/333 yen.
    const yen = toMinorUnits(1000, 'JPY')
    const m = shareLineMinor(yen, ['a', 'b', 'c'])
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(yen)
  })
  it('ignores duplicate ids and handles nobody', () => {
    expect(shareLineMinor(500, ['a', 'a']).get('a')).toBe(500)
    expect(shareLineMinor(500, []).size).toBe(0)
  })
})

describe('splitLineByQuantities', () => {
  it('three claims of 0.33/0.33/0.34 on a tenner add up to exactly the tenner', () => {
    const out = splitLineByQuantities(1000, 1, [0.33, 0.33, 0.34])
    expect(out.reduce((a, b) => a + b, 0)).toBe(1000)
  })
  it('three claims of 0.33 do not claim the last penny', () => {
    const out = splitLineByQuantities(1000, 1, [0.33, 0.33, 0.33])
    expect(out.reduce((a, b) => a + b, 0)).toBe(990)
  })
  it('random fully claimed lines always add up', () => {
    const rand = rng(42)
    for (let i = 0; i < 300; i++) {
      const n = 2 + Math.floor(rand() * 6)
      const qty = 1
      const hundredths = Array.from({ length: n }, () => 1 + Math.floor(rand() * 40))
      const sum = hundredths.reduce((a, b) => a + b, 0)
      const quantities = hundredths.map((h) => (h / sum))
      const total = 100 + Math.floor(rand() * 90000)
      const out = splitLineByQuantities(total, qty, quantities)
      expect(out.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })
})

describe('claimAmountMinor', () => {
  it('the last claimer takes exactly what is left of the line', () => {
    // 3 beers for 10.00: 3.33 each if prorated, but the line must add to 10.00.
    const li = line(10, 3)
    const a = claimAmountMinor(li, 1, [], 'GBP')
    const b = claimAmountMinor(li, 1, [{ quantity_claimed: 1, amount_owed: a / 100 }], 'GBP')
    const c = claimAmountMinor(
      li,
      1,
      [
        { quantity_claimed: 1, amount_owed: a / 100 },
        { quantity_claimed: 1, amount_owed: b / 100 },
      ],
      'GBP'
    )
    expect(a + b + c).toBe(1000)
  })
  it('works for JPY', () => {
    const li = line(1000, 3)
    const owed = (m: number) => fromMinorUnits(m, 'JPY')
    const a = claimAmountMinor(li, 1, [], 'JPY')
    const b = claimAmountMinor(li, 1, [{ quantity_claimed: 1, amount_owed: owed(a) }], 'JPY')
    const c = claimAmountMinor(li, 1, [{ quantity_claimed: 1, amount_owed: owed(a) }, { quantity_claimed: 1, amount_owed: owed(b) }], 'JPY')
    expect(a + b + c).toBe(toMinorUnits(1000, 'JPY'))
  })
})

describe('unclaimedMinor ignores legacy dust', () => {
  it('0.33 x 3 of a 10.00 line is fully claimed; 0.5 of it is not', () => {
    const l = [{ ...line(10), id: 'a' }]
    const third = ['x', 'y', 'z'].map((u) => ({ line_item_id: 'a', quantity_claimed: 0.33, amount_owed: 3.3, user_id: u }))
    expect(unclaimedMinor(l, third, 'GBP')).toBe(0)
    expect(unclaimedMinor(l, [{ line_item_id: 'a', quantity_claimed: 0.5, amount_owed: 5 }], 'GBP')).toBe(500)
  })
  it('sums several rows for one person on a line', () => {
    const l = [{ ...line(10), id: 'a' }]
    expect(unclaimedMinor(l, [{ line_item_id: 'a', quantity_claimed: 0.5, amount_owed: 5 }, { line_item_id: 'a', quantity_claimed: 0.5, amount_owed: 5 }], 'GBP')).toBe(0)
  })
})

describe('unclaimedMinor / isWholeQuantity', () => {
  it('sums what is left per line', () => {
    const lines = [{ id: 'a', total_amount: 10, quantity: 1 }, { id: 'b', total_amount: 5, quantity: 1 }] as unknown as ExpenseLineItem[]
    expect(unclaimedMinor(lines, [{ line_item_id: 'a', amount_owed: 4 }], 'GBP')).toBe(600 + 500)
  })
  it('recognises stored whole numbers', () => {
    expect(isWholeQuantity(2)).toBe(true)
    expect(isWholeQuantity(0.5)).toBe(false)
  })
})

import { hasDirectUnitClaims, sharePickProblem, lockedSharePeople, lineIsEqualSplit, selfTogglePick } from './claimMath'

describe('direct whole-unit claims', () => {
  const beers = { quantity: 3 }
  it('2 of 3 beers entered directly is flagged; a whole-line row or a shared row is not', () => {
    expect(hasDirectUnitClaims(beers, [{ quantity_claimed: 2, source: 'self' }])).toBe(true)
    expect(hasDirectUnitClaims(beers, [{ quantity_claimed: 3, source: 'on_behalf' }])).toBe(false)
    expect(hasDirectUnitClaims(beers, [{ quantity_claimed: 1, source: 'shared' }])).toBe(false)
    expect(hasDirectUnitClaims({ quantity: 1 }, [{ quantity_claimed: 1, source: 'self' }])).toBe(false)
  })
})

describe('sharePickProblem (tagged person: may only toggle themselves)', () => {
  const base = { fullPower: false, me: 'me', lineSharedByAll: false }
  it('can add myself to an unclaimed line, alone', () => {
    expect(sharePickProblem({ ...base, pick: ['me'], existing: [] })).toBeNull()
  })
  it('cannot put anyone else on a line, with or without me', () => {
    expect(sharePickProblem({ ...base, pick: ['me', 'x'], existing: [] })).not.toBeNull()
    expect(sharePickProblem({ ...base, pick: ['x'], existing: [] })).not.toBeNull()
    expect(sharePickProblem({ ...base, pick: ['me', 'x', 'y'], existing: ['me', 'x'] })).not.toBeNull()
    expect(sharePickProblem({ ...base, pick: ['me', 'y'], existing: ['x'] })).not.toBeNull()
  })
  it('can add myself to the people already on the line, or take myself off, nothing else', () => {
    expect(sharePickProblem({ ...base, pick: ['me', 'x'], existing: ['x'] })).toBeNull()
    expect(sharePickProblem({ ...base, pick: ['x'], existing: ['me', 'x'] })).toBeNull()
    expect(sharePickProblem({ ...base, pick: [], existing: ['me'] })).toBeNull()
    expect(sharePickProblem({ ...base, pick: ['me'], existing: ['me', 'x'] })).not.toBeNull() // drops x
    expect(sharePickProblem({ ...base, pick: ['y'], existing: ['me', 'x'] })).not.toBeNull() // swaps
    expect(sharePickProblem({ ...base, pick: [], existing: [] })).not.toBeNull() // nothing of mine to remove
  })
  it('table items are for the payer / managers', () => {
    expect(sharePickProblem({ ...base, pick: ['me'], existing: [], lineSharedByAll: true })).not.toBeNull()
    expect(sharePickProblem({ fullPower: true, me: 'm', pick: ['x'], existing: [], lineSharedByAll: true })).toBeNull()
    expect(sharePickProblem({ fullPower: true, me: 'm', pick: [], existing: ['x'], lineSharedByAll: false })).not.toBeNull()
  })
  it('refuses a toggle onto a line where somebody else holds rows that are not an equal split', () => {
    expect(sharePickProblem({ ...base, pick: ['me', 'x'], existing: ['x'], othersSplitUnequal: true })).not.toBeNull()
    expect(sharePickProblem({ ...base, pick: ['me'], existing: [], othersSplitUnequal: true })).toBeNull() // nobody else on it
  })
  it('locks every chip but my own for a non-manager', () => {
    expect([...lockedSharePeople({ fullPower: false, me: 'me', people: ['me', 'x', 'y'] })].sort()).toEqual(['x', 'y'])
    expect(lockedSharePeople({ fullPower: true, me: 'me', people: ['me', 'x'] }).size).toBe(0)
  })
  it('selfTogglePick adds or removes only me', () => {
    expect(selfTogglePick(['x'], 'me', true).sort()).toEqual(['me', 'x'])
    expect(selfTogglePick(['me', 'x'], 'me', false)).toEqual(['x'])
    expect(selfTogglePick(['me', 'x'], 'me', true).sort()).toEqual(['me', 'x'])
  })
})

describe('lineIsEqualSplit (mirror of the server check)', () => {
  const line = { quantity: 1, total_amount: 10 }
  const row = (user_id: string, q: number, a: number, source = 'shared') => ({ user_id, quantity_claimed: q, amount_owed: a, source }) as never
  it('thirds in user_id order: the lowest id gets the extra penny', () => {
    expect(lineIsEqualSplit(line, [row('a', 0.34, 3.34), row('b', 0.33, 3.33), row('c', 0.33, 3.33)], 'EUR')).toBe(true)
    expect(lineIsEqualSplit(line, [row('a', 0.33, 3.33), row('b', 0.34, 3.34), row('c', 0.33, 3.33)], 'EUR')).toBe(false)
  })
  it('legacy 0.33 x 2 rows and a direct 2 of 3 are not equal splits; leftover rows are ignored; nobody is trivially equal', () => {
    expect(lineIsEqualSplit(line, [row('a', 0.33, 3.3), row('b', 0.33, 3.3)], 'EUR')).toBe(false)
    expect(lineIsEqualSplit({ quantity: 3, total_amount: 15 }, [row('a', 2, 10, 'self')], 'EUR')).toBe(false)
    expect(lineIsEqualSplit(line, [row('a', 1, 10, 'self'), { user_id: 'b', quantity_claimed: 0.5, amount_owed: 5, source: 'leftover', leftover_quantity: 0.5, leftover_amount: 5 }], 'EUR')).toBe(true)
    // a leftover share INSIDE a person's row does not change the equal-split test: only the own part counts
    expect(lineIsEqualSplit(line, [{ user_id: 'a', quantity_claimed: 1.5, amount_owed: 15, source: 'self', leftover_quantity: 0.5, leftover_amount: 5 }], 'EUR')).toBe(true)
    expect(lineIsEqualSplit(line, [], 'EUR')).toBe(true)
  })
})
