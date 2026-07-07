import { describe, it, expect } from 'vitest'
import { isPastDay, shouldDensifyDay, isDensifiableStage, summarizeDayItems, DENSE_ITEM_THRESHOLD } from './density'

describe('isPastDay', () => {
  it('is true strictly before today', () => {
    expect(isPastDay('2026-07-06', '2026-07-07')).toBe(true)
  })
  it('is false for today or a future date', () => {
    expect(isPastDay('2026-07-07', '2026-07-07')).toBe(false)
    expect(isPastDay('2026-07-08', '2026-07-07')).toBe(false)
  })
})

describe('shouldDensifyDay', () => {
  it('is true for any past day regardless of item count', () => {
    expect(shouldDensifyDay(1, '2026-07-01', '2026-07-07')).toBe(true)
  })
  it('is false for a today/future day at or below the threshold', () => {
    expect(shouldDensifyDay(DENSE_ITEM_THRESHOLD, '2026-07-07', '2026-07-07')).toBe(false)
  })
  it('is true for a today/future day above the threshold', () => {
    expect(shouldDensifyDay(DENSE_ITEM_THRESHOLD + 1, '2026-07-07', '2026-07-07')).toBe(true)
  })
})

describe('isDensifiableStage', () => {
  it('is true only for decided/booked', () => {
    expect(isDensifiableStage('decided')).toBe(true)
    expect(isDensifiableStage('booked')).toBe(true)
    expect(isDensifiableStage('proposal')).toBe(false)
    expect(isDensifiableStage('idea')).toBe(false)
  })
})

describe('summarizeDayItems', () => {
  it('summarizes a mixed day with a stable category order and a cap of 3 breakdown parts', () => {
    const items = [
      { category: 'dining' },
      { category: 'dining' },
      { category: 'transfer' },
      { category: 'activity' },
      { category: 'flight' },
      { category: null },
    ]
    expect(summarizeDayItems(items)).toBe('6 items · 1 flight · 1 activity · 2 meals')
  })

  it('handles a single item with singular labels', () => {
    expect(summarizeDayItems([{ category: 'dining' }])).toBe('1 item · 1 meal')
  })

  it('falls back to just a count when every item is uncategorized ("other" is never shown as a breakdown part)', () => {
    expect(summarizeDayItems([{ category: null }, { category: null }])).toBe('2 items')
  })

  it('handles zero items', () => {
    expect(summarizeDayItems([])).toBe('0 items')
  })
})
