import { describe, it, expect } from 'vitest'
import { computeSplits, validateSplitSum, computeNightsWeightSplitEntries, defaultEntriesForSplitMode } from './computeSplits'
import { toMinorUnits } from '../../../lib/money'
import type { SplitEntry } from './wizardState'

describe('computeSplits - equal mode', () => {
  it('splits evenly with the remainder absorbed (no repeating decimals left dangling)', () => {
    const splits = computeSplits({
      mode: 'equal',
      amountMajor: 10,
      currency: 'GBP',
      participantIds: ['a', 'b', 'c'],
      entries: [],
    })
    const totalMinor = splits.reduce((sum, s) => sum + toMinorUnits(s.amountMajor, 'GBP'), 0)
    expect(totalMinor).toBe(1000) // exactly £10.00, no drift
    expect(splits).toHaveLength(3)
  })

  it('handles a single participant (gets 100%)', () => {
    const splits = computeSplits({ mode: 'equal', amountMajor: 42.5, currency: 'GBP', participantIds: ['solo'], entries: [] })
    expect(splits).toEqual([{ userId: 'solo', amountMajor: 42.5, percentage: null, shares: null }])
  })

  it('returns an empty array with zero participants', () => {
    expect(computeSplits({ mode: 'equal', amountMajor: 10, currency: 'GBP', participantIds: [], entries: [] })).toEqual([])
  })

  it('handles JPY (zero-decimal currency) exactly', () => {
    const splits = computeSplits({ mode: 'equal', amountMajor: 1000, currency: 'JPY', participantIds: ['a', 'b', 'c'], entries: [] })
    const total = splits.reduce((sum, s) => sum + s.amountMajor, 0)
    expect(total).toBe(1000)
  })
})

describe('computeSplits - shares mode', () => {
  it('weights a couple 2x correctly', () => {
    const entries: SplitEntry[] = [
      { userId: 'couple', value: '2' },
      { userId: 'single1', value: '1' },
      { userId: 'single2', value: '1' },
    ]
    const splits = computeSplits({
      mode: 'shares',
      amountMajor: 400,
      currency: 'GBP',
      participantIds: ['couple', 'single1', 'single2'],
      entries,
    })
    const couple = splits.find((s) => s.userId === 'couple')!
    const single1 = splits.find((s) => s.userId === 'single1')!
    expect(couple.amountMajor).toBe(200)
    expect(single1.amountMajor).toBe(100)
  })

  it('defaults an unset/invalid weight to 1', () => {
    const entries: SplitEntry[] = [{ userId: 'a', value: '' }]
    const splits = computeSplits({ mode: 'shares', amountMajor: 100, currency: 'GBP', participantIds: ['a', 'b'], entries })
    expect(splits[0].shares).toBe(1)
  })
})

describe('computeSplits - percentage mode', () => {
  it('converts percentages to exact amounts summing to the total', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '30' },
      { userId: 'b', value: '70' },
    ]
    const splits = computeSplits({ mode: 'percentage', amountMajor: 100, currency: 'GBP', participantIds: ['a', 'b'], entries })
    expect(splits.find((s) => s.userId === 'a')!.amountMajor).toBe(30)
    expect(splits.find((s) => s.userId === 'b')!.amountMajor).toBe(70)
  })

  it('handles a rounding-prone percentage split (33/33/34) exactly', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '33.33' },
      { userId: 'b', value: '33.33' },
      { userId: 'c', value: '33.34' },
    ]
    const splits = computeSplits({ mode: 'percentage', amountMajor: 100, currency: 'GBP', participantIds: ['a', 'b', 'c'], entries })
    const total = splits.reduce((sum, s) => sum + toMinorUnits(s.amountMajor, 'GBP'), 0)
    expect(total).toBe(10000)
  })
})

describe('computeSplits - custom mode', () => {
  it('passes through user-entered exact amounts unmodified', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '12.34' },
      { userId: 'b', value: '87.66' },
    ]
    const splits = computeSplits({ mode: 'custom', amountMajor: 100, currency: 'GBP', participantIds: ['a', 'b'], entries })
    expect(splits.find((s) => s.userId === 'a')!.amountMajor).toBe(12.34)
    expect(splits.find((s) => s.userId === 'b')!.amountMajor).toBe(87.66)
  })
})

describe('validateSplitSum', () => {
  it('validates a custom split that sums exactly to the amount', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '50' },
      { userId: 'b', value: '50' },
    ]
    const result = validateSplitSum('custom', entries, ['a', 'b'], 100, 'GBP')
    expect(result.isValid).toBe(true)
  })

  it('rejects a custom split that does not sum to the amount', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '40' },
      { userId: 'b', value: '50' },
    ]
    const result = validateSplitSum('custom', entries, ['a', 'b'], 100, 'GBP')
    expect(result.isValid).toBe(false)
    expect(result.deltaMajor).toBe(-10)
  })

  it('validates a percentage split summing to exactly 100', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '60' },
      { userId: 'b', value: '40' },
    ]
    const result = validateSplitSum('percentage', entries, ['a', 'b'], 100, 'GBP')
    expect(result.isValid).toBe(true)
  })

  it('rejects a percentage split not summing to 100', () => {
    const entries: SplitEntry[] = [
      { userId: 'a', value: '60' },
      { userId: 'b', value: '30' },
    ]
    const result = validateSplitSum('percentage', entries, ['a', 'b'], 100, 'GBP')
    expect(result.isValid).toBe(false)
  })
})

describe('defaultEntriesForSplitMode', () => {
  it('defaults percentage to an equal split summing to exactly 100 (largest remainder)', () => {
    const entries = defaultEntriesForSplitMode('percentage', ['a', 'b', 'c'])
    const sum = entries.reduce((acc, e) => acc + parseFloat(e.value), 0)
    expect(Math.round(sum * 100) / 100).toBe(100)
    // 100/3 = 33.33 repeating -- largest remainder hands the odd cent to one entry.
    const values = entries.map((e) => e.value).sort()
    expect(values).toEqual(['33.33', '33.33', '33.34'])
  })

  it('never reuses a raw amount as a percentage (regression: ¥4200 bug)', () => {
    // The bug: switching to Percentage on a single-participant ¥4200 expense
    // showed "4200" in the percent field (a leftover raw amount). The fresh
    // default for a single participant must be 100, never the item total.
    const entries = defaultEntriesForSplitMode('percentage', ['solo'])
    expect(entries).toEqual([{ userId: 'solo', value: '100.00' }])
  })

  it('defaults shares to 1 for every participant', () => {
    const entries = defaultEntriesForSplitMode('shares', ['a', 'b'])
    expect(entries).toEqual([
      { userId: 'a', value: '1' },
      { userId: 'b', value: '1' },
    ])
  })

  it('defaults custom to blank (never inherits another mode\'s raw value)', () => {
    const entries = defaultEntriesForSplitMode('custom', ['a', 'b'])
    expect(entries).toEqual([
      { userId: 'a', value: '' },
      { userId: 'b', value: '' },
    ])
  })

  it('returns an empty array with zero participants', () => {
    expect(defaultEntriesForSplitMode('percentage', [])).toEqual([])
  })
})

describe('computeNightsWeightSplitEntries', () => {
  it('produces share entries usable directly by computeSplits shares mode', () => {
    const events = [
      {
        id: 'ev1',
        trip_id: 'trip-1',
        title: 'Bob arrives',
        category: 'flight' as const,
        event_date: '2026-08-04',
        start_time: null,
        end_time: null,
        all_day: null,
        description: null,
        location: null,
        metadata: null,
        participant_ids: ['bob'],
        place_id: null,
        sort_order: null,
        source_option_id: null,
        created_by: 'alice',
        created_at: null,
        updated_at: null,
      },
    ]
    const entries = computeNightsWeightSplitEntries(['alice', 'bob'], events, '2026-08-01', '2026-08-08')
    expect(entries.find((e) => e.userId === 'alice')!.value).toBe('7')
    expect(entries.find((e) => e.userId === 'bob')!.value).toBe('4')

    const splits = computeSplits({
      mode: 'shares',
      amountMajor: 1100,
      currency: 'GBP',
      participantIds: ['alice', 'bob'],
      entries,
    })
    const total = splits.reduce((sum, s) => sum + toMinorUnits(s.amountMajor, 'GBP'), 0)
    expect(total).toBe(110000)
    expect(splits.find((s) => s.userId === 'bob')!.amountMajor).toBeLessThan(splits.find((s) => s.userId === 'alice')!.amountMajor)
  })
})
