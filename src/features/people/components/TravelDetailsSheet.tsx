import { useEffect, useState } from 'react'
import { Modal, Button, Input, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCurrentUserRow } from '../../../lib/queries/useTrip'
import { useTimeline, useCreateTimelineEvent, useUpdateTimelineEvent } from '../../../lib/queries/useTimeline'
import { getMyTravelEvents, buildTravelMetadata, travelEventFlightRef } from '../lib/travelDetails'
import type { TravelDirection } from '../lib/travelDetails'
import type { TimelineEvent } from '../../../types'

export interface TravelDetailsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
}

interface LegState {
  date: string
  time: string
  flightRef: string
}

const emptyLeg: LegState = { date: '', time: '', flightRef: '' }

function legFromEvent(event: TimelineEvent | null): LegState {
  if (!event) return emptyLeg
  return {
    date: event.event_date ?? '',
    time: event.start_time ? event.start_time.slice(0, 5) : '',
    flightRef: travelEventFlightRef(event) ?? '',
  }
}

/**
 * Self-service travel details (UX_REDESIGN.md Part 2 "People additions"):
 * when do YOU arrive and leave? Writes/updates the user's own
 * trip_timeline_events (category flight/transfer, participant_ids=[self],
 * metadata.travel_details=true) so arrivals show up on the Plan board and
 * feed nights-weighting. Editing updates the existing events in place.
 */
export function TravelDetailsSheet({ isOpen, onClose, tripId }: TravelDetailsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: userRow } = useCurrentUserRow(user?.id)
  const { data: events = [] } = useTimeline(tripId)
  const createEvent = useCreateTimelineEvent(tripId)
  const updateEvent = useUpdateTimelineEvent(tripId)

  const [arrival, setArrival] = useState<LegState>(emptyLeg)
  const [departure, setDeparture] = useState<LegState>(emptyLeg)
  const [saving, setSaving] = useState(false)

  const existing = getMyTravelEvents(events, user?.id)

  // Seed from existing events each time the sheet opens.
  useEffect(() => {
    if (!isOpen) return
    setArrival(legFromEvent(existing.arrival))
    setDeparture(legFromEvent(existing.departure))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const firstName = userRow?.first_name || userRow?.full_name?.split(' ')[0] || 'You'

  const saveLeg = async (direction: TravelDirection, leg: LegState, existingEvent: TimelineEvent | null) => {
    if (!leg.date || !user) return
    const title = direction === 'arrival' ? `${firstName} arrives` : `${firstName} departs`
    const common = {
      title,
      event_date: leg.date,
      start_time: leg.time ? `${leg.time}:00` : null,
      category: (leg.flightRef.trim() ? 'flight' : 'transfer') as 'flight' | 'transfer',
      participant_ids: [user.id],
      metadata: buildTravelMetadata(direction, leg.flightRef),
    }
    if (existingEvent) {
      await updateEvent.mutateAsync({ id: existingEvent.id, update: common })
    } else {
      await createEvent.mutateAsync({ ...common, trip_id: tripId, created_by: user.id })
    }
  }

  const handleSave = async () => {
    if (!arrival.date && !departure.date) {
      showToast({ type: 'error', message: 'Add at least one date', description: 'Tell the group when you arrive or leave.' })
      return
    }
    setSaving(true)
    try {
      await saveLeg('arrival', arrival, existing.arrival)
      await saveLeg('departure', departure, existing.departure)
      showToast({ type: 'success', message: 'Travel details saved' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save travel details', description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" title="Your travel details">
      <div className="space-y-6">
        <p className="text-sm text-[var(--text-secondary)]">
          When do you arrive and leave? This puts you on the plan (labelled local time) and helps split accommodation
          fairly by nights.
        </p>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-[var(--text-primary)]">Arrival</legend>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" value={arrival.date} onChange={(e) => setArrival({ ...arrival, date: e.target.value })} />
            <Input label="Time (local)" type="time" value={arrival.time} onChange={(e) => setArrival({ ...arrival, time: e.target.value })} />
          </div>
          <Input
            label="Flight or train ref (optional)"
            value={arrival.flightRef}
            onChange={(e) => setArrival({ ...arrival, flightRef: e.target.value })}
            placeholder="BA 2704"
          />
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-[var(--text-primary)]">Departure</legend>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" value={departure.date} onChange={(e) => setDeparture({ ...departure, date: e.target.value })} />
            <Input label="Time (local)" type="time" value={departure.time} onChange={(e) => setDeparture({ ...departure, time: e.target.value })} />
          </div>
          <Input
            label="Flight or train ref (optional)"
            value={departure.flightRef}
            onChange={(e) => setDeparture({ ...departure, flightRef: e.target.value })}
            placeholder="BA 2705"
          />
        </fieldset>

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={saving}>
            Save details
          </Button>
        </div>
      </div>
    </Modal>
  )
}
