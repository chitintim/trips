import { useState } from 'react'
import { Button, Input, Modal, Select, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useCreateAction } from '../../../lib/queries/useActions'
import { buildDecisionMetadata, followupActionTitle } from '../lib/closeDecision'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface AddTodoSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions
  winnerTitle: string
  participants: ParticipantWithUser[]
}

/**
 * "Add a to-do" for a decided question: title (prefilled 'Book "X"'), who
 * does it, optional due date. Creates the to-do and stamps its id into the
 * question's metadata (followup_action_id) so the outcome can show it from
 * then on. Deliberately not a workflow engine.
 */
export function AddTodoSheet({ isOpen, onClose, tripId, section, winnerTitle, participants }: AddTodoSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createAction = useCreateAction(tripId)
  const updateSection = useUpdateSection(tripId)

  const [title, setTitle] = useState(() => followupActionTitle(winnerTitle))
  const [assignedTo, setAssignedTo] = useState('')
  const [dueDate, setDueDate] = useState('')

  const handleCreate = async () => {
    if (!user || !title.trim()) return
    try {
      const action = await createAction.mutateAsync({
        title: title.trim(),
        created_by: user.id,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        deadline_kind: 'fixed',
        notes: `From the question "${section.title}" — decided: ${winnerTitle}.`,
      })
      await updateSection.mutateAsync({
        id: section.id,
        update: { metadata: buildDecisionMetadata(section.metadata, { followup_action_id: action.id }) },
      })
      showToast({ type: 'success', message: 'To-do added', description: title.trim() })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add the to-do', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Add a to-do">
      <div className="space-y-4">
        <Input label="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} required fullWidth />
        <Select
          label="Who does it?"
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          placeholder="Everyone"
          fullWidth
          options={participants.map((p) => ({
            value: p.user_id,
            label: p.user?.full_name || p.user?.email || 'Unknown',
          }))}
        />
        <Input label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} fullWidth />
        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={createAction.isPending || updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} isLoading={createAction.isPending || updateSection.isPending} disabled={!title.trim()}>
            Add to-do
          </Button>
        </div>
      </div>
    </Modal>
  )
}
