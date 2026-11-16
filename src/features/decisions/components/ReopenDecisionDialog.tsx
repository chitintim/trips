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
}

/**
 * Organizer/admin "Reopen decision": sets the question back to open, clears
 * the recorded winner (and its follow-up link) and KEEPS all votes. Anything
 * already created from the outcome (a scheduled event, a booking, a follow-up
 * action) is deliberately NOT touched -- the confirm copy says so.
 */
export function ReopenDecisionDialog({ isOpen, onClose, tripId, section, decidedTitle }: ReopenDecisionDialogProps) {
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
      showToast({ type: 'success', message: 'Decision reopened', description: 'Voting is open again; existing votes were kept.' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not reopen the decision', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Reopen "${section.title}"?`}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--text-secondary)]">
          {decidedTitle ? `"${decidedTitle}" will no longer be the decision. ` : ''}
          Voting opens again and everyone's existing votes are kept.
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          Anything already created from this decision -- a scheduled event, a booking, a follow-up action -- is{' '}
          <strong>not undone automatically</strong>. Remove or update those yourself if they no longer apply.
        </p>
        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose} disabled={updateSection.isPending}>
            Cancel
          </Button>
          <Button onClick={handleReopen} isLoading={updateSection.isPending}>
            Reopen decision
          </Button>
        </div>
      </div>
    </Modal>
  )
}
