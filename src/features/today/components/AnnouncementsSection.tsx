import { useMemo, useState } from 'react'
import { Button, EmptyState, Modal, Skeleton, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useNotes, useDeleteNote } from '../../../lib/queries/useNotes'
import { NoteCard, NoteComposer, sortNotesForDisplay } from '../../notes'
import type { Trip, TripNoteWithUser } from '../../../types'

const COLLAPSED_COUNT = 3

export interface AnnouncementsSectionProps {
  trip: Trip
  isOrganizer: boolean
}

/**
 * Announcements/notes feed + composer, absorbed into Today (the Notes tab
 * died in the v2.1 nav rework — UX_REDESIGN "What dies"). Announcements
 * pin first via sortNotesForDisplay; the feed collapses past the top 3.
 */
export function AnnouncementsSection({ trip, isOrganizer }: AnnouncementsSectionProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: notes, isLoading, isError, refetch } = useNotes(trip.id)
  const deleteNote = useDeleteNote(trip.id)

  const [composerOpen, setComposerOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TripNoteWithUser | null>(null)

  const sorted = useMemo(() => sortNotesForDisplay(notes ?? []), [notes])
  const visible = showAll ? sorted : sorted.slice(0, COLLAPSED_COUNT)

  const handleDelete = async () => {
    if (!pendingDelete) return
    try {
      await deleteNote.mutateAsync(pendingDelete.id)
      showToast({ type: 'success', message: 'Note deleted' })
      setPendingDelete(null)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete note', description: (err as Error).message })
    }
  }

  return (
    <section aria-label="Announcements" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide">Announcements</h2>
        {!composerOpen && (
          <Button size="sm" variant="ghost" onClick={() => setComposerOpen(true)}>
            + Post
          </Button>
        )}
      </div>

      {composerOpen && (
        <NoteComposer
          tripId={trip.id}
          defaultType="announcement"
          onPosted={() => setComposerOpen(false)}
          onCancel={() => setComposerOpen(false)}
        />
      )}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton variant="list" lines={2} />
        </div>
      ) : isError ? (
        <EmptyState
          compact
          icon="⚠️"
          title="Couldn't load announcements"
          description="Something went wrong fetching this trip's notes."
          action={
            <Button size="sm" variant="secondary" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      ) : sorted.length === 0 && !composerOpen ? (
        <p className="text-sm text-[var(--text-muted)]">
          Nothing posted yet.{' '}
          <button className="text-accent-700 hover:underline" onClick={() => setComposerOpen(true)}>
            Share an update with the group →
          </button>
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              canDelete={user?.id === note.user_id || isOrganizer}
              onDelete={setPendingDelete}
            />
          ))}
          {sorted.length > COLLAPSED_COUNT && (
            <button
              className="w-full text-center text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] py-1"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show fewer' : `Show all (${sorted.length})`}
            </button>
          )}
        </div>
      )}

      {pendingDelete && (
        <Modal isOpen onClose={() => setPendingDelete(null)} size="sm" title="Delete this note?">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">This can't be undone.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} isLoading={deleteNote.isPending}>
                Delete note
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
