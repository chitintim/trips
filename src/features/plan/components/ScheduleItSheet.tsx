import { useEffect, useState } from 'react'
import { Modal, Button, Input, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateTimelineEvent } from '../../../lib/queries/useTimeline'
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

  const handleSchedule = async () => {
    if (!user || !date) {
      showToast({ type: 'error', message: 'Please pick a day' })
      return
    }

    try {
      const created = await createEvent.mutateAsync({
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
      void created
      logActivity({ verb: 'poll_closed', entity: { type: 'option', id: item.optionId ?? undefined, label: item.title } })
      logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: item.title } })
      showToast({ type: 'success', message: `"${item.title}" is on the plan` })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not schedule this', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Schedule "${item.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">Pick a day (and optionally a time) to put this on the plan.</p>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Input label="Time (optional)" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose} disabled={createEvent.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSchedule} isLoading={createEvent.isPending}>
            Put it on the plan
          </Button>
        </div>
      </div>
    </Modal>
  )
}
