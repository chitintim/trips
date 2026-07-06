/**
 * Public surface of the notes feature (owns src/features/notes/**). Other
 * features/pages should only import from this barrel.
 */
import type { ComponentType } from 'react'
import { NotesTab, type NotesTabProps } from './components/NotesTab'

export { NotesTab } from './components/NotesTab'
export type { NotesTabProps } from './components/NotesTab'

export { NoteCard } from './components/NoteCard'
export type { NoteCardProps } from './components/NoteCard'

export { NoteComposer } from './components/NoteComposer'
export type { NoteComposerProps } from './components/NoteComposer'

export { sortNotesForDisplay, formatRelativeTime, NOTE_TYPE_CONFIG, NOTE_TYPE_OPTIONS, NOTE_CONTENT_MAX_LENGTH } from './lib/noteSorting'
export type { NoteTypeStyle } from './lib/noteSorting'

export const notesTabConfig: {
  tabId: 'notes'
  label: string
  icon: string
  Component: ComponentType<NotesTabProps>
} = {
  tabId: 'notes',
  label: 'Notes',
  icon: '💬',
  Component: NotesTab,
}
