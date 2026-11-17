import { describe, it, expect } from 'vitest'
import { diffReitemise, clearedClaimsWarningText } from './reitemizeDiff'

const E = (id: string, name: string, quantity: number, subtotal: number) => ({ id, name_original: name, quantity, subtotal })
const C = (line: string, user: string, q = 1) => ({ line_item_id: line, user_id: user, quantity_claimed: q })
const N = (name: string, quantity: number, subtotal: number, keep: string | null = null) => ({
  name_original: name,
  quantity,
  subtotal,
  keepFromLineItemId: keep,
})

describe('diffReitemise (the database function\'s "unchanged" rule)', () => {
  const existingLines = [E('a', 'Ramen', 2, 24), E('b', 'Beer', 1, 6)]
  const existingClaims = [C('a', 'u1'), C('a', 'u2'), C('b', 'u1')]
  const run = (newLines: ReturnType<typeof N>[], extra: { previousCurrency?: string } = {}) =>
    diffReitemise({ existingLines, existingClaims, newLines, currency: 'GBP', ...extra })

  it('keeps everything when nothing changed', () => {
    const d = run([N('Ramen', 2, 24, 'a'), N('Beer', 1, 6, 'b')])
    expect(d.decisions).toEqual([{ lineItemId: 'a', unchanged: true }, { lineItemId: 'b', unchanged: true }])
    expect(d.keptClaimCount).toBe(3)
    expect(d.clearedClaimCount).toBe(0)
    expect(d.clearedUserIds).toEqual([])
    expect(d.discardedLineIds).toEqual([])
  })

  it('ignores whitespace around the name and quantity noise below 2 dp', () => {
    const d = run([N('  Ramen ', 2.001, 24, 'a'), N('Beer', 1, 6, 'b')])
    expect(d.clearedClaimCount).toBe(0)
  })

  it('clears claims when the item price changes (the old client rule kept them)', () => {
    const d = run([N('Ramen', 2, 26, 'a'), N('Beer', 1, 6, 'b')])
    expect(d.decisions[0]).toEqual({ lineItemId: 'a', unchanged: false })
    expect(d.clearedClaimCount).toBe(2)
    expect(d.clearedUserIds.sort()).toEqual(['u1', 'u2'])
    expect(d.keptClaimCount).toBe(1)
    expect(d.discardedLineIds).toEqual([])
  })

  it('clears claims when the name or quantity changes', () => {
    expect(run([N('Tonkotsu', 2, 24, 'a'), N('Beer', 1, 6, 'b')]).clearedClaimCount).toBe(2)
    expect(run([N('Ramen', 3, 24, 'a'), N('Beer', 1, 6, 'b')]).clearedClaimCount).toBe(2)
  })

  it('clears the claims of a removed line and lists it as removed', () => {
    const d = run([N('Ramen', 2, 24, 'a')])
    expect(d.clearedClaimCount).toBe(1)
    expect(d.clearedUserIds).toEqual(['u1'])
    expect(d.discardedLineIds).toEqual(['b'])
  })

  it('treats a line without an id as new, even when it looks identical', () => {
    const d = run([N('Ramen', 2, 24), N('Beer', 1, 6, 'b')])
    expect(d.decisions[0]).toEqual({ lineItemId: null, unchanged: false })
    expect(d.discardedLineIds).toEqual(['a'])
    expect(d.clearedClaimCount).toBe(2)
  })

  it('honours an id once', () => {
    const d = run([N('Ramen', 2, 24, 'a'), N('Ramen', 2, 24, 'a'), N('Beer', 1, 6, 'b')])
    expect(d.decisions[1]).toEqual({ lineItemId: null, unchanged: false })
  })

  it('leaves nothing unchanged when the currency changes', () => {
    const d = run([N('Ramen', 2, 24, 'a'), N('Beer', 1, 6, 'b')], { previousCurrency: 'EUR' })
    expect(d.keptClaimCount).toBe(0)
    expect(d.clearedUserIds.sort()).toEqual(['u1', 'u2'])
  })

  it('compares prices in minor units of the currency', () => {
    const d = diffReitemise({ existingLines: [E('a', 'Ramen', 1, 1200)], existingClaims: [C('a', 'u1')], newLines: [N('Ramen', 1, 1200.4, 'a')], currency: 'JPY' })
    expect(d.clearedClaimCount).toBe(0)
  })
})

describe('clearedClaimsWarningText', () => {
  it('names the people', () => {
    expect(clearedClaimsWarningText(['Sam'])).toBe("1 person's claim will be cleared: Sam. Claims on items you did not change are kept.")
    expect(clearedClaimsWarningText(['Sam', 'Alex', 'Jo'])).toContain("3 people's claims will be cleared: Sam, Alex and Jo.")
  })
  it('says ALL claims go when the database function is missing', () => {
    const t = clearedClaimsWarningText(['Sam', 'Alex'], { all: true, claimCount: 5 })
    expect(t).toContain('All claims on this receipt will be cleared: 5 claims from Sam and Alex.')
    expect(t).not.toContain('did not change')
  })
  it('mentions leftovers', () => {
    expect(clearedClaimsWarningText(['Sam'], { leftoversCleared: true })).toContain('Shared leftovers are reset too.')
  })
})

describe('clearedClaimsWarningText with people to re-check', () => {
  it('adds the line about "That\'s everything" answers', () => {
    expect(clearedClaimsWarningText([], { reconfirmCount: 2 })).toBe('2 people who said "That\'s everything" will be asked to check again.')
    expect(clearedClaimsWarningText(['Sam'], { reconfirmCount: 1 })).toContain('1 person who said "That\'s everything" will be asked to check again.')
  })
})
