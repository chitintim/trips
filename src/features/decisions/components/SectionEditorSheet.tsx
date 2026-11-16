import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Input, TextArea, SegmentedControl, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useCreateSection, useQuestionPasses, useUpdateSection, useVotes } from '../../../lib/queries/usePlanning'
import { answersFor } from '../../../lib/answers/answers'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { getDecisionShape, type DecisionShape } from '../lib/decisionShapes'
import { mergeSectionMetadata } from '../lib/resolveDecision'
import { HIDE_OWN_CHOICE_ANSWERS_KEY, NEW_QUESTION_HIDE_RESULTS_DEFAULT, ownChoiceAnswersHidden } from '../lib/answerModel'
import { answerKindChangeWarning } from '../lib/manageActions'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { VotingMethod } from '../lib/voting'

interface SectionFormValues {
  title: string
  description: string
  decisionShape: DecisionShape
  votingMethod: VotingMethod
  hideVotesUntilClose: boolean
  /** Own choice only: metadata key `hide_own_choice_answers` (default off: people see who chose what). */
  hideOwnChoiceAnswers: boolean
  voteDeadline: string
  quorum: string
}

const EMPTY_VALUES: SectionFormValues = {
  title: '',
  description: '',
  decisionShape: 'vote',
  votingMethod: 'single',
  // New questions show results as people answer (owner decision); existing ones keep their stored value.
  hideVotesUntilClose: NEW_QUESTION_HIDE_RESULTS_DEFAULT,
  hideOwnChoiceAnswers: false,
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
    hideOwnChoiceAnswers: ownChoiceAnswersHidden(section.metadata),
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

  // Changing the kind or the way people answer once answers exist: warn, and
  // require an explicit tick before saving. Old answers are never deleted.
  const votesQuery = useVotes(tripId)
  const passesQuery = useQuestionPasses(tripId)
  const answerCount = useMemo(() => {
    if (!section) return 0
    let n = 0
    for (const a of answersFor(section, { votes: votesQuery.data ?? [], passes: passesQuery.passes }).values()) {
      if (a.optionIds.size > 0 || a.passed) n++
    }
    return n
  }, [section, votesQuery.data, passesQuery.passes])
  const kindWarning = isEditing
    ? answerKindChangeWarning({
        answerCount,
        oldKind: seed.decisionShape,
        newKind: values.decisionShape,
        oldMethod: seed.votingMethod,
        newMethod: values.votingMethod,
      })
    : null
  const [ackKindChange, setAckKindChange] = useState(false)
  useEffect(() => {
    if (!kindWarning) setAckKindChange(false)
  }, [kindWarning])

  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  const handleSave = async () => {
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    if (kindWarning && !ackKindChange) {
      showToast({ type: 'error', message: 'Please confirm the change to how people answer' })
      return
    }

    const update = {
      title: values.title.trim(),
      description: values.description.trim() || null,
      // Merge, never replace: a decided question's decided_option_id / followup_action_id live here.
      // The own-choice hide key is written only when turned on (or to switch an existing one off); group choice leaves it alone.
      metadata: mergeSectionMetadata(section?.metadata, {
        decision_shape: values.decisionShape,
        ...(values.decisionShape === 'personal' && (values.hideOwnChoiceAnswers || ownChoiceAnswersHidden(section?.metadata))
          ? { [HIDE_OWN_CHOICE_ANSWERS_KEY]: values.hideOwnChoiceAnswers }
          : {}),
      }),
      voting_method: values.votingMethod,
      hide_votes_until_close: values.hideVotesUntilClose,
      vote_deadline: values.voteDeadline ? new Date(values.voteDeadline).toISOString() : null,
      quorum: values.quorum ? parseInt(values.quorum, 10) : null,
    }

    try {
      if (isEditing) {
        await updateSection.mutateAsync({ id: section!.id, update })
        showToast({ type: 'success', message: 'Question settings updated' })
      } else {
        await createSection.mutateAsync({
          ...update,
          section_type: 'activities',
          status: 'not_started',
          allow_multiple_selections: false,
          order_index: 0,
        })
        showToast({ type: 'success', message: 'Question created' })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save question', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title={isEditing ? 'Question settings' : 'New question'}>
      <div className="space-y-4">
        <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} required autoFocus />
        <TextArea label="Description (optional)" value={values.description} onChange={(e) => updateField('description', e.target.value)} rows={2} />

        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Kind of question</label>
          <SegmentedControl
            fullWidth
            size="sm"
            value={values.decisionShape}
            onChange={(v) => updateField('decisionShape', v)}
            options={[
              { value: 'vote', label: 'Group choice' },
              { value: 'personal', label: 'Own choice' },
            ]}
          />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {values.decisionShape === 'vote'
              ? 'One answer for everyone — the group chooses between options.'
              : 'Each person chooses for themselves (rental gear, lessons). Add options with pricing after saving.'}
          </p>
        </div>

        {kindWarning && (
          <div role="alert" className="space-y-2 rounded-[var(--radius-md)] border border-warning-300 bg-warning-50 p-3 text-sm text-[var(--text-primary)] dark:bg-warning-900/30">
            <p className="font-medium">Change how people answer?</p>
            <p className="break-words text-xs text-[var(--text-secondary)]">{kindWarning}</p>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={ackKindChange} onChange={(e) => setAckKindChange(e.target.checked)} className="mt-0.5 h-5 w-5 accent-accent-600" />
              <span className="text-xs">I understand. Change it anyway.</span>
            </label>
          </div>
        )}

        {values.decisionShape === 'vote' && (
          <>
            <div>
              <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">How people answer</label>
              <SegmentedControl
                fullWidth
                size="sm"
                value={values.votingMethod}
                onChange={(v) => updateField('votingMethod', v)}
                options={[
                  { value: 'single', label: 'Choose one' },
                  { value: 'approval', label: 'Choose any' },
                  { value: 'ranked', label: 'Rank them' },
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Answer by (optional)"
                type="datetime-local"
                value={values.voteDeadline}
                onChange={(e) => updateField('voteDeadline', e.target.value)}
              />
              <Input
                label="Quorum (optional)"
                type="number"
                value={values.quorum}
                onChange={(e) => updateField('quorum', e.target.value)}
                placeholder="e.g. 5 answers"
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
                Hide answers until it's decided
                <span className="block text-xs text-[var(--text-muted)]">
                  Stops people following the crowd. Otherwise everyone sees results as they come in.
                </span>
              </span>
            </label>
          </>
        )}

        {values.decisionShape === 'personal' && (
          <>
            <Input
              label="Answer by (optional)"
              type="datetime-local"
              value={values.voteDeadline}
              onChange={(e) => updateField('voteDeadline', e.target.value)}
              helperText="Shown to the group as when answers close."
            />
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={values.hideOwnChoiceAnswers}
                onChange={(e) => updateField('hideOwnChoiceAnswers', e.target.checked)}
                className="mt-1 w-5 h-5 accent-accent-600"
              />
              <span className="text-sm text-[var(--text-primary)]">
                Hide results until it's decided
                <span className="block text-xs text-[var(--text-muted)]">
                  Off by default: everyone can see who chose what. Turn on to keep choices private until you decide.
                </span>
              </span>
            </label>
          </>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="outline" onClick={handleClose} disabled={createSection.isPending || updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={createSection.isPending || updateSection.isPending} disabled={!!kindWarning && !ackKindChange}>
            {isEditing ? 'Save' : 'Create question'}
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
