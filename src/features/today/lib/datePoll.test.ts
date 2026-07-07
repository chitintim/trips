import { describe, it, expect } from 'vitest'
import {
  parseDatesPending,
  mergeChaseSettingsJson,
  optionDateRange,
  computeDatePollWinner,
  isDatePollClosed,
} from './datePoll'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'

const option = (id: string, start: string, end: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    title: `${start} – ${end}`,
    status: 'proposed',
    metadata: { date_range: { start, end } },
    selections: [],
    ...overrides,
  }) as unknown as SectionWithOptions['options'][number]

const vote = (optionId: string, userId: string) =>
  ({ id: `${optionId}-${userId}`, option_id: optionId, user_id: userId, rank: null, created_at: '' }) as OptionVote

describe('parseDatesPending / mergeChaseSettingsJson', () => {
  it('round-trips the pending flag and section id', () => {
    const merged = mergeChaseSettingsJson({ enabled: true, max_reminders: 2 }, {
      dates_pending: true,
      dates_section_id: 'sec-1',
    })
    expect(parseDatesPending(merged)).toEqual({ pending: true, sectionId: 'sec-1' })
    // Unknown-to-us keys survive.
    expect((merged as Record<string, unknown>).enabled).toBe(true)
    expect((merged as Record<string, unknown>).max_reminders).toBe(2)
  })

  it('clears keys when patched with null', () => {
    const merged = mergeChaseSettingsJson({ dates_pending: true, dates_section_id: 's' }, { dates_pending: null, dates_section_id: null })
    expect(parseDatesPending(merged)).toEqual({ pending: false, sectionId: null })
  })

  it('handles null/absent chase_settings', () => {
    expect(parseDatesPending(null)).toEqual({ pending: false, sectionId: null })
    expect(parseDatesPending(undefined)).toEqual({ pending: false, sectionId: null })
    const merged = mergeChaseSettingsJson(null, { dates_pending: true })
    expect(parseDatesPending(merged).pending).toBe(true)
  })
})

describe('optionDateRange', () => {
  it('reads the wizard convention', () => {
    expect(optionDateRange({ date_range: { start: '2026-08-01', end: '2026-08-05' } })).toEqual({
      start: '2026-08-01',
      end: '2026-08-05',
    })
  })
  it('is null for malformed metadata', () => {
    expect(optionDateRange(null)).toBeNull()
    expect(optionDateRange({})).toBeNull()
    expect(optionDateRange({ date_range: { start: '2026-08-01' } })).toBeNull()
  })
})

describe('computeDatePollWinner', () => {
  const section = (opts: SectionWithOptions['options']) =>
    ({ id: 'sec', title: 'Trip dates', status: 'in_progress', vote_deadline: null, options: opts }) as unknown as SectionWithOptions

  it('picks the most-voted range', () => {
    const s = section([option('a', '2026-08-01', '2026-08-05'), option('b', '2026-08-10', '2026-08-14')])
    const winner = computeDatePollWinner(s, [vote('b', 'u1'), vote('b', 'u2'), vote('a', 'u3')])
    expect(winner?.optionId).toBe('b')
    expect(winner?.range).toEqual({ start: '2026-08-10', end: '2026-08-14' })
  })

  it('breaks ties toward the earliest start', () => {
    const s = section([option('later', '2026-08-10', '2026-08-14'), option('earlier', '2026-08-01', '2026-08-05')])
    const winner = computeDatePollWinner(s, [vote('later', 'u1'), vote('earlier', 'u2')])
    expect(winner?.optionId).toBe('earlier')
  })

  it('ignores cancelled options and options without ranges', () => {
    const s = section([
      option('cancelled', '2026-08-01', '2026-08-05', { status: 'cancelled' }),
      option('no-range', '2026-08-10', '2026-08-14', { metadata: {} }),
      option('ok', '2026-08-20', '2026-08-24'),
    ])
    const winner = computeDatePollWinner(s, [vote('cancelled', 'u1'), vote('cancelled', 'u2')])
    expect(winner?.optionId).toBe('ok')
  })

  it('is null when nothing usable exists', () => {
    expect(computeDatePollWinner(section([]), [])).toBeNull()
  })
})

describe('isDatePollClosed', () => {
  const now = new Date('2026-07-07T12:00:00Z').getTime()
  it('closed when deadline passed or section completed', () => {
    expect(isDatePollClosed({ status: 'in_progress', vote_deadline: '2026-07-01T00:00:00Z' }, now)).toBe(true)
    expect(isDatePollClosed({ status: 'completed', vote_deadline: null }, now)).toBe(true)
  })
  it('open otherwise', () => {
    expect(isDatePollClosed({ status: 'in_progress', vote_deadline: '2026-07-20T00:00:00Z' }, now)).toBe(false)
    expect(isDatePollClosed({ status: 'in_progress', vote_deadline: null }, now)).toBe(false)
  })
})
