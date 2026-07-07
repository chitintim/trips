/**
 * Public surface of the notes feature. v2.1: the Notes TAB is dead — the
 * announcements feed + composer render inside Today (UX_REDESIGN "What
 * dies"), so this barrel exports the feed building blocks (NoteCard,
 * NoteComposer, sorting lib) and no tab config.
 */
export { NoteCard } from './components/NoteCard'
export type { NoteCardProps } from './components/NoteCard'

export { NoteComposer } from './components/NoteComposer'
export type { NoteComposerProps } from './components/NoteComposer'

export { sortNotesForDisplay, formatRelativeTime, NOTE_TYPE_CONFIG, NOTE_TYPE_OPTIONS, NOTE_CONTENT_MAX_LENGTH } from './lib/noteSorting'
export type { NoteTypeStyle } from './lib/noteSorting'
