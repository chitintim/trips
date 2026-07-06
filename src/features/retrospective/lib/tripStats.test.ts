import { describe, it, expect } from 'vitest'
import { computeTripStats, formatMinor, buildSummaryText } from './tripStats'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

function expense(overrides: Partial<ExpenseWithDetails>): ExpenseWithDetails {
  return {
    id: Math.random().toString(36).slice(2),
    trip_id: 'trip-1',
    description: 'Something',
    amount: 10,
    currency: 'GBP',
    base_currency_amount: null,
    category: 'other',
    paid_by: 'a',
    payment_date: '2026-03-14',
    ...overrides,
  } as ExpenseWithDetails
}

describe('computeTripStats', () => {
  it('totals in minor units by category, person and day', () => {
    const stats = computeTripStats(
      [
        expense({ amount: 100.5, category: 'food', paid_by: 'a', payment_date: '2026-03-14' }),
        expense({ amount: 49.5, category: 'food', paid_by: 'b', payment_date: '2026-03-15' }),
        expense({ amount: 200, category: 'accommodation', paid_by: 'a', payment_date: '2026-03-14' }),
      ],
      'GBP'
    )
    expect(stats.totalMinor).toBe(35000)
    expect(stats.byCategory[0]).toEqual({ category: 'accommodation', amountMinor: 20000 })
    expect(stats.byPerson[0]).toEqual({ userId: 'a', amountMinor: 30050 })
    expect(stats.byDay).toEqual([
      { date: '2026-03-14', amountMinor: 30050 },
      { date: '2026-03-15', amountMinor: 4950 },
    ])
  })

  it('uses base_currency_amount for foreign expenses and skips unconvertible ones', () => {
    const stats = computeTripStats(
      [
        expense({ amount: 4200, currency: 'JPY', base_currency_amount: 21.5 }),
        expense({ amount: 99, currency: 'USD', base_currency_amount: null }), // unconvertible — skipped
        expense({ amount: 10, currency: 'GBP' }),
      ],
      'GBP'
    )
    expect(stats.totalMinor).toBe(2150 + 1000)
    expect(stats.skippedCount).toBe(1)
    expect(stats.expenseCount).toBe(2)
  })

  it('computes superlatives: most expensive meal, cheapest/biggest day, biggest payer', () => {
    const stats = computeTripStats(
      [
        expense({ description: 'Kaiseki', category: 'food', amount: 180, payment_date: '2026-03-14', paid_by: 'a' }),
        expense({ description: 'Conbini', category: 'food', amount: 6, payment_date: '2026-03-15', paid_by: 'b' }),
        expense({ description: 'Lift pass', category: 'activities', amount: 300, payment_date: '2026-03-14', paid_by: 'b' }),
      ],
      'GBP'
    )
    expect(stats.superlatives.mostExpensiveMeal?.description).toBe('Kaiseki')
    expect(stats.superlatives.cheapestDay?.date).toBe('2026-03-15')
    expect(stats.superlatives.biggestSpendDay?.date).toBe('2026-03-14')
    expect(stats.superlatives.biggestPayer?.userId).toBe('b')
  })

  it('handles the empty trip', () => {
    const stats = computeTripStats([], 'GBP')
    expect(stats.totalMinor).toBe(0)
    expect(stats.superlatives.cheapestDay).toBeNull()
    expect(stats.superlatives.biggestPayer).toBeNull()
  })
})

describe('formatMinor', () => {
  it('formats decimal currencies with 2dp and JPY with none', () => {
    expect(formatMinor(123456, 'GBP')).toBe('£1,234.56')
    expect(formatMinor(4200, 'JPY')).toBe('¥4,200')
  })
})

describe('buildSummaryText', () => {
  it('produces a copyable multi-line summary with names resolved', () => {
    const stats = computeTripStats(
      [expense({ description: 'Ramen', category: 'food', amount: 42, paid_by: 'a' })],
      'GBP'
    )
    const text = buildSummaryText('Niseko 2026', stats, new Map([['a', 'Alex']]))
    expect(text).toContain('Niseko 2026 — trip in numbers')
    expect(text).toContain('£42.00')
    expect(text).toContain('Biggest payer: Alex')
    expect(text).toContain('"Ramen"')
  })
})
