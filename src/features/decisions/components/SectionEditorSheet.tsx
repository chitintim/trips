import { useEffect } from 'react'
import { Modal, Button, Input, TextArea, SegmentedControl, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useCreateSection, useUpdateSection } from '../../../lib/queries/usePlanning'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { getDecisionShape, type DecisionShape } from '../lib/decisionShapes'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { VotingMethod } from '../lib/voting'

interface SectionFormValues {
  title: string
  description: string
  decisionShape: DecisionShape
  votingMethod: VotingMethod
  hideVotesUntilClose: boolean
  voteDeadline: string
  quorum: string
}

const EMPTY_VALUES: SectionFormValues = {
  title: '',
  description: '',
  decisionShape: 'vote',
  votingMethod: 'single',
  hideVotesUntilClose: true,
  voteDeadline: '',
  quorum: '',
}

function fromSection(section: SectionWithOptions | null): SectionFormValues {
  if (!section) return EMPTY_VALUES
  return {
    title: section.title,
    description: section.description || '',
    decisionShape: getDecisionShape(section.metadata),
    votingMethod: (section.voting_method as VotingMethod) || 'single',
    hideVotesUntilClose: section.hide_votes_until_close,
    voteDeadline: section.vote_deadline ? section.vote_deadline.slice(0, 16) : '',
    quorum: section.quorum?.toString() || '',
  }
}

interface SectionEditorSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions | null
}

export function SectionEditorSheet({ isOpen, onClose, tripId, section }: SectionEditorSheetProps) {
  const createSection = useCreateSection(tripId)
  const updateSection = useUpdateSection(tripId)
  const { showToast } = useToast()

  const isEditing = !!section
  const draftKey = isEditing ? `section-editor:${section!.id}` : `section-editor:new:${tripId}`
  // Edit mode always seeds from the section record -- draft persistence is
  // disabled so a stale autosave can never leak in (Form & Flow Standard
  // §5.2). Create mode keeps draft persistence.
  const { values, setValues, updateField, clearDraft } = useFormDraft<SectionFormValues>(draftKey, EMPTY_VALUES, {
    enabled: !isEditing,
  })

  useEffect(() => {
    if (isOpen) setValues(fromSection(section))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, section?.id])

  const seed = fromSection(section)
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleSave = async () => {
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    const update = {
      title: values.title.trim(),
      description: values.description.trim() || null,
      metadata: { decision_shape: values.decisionShape },
      voting_method: values.votingMethod,
      hide_votes_until_close: values.hideVotesUntilClose,
      vote_deadline: values.voteDeadline ? new Date(values.voteDeadline).toISOString() : null,
      quorum: values.quorum ? parseInt(values.quorum, 10) : null,
    }

    try {
      if (isEditing) {
        await updateSection.mutateAsync({ id: section!.id, update })
        showToast({ type: 'success', message: 'Poll settings updated' })
      } else {
        await createSection.mutateAsync({
          ...update,
          section_type: 'activities',
          status: 'not_started',
          allow_multiple_selections: false,
          order_index: 0,
        })
        showToast({ type: 'success', message: 'Section created' })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save section', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title={isEditing ? 'Poll settings' : 'New section'}>
      <div className="space-y-4">
        <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} required autoFocus />
        <TextArea label="Description (optional)" value={values.description} onChange={(e) => updateField('description', e.target.value)} rows={2} />

        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Question type</label>
          <SegmentedControl
            fullWidth
            size="sm"
            value={values.decisionShape}
            onChange={(v) => updateField('decisionShape', v)}
            options={[
              { value: 'vote', label: 'Group vote' },
              { value: 'personal', label: 'Personal picks' },
            ]}
          />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {values.decisionShape === 'vote'
              ? 'One winner for everyone — the group votes on options.'
              : "Each person orders their own items (rental gear, lessons) — not a vote. Add catalog items with pricing after saving."}
          </p>
        </div>

        {values.decisionShape === 'vote' && (
          <>
            <div>
              <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Voting method</label>
              <SegmentedControl
                fullWidth
                size="sm"
                value={values.votingMethod}
                onChange={(v) => updateField('votingMethod', v)}
                options={[
                  { value: 'single', label: 'Single choice' },
                  { value: 'approval', label: 'Approve multiple' },
                  { value: 'ranked', label: 'Ranked' },
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Vote deadline (optional)"
                type="datetime-local"
                value={values.voteDeadline}
                onChange={(e) => updateField('voteDeadline', e.target.value)}
              />
              <Input
                label="Quorum (optional)"
                type="number"
                value={values.quorum}
                onChange={(e) => updateField('quorum', e.target.value)}
                placeholder="e.g. 5 voters"
              />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={values.hideVotesUntilClose}
                onChange={(e) => updateField('hideVotesUntilClose', e.target.checked)}
                className="mt-1 w-5 h-5 accent-accent-600"
              />
              <span className="text-sm text-[var(--text-primary)]">
                Hide who voted for what until the poll closes (recommended — reduces herd voting)
              </span>
            </label>
          </>
        )}

        {values.decisionShape === 'personal' && (
          <Input
            label="Order deadline (optional)"
            type="datetime-local"
            value={values.voteDeadline}
            onChange={(e) => updateField('voteDeadline', e.target.value)}
            helperText="Reuses the same deadline field — shown as when orders close, not a vote."
          />
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="outline" onClick={handleClose} disabled={createSection.isPending || updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={createSection.isPending || updateSection.isPending}>
            {isEditing ? 'Save' : 'Create section'}
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
