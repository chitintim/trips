import { describe, it, expect } from 'vitest'
import { announcementState, isAnnouncementActive, selectVisibleAnnouncement } from './visibility'

const NOW = new Date('2026-07-19T12:00:00Z')

function announcement(overrides: Partial<{ id: string; starts_at: string; ends_at: string }> = {}) {
  return {
    id: 'a1',
    starts_at: '2026-07-10T00:00:00Z',
    ends_at: '2026-08-02T23:59:59Z',
    ...overrides,
  }
}

describe('announcementState', () => {
  it('is active inside the window', () => {
    expect(announcementState(announcement(), NOW)).toBe('active')
  })

  it('is scheduled before starts_at', () => {
    expect(announcementState(announcement({ starts_at: '2026-07-20T00:00:00Z' }), NOW)).toBe('scheduled')
  })

  it('is expired after ends_at', () => {
    expect(announcementState(announcement({ ends_at: '2026-07-18T00:00:00Z' }), NOW)).toBe('expired')
  })

  it('treats the window boundaries as active (inclusive)', () => {
    expect(announcementState(announcement({ starts_at: NOW.toISOString() }), NOW)).toBe('active')
    expect(announcementState(announcement({ ends_at: NOW.toISOString() }), NOW)).toBe('active')
  })
})

describe('selectVisibleAnnouncement', () => {
  it('returns an active, undismissed announcement', () => {
    const a = announcement()
    expect(selectVisibleAnnouncement([a], [], NOW)).toBe(a)
    expect(isAnnouncementActive(a, NOW)).toBe(true)
  })

  it('skips announcements the user already dismissed (array or Set)', () => {
    const a = announcement()
    expect(selectVisibleAnnouncement([a], ['a1'], NOW)).toBeNull()
    expect(selectVisibleAnnouncement([a], new Set(['a1']), NOW)).toBeNull()
  })

  it('skips scheduled and expired announcements even when undismissed', () => {
    const scheduled = announcement({ id: 'future', starts_at: '2026-07-25T00:00:00Z', ends_at: '2026-08-09T00:00:00Z' })
    const expired = announcement({ id: 'past', starts_at: '2026-06-01T00:00:00Z', ends_at: '2026-06-15T00:00:00Z' })
    expect(selectVisibleAnnouncement([scheduled, expired], [], NOW)).toBeNull()
  })

  it('picks exactly one — the oldest active by starts_at — when several qualify', () => {
    const newer = announcement({ id: 'newer', starts_at: '2026-07-15T00:00:00Z' })
    const older = announcement({ id: 'older', starts_at: '2026-07-01T00:00:00Z' })
    expect(selectVisibleAnnouncement([newer, older], [], NOW)?.id).toBe('older')
  })

  it('moves on to the next announcement once the oldest is dismissed', () => {
    const newer = announcement({ id: 'newer', starts_at: '2026-07-15T00:00:00Z' })
    const older = announcement({ id: 'older', starts_at: '2026-07-01T00:00:00Z' })
    expect(selectVisibleAnnouncement([newer, older], ['older'], NOW)?.id).toBe('newer')
  })

  it('returns null for an empty list', () => {
    expect(selectVisibleAnnouncement([], [], NOW)).toBeNull()
  })
})
