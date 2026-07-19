import { Card, Markdown, UserAvatar } from '../../../components/ui'
import { NOTE_TYPE_CONFIG, formatRelativeTime } from '../lib/noteSorting'
import type { TripNoteWithUser } from '../../../types'

export interface NoteCardProps {
  note: TripNoteWithUser
  canDelete: boolean
  onDelete: (note: TripNoteWithUser) => void
}

/**
 * A single note/announcement card: type badge with a distinct accent,
 * author avatar + relative time, markdown-rendered content, and a delete
 * action for the author or organizer.
 */
export function NoteCard({ note, canDelete, onDelete }: NoteCardProps) {
  const config = NOTE_TYPE_CONFIG[note.note_type]
  const isAnnouncement = note.note_type === 'announcement'

  return (
    <Card variant={isAnnouncement ? 'default' : 'flat'} className={isAnnouncement ? 'border-warn-300' : undefined}>
      <Card.Content>
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium ${config.badgeClassName}`}>
              {config.icon} {config.label}
            </span>
            <span className="flex items-center gap-1.5">
              <UserAvatar avatarData={note.user} size="xs" />
              <span className="text-sm font-medium text-[var(--text-primary)]">{note.user?.full_name || note.user?.email || 'Unknown'}</span>
            </span>
            <span className="text-xs text-[var(--text-muted)]">{formatRelativeTime(note.created_at)}</span>
          </div>
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(note)}
              className="shrink-0 rounded px-2 py-1 text-xs text-danger-600 hover:bg-danger-50 dark:hover:bg-danger-950"
            >
              Delete
            </button>
          )}
        </div>

        {/* Shared Markdown component: the previous `prose`-classed
            ReactMarkdown relied on the (uninstalled) typography plugin, so
            lists/headings/links rendered visually as raw text. */}
        <Markdown className="text-sm text-[var(--text-secondary)]">{note.content}</Markdown>
      </Card.Content>
    </Card>
  )
}
