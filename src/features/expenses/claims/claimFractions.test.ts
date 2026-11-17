import { describe, it, expect } from 'vitest'
import { formatClaimQuantity } from './claimFractions'

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
  it('falls back to two decimals', () => {
    expect(formatClaimQuantity(0.3)).toBe('0.30')
    expect(formatClaimQuantity(0.07)).toBe('0.07')
    expect(formatClaimQuantity(0.42)).toBe('0.42')
  })
  it('keeps the whole part of mixed numbers', () => {
    expect(formatClaimQuantity(1.5)).toBe('1½')
    expect(formatClaimQuantity(2.25)).toBe('2¼')
  })
})
