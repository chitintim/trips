import { useState } from 'react'
import { Button, Input, Modal, Select, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateAction } from '../../../lib/queries/useActions'
import { followupActionTitle } from '../lib/closeDecision'
import { addTodoAndLink, TODO_NOT_LINKED_NOTE } from '../lib/addTodo'
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
  const queryClient = useQueryClient()
  const [linking, setLinking] = useState(false)

  const [title, setTitle] = useState(() => followupActionTitle(winnerTitle))
  const [assignedTo, setAssignedTo] = useState('')
  const [dueDate, setDueDate] = useState('')

  const handleCreate = async () => {
    if (!user || !title.trim()) return
    try {
      setLinking(true)
      const out = await addTodoAndLink({
        createAction: () =>
          createAction.mutateAsync({
            title: title.trim(),
            created_by: user.id,
            assigned_to: assignedTo || null,
            due_date: dueDate || null,
            deadline_kind: 'fixed',
            notes: `From the question "${section.title}" — decided: ${winnerTitle}.`,
          }),
        readMetadata: async () => {
          const { data, error } = await supabase.from('planning_sections').select('metadata').eq('id', section.id).single()
          if (error) throw error
          return data.metadata
        },
        writeMetadata: async (metadata) => {
          const { data, error } = await supabase.from('planning_sections').update({ metadata }).eq('id', section.id).select('id')
          if (error) throw error
          if (!data || data.length === 0) throw new Error("You don't have permission to change this question.")
        },
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
      if (out.linked) showToast({ type: 'success', message: 'To-do added', description: title.trim() })
      else showToast({ type: 'warning', message: 'To-do added', description: TODO_NOT_LINKED_NOTE })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add the to-do', description: (err as Error).message })
    } finally {
      setLinking(false)
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
          <Button variant="ghost" onClick={onClose} disabled={createAction.isPending || linking}>
            Cancel
          </Button>
          <Button onClick={handleCreate} isLoading={createAction.isPending || linking} disabled={!title.trim()}>
            Add to-do
          </Button>
        </div>
      </div>
    </Modal>
  )
}
