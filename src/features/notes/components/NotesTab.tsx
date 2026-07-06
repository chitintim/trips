import { useMemo, useState } from 'react'
import { Button, EmptyState, Skeleton, Modal, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useNotes, useDeleteNote } from '../../../lib/queries/useNotes'
import { useParticipants } from '../../../lib/queries/useTrip'
import { NoteCard } from './NoteCard'
import { NoteComposer } from './NoteComposer'
import { sortNotesForDisplay } from '../lib/noteSorting'
import type { Trip, TripNoteWithUser } from '../../../types'

export interface NotesTabProps {
  trip: Trip
}

/**
 * Trip notes & announcements tab (plan §Notes): announcements pinned to
 * top, type-badged cards with author + relative time + markdown content,
 * and a Form-Standard composer. Delete is available to the note's author
 * or the trip organizer.
 */
export function NotesTab({ trip }: NotesTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: notes, isLoading } = useNotes(trip.id)
  const { data: participants } = useParticipants(trip.id)
  const deleteNote = useDeleteNote(trip.id)

  const [showComposer, setShowComposer] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TripNoteWithUser | null>(null)

  const myParticipant = (participants ?? []).find((p) => p.user_id === user?.id)
  const isOrganizer = myParticipant?.role === 'organizer' || trip.created_by === user?.id

  const sortedNotes = useMemo(() => sortNotesForDisplay(notes ?? []), [notes])

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

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="card" height={80} />
        <Skeleton variant="card" height={80} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Notes & Announcements</h2>
          <p className="text-sm text-[var(--text-muted)]">Share information, reminders, and questions with the group</p>
        </div>
        {!showComposer && (
          <Button size="sm" onClick={() => setShowComposer(true)}>
            + Add note
          </Button>
        )}
      </div>

      {showComposer && (
        <NoteComposer
          tripId={trip.id}
          onPosted={() => setShowComposer(false)}
          onCancel={() => setShowComposer(false)}
        />
      )}

      {sortedNotes.length === 0 ? (
        <EmptyState
          icon="💬"
          title="No notes yet"
          description="Be the first to add a note or announcement for this trip."
          action={!showComposer ? <Button onClick={() => setShowComposer(true)}>+ Add note</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {sortedNotes.map((note) => {
            const isOwnNote = user?.id === note.user_id
            return (
              <NoteCard
                key={note.id}
                note={note}
                canDelete={isOwnNote || isOrganizer}
                onDelete={setPendingDelete}
              />
            )
          })}
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
    </div>
  )
}
