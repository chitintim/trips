import { describe, it, expect } from 'vitest'
import { sortNotesForDisplay, formatRelativeTime } from './noteSorting'
import type { NoteType } from '../../../types'

function note(id: string, note_type: NoteType) {
  return { id, note_type }
}

describe('sortNotesForDisplay', () => {
  it('pins announcements to the top, preserving relative order within each bucket', () => {
    const notes = [note('1', 'note'), note('2', 'announcement'), note('3', 'reminder'), note('4', 'announcement')]
    const sorted = sortNotesForDisplay(notes)
    expect(sorted.map((n) => n.id)).toEqual(['2', '4', '1', '3'])
  })

  it('is a no-op when there are no announcements', () => {
    const notes = [note('1', 'note'), note('2', 'reminder')]
    expect(sortNotesForDisplay(notes).map((n) => n.id)).toEqual(['1', '2'])
  })

  it('handles an empty list', () => {
    expect(sortNotesForDisplay([])).toEqual([])
  })

  it('handles all-announcement lists', () => {
    const notes = [note('1', 'announcement'), note('2', 'announcement')]
    expect(sortNotesForDisplay(notes).map((n) => n.id)).toEqual(['1', '2'])
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-06T12:00:00Z')

  it('shows "Just now" for sub-minute-old notes', () => {
    expect(formatRelativeTime('2026-07-06T11:59:45Z', now)).toBe('Just now')
  })

  it('shows minutes for under an hour', () => {
    expect(formatRelativeTime('2026-07-06T11:45:00Z', now)).toBe('15m ago')
  })

  it('shows hours for under a day', () => {
    expect(formatRelativeTime('2026-07-06T06:00:00Z', now)).toBe('6h ago')
  })

  it('shows days for under a week', () => {
    expect(formatRelativeTime('2026-07-03T12:00:00Z', now)).toBe('3d ago')
  })

  it('falls back to a date for a week or older', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00Z', now)).toBe('1 Jun')
  })

  it('includes the year when the note is from a different year', () => {
    expect(formatRelativeTime('2025-06-01T12:00:00Z', now)).toBe('1 Jun 2025')
  })
})
