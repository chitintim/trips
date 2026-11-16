import { useEffect, useState } from 'react'
import { Button, Modal, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { shortDate } from '../lib/decideSheetModel'
import { PlanWhenFields } from './PlanWhenFields'
import type { Trip } from '../../../types'

export interface PutOnPlanTarget {
  optionId: string
  title: string
  description?: string | null
  placeId?: string | null
  /** timeline_event_category value. */
  category?: string | null
  /** Prefill from the option, when it carries a date. */
  date?: string | null
  startTime?: string | null
}

export interface PutOnPlanSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  target: PutOnPlanTarget | null
}

/**
 * "Put it on the plan" for a question that is ALREADY decided: one day (and
 * optional time), one insert of a timeline event carrying `source_option_id`
 * (so the option and the event are one item). Deciding and scheduling in one
 * step is the Decide sheet; this never closes a question.
 */
export function PutOnPlanSheet({ isOpen, onClose, trip, target }: PutOnPlanSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const createEvent = useCreateTimelineEvent(trip.id)
  const logActivity = useTripActivityLog(trip.id)
  const [date, setDate] = useState(trip.start_date)
  const [startTime, setStartTime] = useState('')

  useEffect(() => {
    if (isOpen) {
      setDate(target?.date || trip.start_date)
      setStartTime(target?.startTime || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target?.optionId])

  if (!target) return null

  const handleSave = async () => {
    if (!user || !date) {
      showToast({ type: 'error', message: 'Please pick a day' })
      return
    }
    try {
      await createEvent.mutateAsync({
        trip_id: trip.id,
        created_by: user.id,
        title: target.title,
        description: target.description ?? null,
        category: (target.category as never) || 'other',
        event_date: date,
        all_day: !startTime,
        start_time: startTime || null,
        place_id: target.placeId ?? null,
        source_option_id: target.optionId,
      })
      logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: target.title } })
      showToast({ type: 'success', message: `"${target.title}" is on the plan for ${shortDate(date)}` })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not put this on the plan', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Put "${target.title}" on the plan`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">Pick a day, and a time if it has one.</p>
        <PlanWhenFields date={date} startTime={startTime} onDateChange={setDate} onStartTimeChange={setStartTime} />
        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={createEvent.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={createEvent.isPending} disabled={!date}>
            Put it on the plan
          </Button>
        </div>
      </div>
    </Modal>
  )
}
