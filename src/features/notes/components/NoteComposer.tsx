import { Card, Button, TextArea, Chip, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateNote } from '../../../lib/queries/useNotes'
import { NOTE_TYPE_CONFIG, NOTE_CONTENT_MAX_LENGTH } from '../lib/noteSorting'
import type { NoteType } from '../../../types'

interface NoteFormValues {
  noteType: NoteType
  content: string
}

export interface NoteComposerProps {
  tripId: string
  /** Rendered inline; caller controls whether the composer is shown (e.g. behind a "+ Add note" toggle). */
  onPosted?: () => void
  onCancel?: () => void
  /** Type pre-selected on open, e.g. "announcement" when launched from the Announcements section's "+ Post". Defaults to "note". */
  defaultType?: NoteType
}

/**
 * Note/announcement composer (Form & Flow Standard compliant): type
 * selector, 1000-char-counted content via TextArea's showCount, draft
 * persistence, dirty-close guard.
 */
export function NoteComposer({ tripId, onPosted, onCancel, defaultType = 'note' }: NoteComposerProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createNote = useCreateNote(tripId)

  const draftKey = `note-composer:${tripId}`
  const emptyValues: NoteFormValues = { noteType: defaultType, content: '' }
  const { values, updateField, clearDraft } = useFormDraft<NoteFormValues>(draftKey, emptyValues)

  const isDirty = values.content.trim().length > 0 || values.noteType !== defaultType
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)

  const trimmedLength = values.content.trim().length
  const canPost = trimmedLength > 0 && trimmedLength <= NOTE_CONTENT_MAX_LENGTH

  const handleCancel = () => confirmClose(() => onCancel?.())

  const handleSubmit = async () => {
    if (!user || !canPost) return
    try {
      await createNote.mutateAsync({
        user_id: user.id,
        note_type: values.noteType,
        content: values.content.trim(),
      })
      clearDraft()
      showToast({ type: 'success', message: values.noteType === 'announcement' ? 'Announcement posted' : 'Note posted' })
      onPosted?.()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not post note', description: (err as Error).message })
    }
  }

  return (
    <Card variant="flat">
      <Card.Content>
        <div className="space-y-3">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Type</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(NOTE_TYPE_CONFIG) as NoteType[]).map((type) => (
                <Chip key={type} selected={values.noteType === type} onClick={() => updateField('noteType', type)}>
                  {NOTE_TYPE_CONFIG[type].icon} {NOTE_TYPE_CONFIG[type].label}
                </Chip>
              ))}
            </div>
          </div>

          <TextArea
            label="Message"
            value={values.content}
            onChange={(e) => updateField('content', e.target.value)}
            placeholder="Type your message... (markdown supported)"
            rows={3}
            maxLength={NOTE_CONTENT_MAX_LENGTH}
            showCount
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={createNote.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} isLoading={createNote.isPending} disabled={!canPost}>
              Post
            </Button>
          </div>
        </div>
      </Card.Content>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Card>
  )
}
