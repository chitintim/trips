import { describe, it, expect } from 'vitest'
import { describeMyShare, formatClaimQuantity, formatShareOfItem } from './claimFractions'

describe('formatClaimQuantity', () => {
  it('shows whole numbers plainly', () => {
    expect(formatClaimQuantity(1)).toBe('1')
    expect(formatClaimQuantity(3)).toBe('3')
    expect(formatClaimQuantity(0)).toBe('0')
  })
  it('shows common fractions as symbols', () => {
    expect(formatClaimQuantity(0.5)).toBe('½')
    expect(formatClaimQuantity(1 / 3)).toBe('⅓')
    expect(formatClaimQuantity(0.33)).toBe('⅓')
    expect(formatClaimQuantity(0.34)).toBe('⅓')
    expect(formatClaimQuantity(0.2)).toBe('⅕')
    expect(formatClaimQuantity(0.25)).toBe('¼')
    expect(formatClaimQuantity(0.17)).toBe('⅙')
    expect(formatClaimQuantity(0.67)).toBe('⅔')
  })
  it('writes a tenth as 1/10', () => {
    expect(formatClaimQuantity(0.1)).toBe('1/10')
  })
  it('shows anything that is not a simple fraction as a percentage, never a bare decimal', () => {
    expect(formatClaimQuantity(0.3)).toBe('30%')
    expect(formatClaimQuantity(0.07)).toBe('7%')
    expect(formatClaimQuantity(0.42)).toBe('42%')
    expect(formatClaimQuantity(1.07)).toBe('1 + 7%')
  })
  it('renders every legacy quantity seen on live without a decimal point', () => {
    const live = [0.07, 0.1, 0.17, 0.2, 0.25, 0.3, 0.33, 0.34, 0.5, 1]
    expect(live.map(formatClaimQuantity)).toEqual(['7%', '1/10', '⅙', '⅕', '¼', '30%', '⅓', '⅓', '½', '1'])
    for (const q of live) expect(formatClaimQuantity(q)).not.toMatch(/\d\.\d/)
  })
  it('keeps the whole part of mixed numbers', () => {
    expect(formatClaimQuantity(1.5)).toBe('1½')
    expect(formatClaimQuantity(2.25)).toBe('2¼')
  })
})

describe('formatShareOfItem', () => {
  it('is the person\'s real share of the item', () => {
    expect(formatShareOfItem(2, 3)).toBe('⅔')
    expect(formatShareOfItem(1, 3)).toBe('⅓')
    expect(formatShareOfItem(0.07, 1)).toBe('7%')
    expect(formatShareOfItem(0.2, 1)).toBe('⅕')
    expect(formatShareOfItem(1, 1)).toBe('all of it')
    expect(formatShareOfItem(1, 2)).toBe('½')
  })
})

describe('describeMyShare', () => {
  it('says ÷N only for a real equal split among N', () => {
    expect(describeMyShare({ myQuantity: 0.2, lineQuantity: 1, allQuantities: [0.2, 0.2, 0.2, 0.2, 0.2] })).toBe('÷5 share')
    expect(describeMyShare({ myQuantity: 0.33, lineQuantity: 1, allQuantities: [0.33, 0.33, 0.34] })).toBe('÷3 share')
    expect(describeMyShare({ myQuantity: 0.5, lineQuantity: 1, allQuantities: [0.5, 0.5] })).toBe('÷2 share')
  })
  it('shows the real share when five people hold the item but not equally (the live "÷5 / €3.29" bug)', () => {
    expect(describeMyShare({ myQuantity: 0.07, lineQuantity: 1, allQuantities: [0.07, 0.3, 0.2, 0.25, 0.18] })).toBe('7%')
    expect(describeMyShare({ myQuantity: 0.2, lineQuantity: 1, allQuantities: [0.2, 0.2, 0.2, 0.2] })).toBe('⅕')
  })
  it('works in item units (2 of 3)', () => {
    expect(describeMyShare({ myQuantity: 2, lineQuantity: 3, allQuantities: [2, 1] })).toBe('⅔')
    expect(describeMyShare({ myQuantity: 1, lineQuantity: 2, allQuantities: [1, 1] })).toBe('÷2 share')
  })
  it('a lone claimer holding the whole item', () => {
    expect(describeMyShare({ myQuantity: 1, lineQuantity: 1, allQuantities: [1] })).toBe('all of it')
  })
})
