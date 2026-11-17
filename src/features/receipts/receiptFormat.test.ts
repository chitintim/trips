import { describe, it, expect } from 'vitest'
import { formatDeadline, formatDeadlineDay, pickDeadline, replyByLine, eveningUtc } from './receiptFormat'

describe('formatDeadline', () => {
  it('shows the reader’s clock first and the UTC time in brackets', () => {
    expect(formatDeadline('2026-11-20T18:00:00Z', 'Europe/Paris')).toBe('Fri 20 Nov, 19:00 (18:00 UTC)')
    expect(replyByLine('2026-11-20T18:00:00Z', 'Europe/Paris')).toBe('Reply by Fri 20 Nov, 19:00 (18:00 UTC)')
  })
  it('names the UTC day too when it is another day, and shows plain UTC for a UTC reader', () => {
    expect(formatDeadline('2026-11-20T18:00:00Z', 'Asia/Tokyo')).toBe('Sat 21 Nov, 03:00 (Fri 20 Nov, 18:00 UTC)')
    expect(formatDeadline('2026-11-20T18:00:00Z', 'UTC')).toBe('Fri 20 Nov, 18:00 UTC')
  })
  it('gives nothing for a bad date', () => expect(formatDeadline('nope')).toBe(''))
})

describe('formatDeadlineDay', () => {
  it('is the reader’s own day, the same one the to-dos show', () => {
    expect(formatDeadlineDay('2026-11-20T18:00:00Z', 'Pacific/Auckland')).toBe('Sat 21 Nov')
    expect(formatDeadlineDay('2026-11-20T18:00:00Z', 'UTC')).toBe('Fri 20 Nov')
    expect(formatDeadlineDay('nope')).toBe('')
  })
})

describe('pickDeadline', () => {
  const now = new Date('2026-11-17T10:00:00Z')
  it('tomorrow / 1 week are 18:00 UTC and sent explicitly; 3 days leaves it to the server', () => {
    expect(pickDeadline('tomorrow', now)).toEqual({ ok: true, iso: '2026-11-18T18:00:00.000Z', send: '2026-11-18T18:00:00.000Z' })
    expect(pickDeadline('week', now)).toMatchObject({ ok: true, iso: '2026-11-24T18:00:00.000Z' })
    expect(pickDeadline('three_days', now)).toEqual({ ok: true, iso: '2026-11-20T18:00:00.000Z', send: null })
    expect(eveningUtc(now, 3).toISOString()).toBe('2026-11-20T18:00:00.000Z')
  })
  it('checks a picked time', () => {
    expect(pickDeadline('custom', now, '')).toMatchObject({ ok: false })
    expect(pickDeadline('custom', now, '2026-11-16T10:00')).toEqual({ ok: false, error: 'Pick a time in the future.' })
    expect(pickDeadline('custom', now, '2027-06-01T10:00')).toEqual({ ok: false, error: 'Pick a time within 90 days.' })
    expect(pickDeadline('custom', now, '2026-11-25T10:00')).toMatchObject({ ok: true })
  })
})
