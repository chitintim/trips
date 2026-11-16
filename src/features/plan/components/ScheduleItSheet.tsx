import { useEffect, useState } from 'react'
import { Modal, Button, Input, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useSections, useUpdateSection } from '../../../lib/queries/usePlanning'
import { buildDecisionMetadata } from '../../decisions/lib/closeDecision'
import { getDecisionShape } from '../../decisions/lib/decisionShapes'
import { useTripActivityLog } from '../../organizer/lib/activity'
import type { Trip } from '../../../types'
import type { PlanItem } from '../lib/planItems'

export interface ScheduleItSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  item: PlanItem | null
}

/**
 * "Put it on the plan" one-tap scheduling (plan §2 end + §6): a day/time
 * picker that turns a decided-but-undated option (a closed poll's winner,
 * or any decided item lacking a date) into a real timeline event carrying
 * `source_option_id`, so the option and the event become the same item
 * going forward (composePlanItems' absorption rule). Logs
 * 'poll_closed'/'event_added' via the organizer activity helper per the
 * plan's instruction to reuse it rather than hand-rolling activity rows.
 */
export function ScheduleItSheet({ isOpen, onClose, trip, item }: ScheduleItSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createEvent = useCreateTimelineEvent(trip.id)
  const { data: sections } = useSections(trip.id)
  const updateSection = useUpdateSection(trip.id)
  const logActivity = useTripActivityLog(trip.id)

  const [date, setDate] = useState(trip.start_date)
  const [startTime, setStartTime] = useState('')

  useEffect(() => {
    if (isOpen) {
      setDate(trip.start_date)
      setStartTime('')
    }
  }, [isOpen, trip.start_date])

  if (!item) return null

  const section = item.optionId && item.sectionId ? (sections || []).find((s) => s.id === item.sectionId) : undefined
  // Personal-order (shape 2) sections are never "won" by one option --
  // scheduling one catalog item must not close the whole question.
  const sectionToClose = section && section.status !== 'completed' && getDecisionShape(section.metadata) !== 'personal' ? section : null
  const closesVote = !!sectionToClose

  const handleSchedule = async () => {
    if (!user || !date) {
      showToast({ type: 'error', message: 'Please pick a day' })
      return
    }

    // Scheduling an option IS deciding its question: close the section and
    // stamp the decided option (closeDecision.ts) in ONE write, BEFORE creating
    // the event. Order matters: if closing fails we abort with nothing created;
    // if the event insert then fails we put the question back as it was, so a
    // failure can never leave a closed question without a recorded winner (or
    // an absorbed leader on a still-open ballot).
    const closing = closesVote ? sectionToClose : null
    let closedSection = false
    try {
      if (closing) {
        await updateSection.mutateAsync({
          id: closing.id,
          update: {
            status: 'completed',
            metadata: buildDecisionMetadata(closing.metadata, { decided_option_id: item.optionId! }),
          },
        })
        closedSection = true
      }
      await createEvent.mutateAsync({
        trip_id: trip.id,
        created_by: user.id,
        title: item.title,
        description: item.description,
        category: (item.category as never) || 'other',
        event_date: date,
        all_day: !startTime,
        start_time: startTime || null,
        place_id: item.placeId,
        source_option_id: item.optionId,
      })
      if (closedSection) logActivity({ verb: 'poll_closed', entity: { type: 'option', id: item.optionId ?? undefined, label: item.title } })
      logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: item.title } })
      showToast({ type: 'success', message: `"${item.title}" is on the plan` })
      onClose()
    } catch (err) {
      if (closedSection && closing) {
        try {
          await updateSection.mutateAsync({ id: closing.id, update: { status: closing.status, metadata: closing.metadata } })
        } catch {
          /* best effort: the winner stamp is still recorded, so the question stays consistent */
        }
      }
      showToast({ type: 'error', message: 'Could not schedule this', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Schedule "${item.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">Pick a day (and optionally a time) to put this on the plan.</p>
        {closesVote && (
          <p className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-2.5 text-sm text-[var(--text-secondary)]">
            "{sectionToClose!.title}" is still open. Scheduling this will <strong>close the question</strong> and record "{item.title}" as the answer.
          </p>
        )}
        {/* [&>*]:min-w-0 — grid items default to min-width:auto, and native
            date/time inputs have a large intrinsic min-content width, so
            without this the row overflows the sheet at 375px (same fix as
            TravelDetailsSheet). */}
        <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <Input label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Input label="Time (optional)" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose} disabled={createEvent.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSchedule} isLoading={createEvent.isPending || updateSection.isPending}>
            {closesVote ? 'Close question & schedule' : 'Put it on the plan'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
