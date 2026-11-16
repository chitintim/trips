import { describe, it, expect } from 'vitest'
import {
  currencySymbol,
  formatMoney,
  formatMoneyEstimate,
  formatMoneyExact,
  formatMoneyMinor,
  formatMoneyRange,
} from './format'
import { fromMinorUnits, toMinorUnits } from './minorUnits'

describe('formatMoney: headline (default)', () => {
  it.each([
    [50, 'GBP', '£50'],
    [54.5, 'GBP', '£54.50'],
    [1200, 'GBP', '£1,200'],
    [1989.6, 'GBP', '£1,989.60'],
    [0, 'GBP', '£0'],
    [30, 'EUR', '€30'],
    [30.25, 'EUR', '€30.25'],
    [5000, 'JPY', '¥5,000'],
    [5000.4, 'JPY', '¥5,000'],
    [120, 'CHF', 'CHF 120'],
    [120.5, 'CHF', 'CHF 120.50'],
    [12, 'USD', '$12'],
    [12, 'AUD', 'A$12'],
    [12, 'CAD', 'C$12'],
    [5, 'XYZ', 'XYZ 5'],
  ])('%s %s -> %s', (amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected)
  })

  it('negatives lead with a minus before the symbol', () => {
    expect(formatMoney(-4, 'GBP')).toBe('-£4')
    expect(formatMoney(-4.5, 'EUR')).toBe('-€4.50')
    expect(formatMoney(-5000, 'JPY')).toBe('-¥5,000')
  })

  it('a value that rounds to zero is not negative', () => {
    expect(formatMoney(-0.001, 'GBP')).toBe('£0')
    expect(formatMoney(-0.001, 'GBP', { mode: 'exact' })).toBe('£0.00')
  })

  it('non-finite input prints as zero, never NaN', () => {
    expect(formatMoney(NaN, 'GBP')).toBe('£0')
    expect(formatMoney(Infinity, 'GBP')).toBe('£0')
  })

  it('handles three-decimal currencies by exponent', () => {
    expect(formatMoney(1.5, 'BHD')).toBe('BHD 1.500')
    expect(formatMoney(2, 'BHD')).toBe('BHD 2')
  })
})

describe('formatMoney: exact (ledgers)', () => {
  it.each([
    [50, 'GBP', '£50.00'],
    [1989.6, 'GBP', '£1,989.60'],
    [0, 'GBP', '£0.00'],
    [30, 'EUR', '€30.00'],
    [5000, 'JPY', '¥5,000'],
    [120, 'CHF', 'CHF 120.00'],
    [11563.8, 'GBP', '£11,563.80'],
    [-4698.61, 'GBP', '-£4,698.61'],
  ])('%s %s -> %s', (amount, currency, expected) => {
    expect(formatMoney(amount, currency, { mode: 'exact' })).toBe(expected)
    expect(formatMoneyExact(amount, currency)).toBe(expected)
  })

  it('formatMoneyMinor defaults to exact', () => {
    expect(formatMoneyMinor(198960, 'GBP')).toBe('£1,989.60')
    expect(formatMoneyMinor(5000, 'JPY')).toBe('¥5,000')
    expect(formatMoneyMinor(5000, 'GBP', { mode: 'headline' })).toBe('£50')
  })
})

describe('formatMoney: estimates and conversions', () => {
  it('estimate rounds to whole units from 10 up and prefixes ≈', () => {
    expect(formatMoney(221.78, 'GBP', { estimate: true })).toBe('≈£222')
    expect(formatMoneyEstimate(2000 / 9, 'GBP')).toBe('≈£222')
    expect(formatMoney(10, 'EUR', { mode: 'estimate' })).toBe('≈€10')
    expect(formatMoney(9.5, 'GBP', { estimate: true })).toBe('≈£9.50')
    expect(formatMoney(3333.33, 'JPY', { estimate: true })).toBe('≈¥3,333')
    expect(formatMoney(119.6, 'CHF', { estimate: true })).toBe('≈CHF 120')
  })

  it('converted prefixes ≈ without rounding', () => {
    expect(formatMoney(26, 'GBP', { converted: true })).toBe('≈£26')
    expect(formatMoney(26.45, 'GBP', { converted: true })).toBe('≈£26.45')
  })

  it('estimate wins over exact', () => {
    expect(formatMoney(221.78, 'GBP', { mode: 'exact', estimate: true })).toBe('≈£222')
  })
})

describe('formatMoney: compact and signed', () => {
  it.each([
    [999, 'GBP', '£999'],
    [1234, 'GBP', '£1.2k'],
    [2000, 'GBP', '£2k'],
    [15500, 'EUR', '€15.5k'],
    [1_500_000, 'GBP', '£1.5m'],
    [250000, 'JPY', '¥250k'],
  ])('compact %s %s -> %s', (amount, currency, expected) => {
    expect(formatMoney(amount, currency, { compact: true })).toBe(expected)
  })

  it('signed adds + for positives only', () => {
    expect(formatMoney(54, 'GBP', { signed: true })).toBe('+£54')
    expect(formatMoney(-54, 'GBP', { signed: true })).toBe('-£54')
    expect(formatMoney(0, 'GBP', { signed: true })).toBe('£0')
  })

  it('hideSymbol prints the number only', () => {
    expect(formatMoney(1989.6, 'GBP', { mode: 'exact', hideSymbol: true })).toBe('1,989.60')
  })
})

describe('formatMoneyRange', () => {
  it('leads with ≈ once for estimates', () => {
    expect(formatMoneyRange(1150, 1310, 'GBP', { estimate: true })).toBe('≈£1,150 – £1,310')
  })
  it('collapses an empty range', () => {
    expect(formatMoneyRange(50, 50, 'GBP')).toBe('£50')
    expect(formatMoneyRange(50, 50, 'GBP', { estimate: true })).toBe('≈£50')
  })
  it('plain range', () => {
    expect(formatMoneyRange(60, 140, 'EUR')).toBe('€60 – €140')
  })
})

describe('currencySymbol', () => {
  it('maps known codes and falls back to the code', () => {
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('chf')).toBe('CHF ')
    expect(currencySymbol('SEK')).toBe('SEK ')
    expect(currencySymbol('')).toBe('')
    expect(currencySymbol(null)).toBe('')
  })
})

describe('formatMoney: display equals what the ledger stores (review A1-A3)', () => {
  it.each([
    [1.005, 'GBP', '£1.00'], // toMinorUnits(1.005) = 100p
    [9.995, 'GBP', '£9.99'], // toMinorUnits(9.995) = 999p
    [2.675, 'GBP', '£2.68'],
  ])('%s %s prints %s in exact mode and matches toMinorUnits', (amount, currency, expected) => {
    expect(formatMoney(amount, currency, { mode: 'exact' })).toBe(expected)
    expect(formatMoney(fromMinorUnits(toMinorUnits(amount, currency), currency), currency, { mode: 'exact' })).toBe(expected)
  })

  it('CNY prints CN¥ and JPY keeps ¥', () => {
    expect(formatMoney(5000, 'CNY')).toBe('CN¥5,000')
    expect(formatMoney(5000, 'JPY')).toBe('¥5,000')
  })

  it('compact re-picks the suffix after rounding', () => {
    expect(formatMoney(999_950, 'GBP', { compact: true })).toBe('£1m')
    expect(formatMoney(999_949, 'GBP', { compact: true })).toBe('£999.9k')
    expect(formatMoney(1000, 'GBP', { compact: true })).toBe('£1k')
    expect(formatMoney(1_200_000, 'GBP', { compact: true })).toBe('£1.2m')
  })
})
