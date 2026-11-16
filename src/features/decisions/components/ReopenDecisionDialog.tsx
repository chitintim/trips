import { Modal, Button, useToast } from '../../../components/ui'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { buildReopenUpdate } from '../lib/resolveDecision'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'

export interface ReopenDecisionDialogProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: SectionWithOptions | null
  /** Title of the currently decided option, for the activity entry / copy. */
  decidedTitle?: string | null
  /** Wording overrides, for offering the reopen after a cancelled booking. */
  heading?: string
  intro?: string
  confirmLabel?: string
  cancelLabel?: string
}

/**
 * Organizer/admin "Reopen": sets the question back to open, clears
 * the recorded winner (and its follow-up link) and KEEPS all votes. Anything
 * already created from the outcome (a scheduled event, a booking, a follow-up
 * action) is deliberately NOT touched -- the confirm copy says so.
 */
export function ReopenDecisionDialog({ isOpen, onClose, tripId, section, decidedTitle, heading, intro, confirmLabel, cancelLabel }: ReopenDecisionDialogProps) {
  const updateSection = useUpdateSection(tripId)
  const logActivity = useTripActivityLog(tripId)
  const { showToast } = useToast()

  if (!section) return null

  const handleReopen = async () => {
    try {
      await updateSection.mutateAsync({ id: section.id, update: buildReopenUpdate(section.metadata) })
      logActivity({
        verb: 'decision_reopened',
        entity: { type: 'section', id: section.id, label: section.title },
        metadata: { previous_option: decidedTitle ?? null },
      })
      showToast({ type: 'success', message: 'Question reopened', description: 'It is open again and existing answers were kept.' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not reopen the question', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={heading ?? `Reopen "${section.title}"?`}>
      <div className="space-y-3">
        {intro && <p className="text-sm text-[var(--text-secondary)]">{intro}</p>}
        <p className="text-sm text-[var(--text-secondary)]">
          {decidedTitle ? `"${decidedTitle}" will no longer be the answer. ` : ''}
          The question opens again and everyone's existing answers are kept.
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          Anything already created from the answer, like something on the plan, a booking or a to-do, is{' '}
          <strong>not undone automatically</strong>. Remove or update those yourself if they no longer apply.
        </p>
        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose} disabled={updateSection.isPending}>
            {cancelLabel ?? 'Cancel'}
          </Button>
          <Button onClick={handleReopen} isLoading={updateSection.isPending}>
            {confirmLabel ?? 'Reopen question'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
