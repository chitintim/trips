/**
 * Pure sorting/formatting logic for the Notes tab, extracted so the
 * "announcements pinned to top" ordering and relative-time display are
 * independently testable without mounting React.
 */
import type { NoteType, TripNoteWithUser } from '../../../types'

/**
 * Sort notes for display: announcements first (each group internally
 * newest-first), then every other note type newest-first. Stable within
 * each bucket — assumes the input is already newest-first (as the
 * `useNotes` query orders by created_at desc).
 */
export function sortNotesForDisplay<T extends Pick<TripNoteWithUser, 'note_type'>>(notes: T[]): T[] {
  const announcements = notes.filter((n) => n.note_type === 'announcement')
  const rest = notes.filter((n) => n.note_type !== 'announcement')
  return [...announcements, ...rest]
}

/** Relative "Xm ago" / "Xh ago" / "Xd ago" / date fallback, matching legacy TripNotesSection behavior. */
export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
  const date = new Date(timestamp)
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

export interface NoteTypeStyle {
  label: string
  icon: string
  badgeClassName: string
}

export const NOTE_TYPE_CONFIG: Record<NoteType, NoteTypeStyle> = {
  announcement: { label: 'Announcement', icon: '📢', badgeClassName: 'bg-warn-100 text-warn-800 dark:bg-warn-950 dark:text-warn-300' },
  note: { label: 'Note', icon: '📝', badgeClassName: 'bg-accent-100 text-accent-800 dark:bg-accent-950 dark:text-accent-300' },
  reminder: { label: 'Reminder', icon: '⏰', badgeClassName: 'bg-warn-100 text-warn-700 dark:bg-warn-950 dark:text-warn-400' },
  question: { label: 'Question', icon: '❓', badgeClassName: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300' },
  info: { label: 'Info', icon: 'ℹ️', badgeClassName: 'bg-success-100 text-success-800 dark:bg-success-950 dark:text-success-300' },
}

export const NOTE_TYPE_OPTIONS: { value: NoteType; label: string }[] = (Object.keys(NOTE_TYPE_CONFIG) as NoteType[]).map((value) => ({
  value,
  label: `${NOTE_TYPE_CONFIG[value].icon} ${NOTE_TYPE_CONFIG[value].label}`,
}))

export const NOTE_CONTENT_MAX_LENGTH = 1000
