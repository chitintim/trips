import { useEffect, useState } from 'react'
import { Modal, Button, Input, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCurrentUserRow } from '../../../lib/queries/useTrip'
import { useTimeline, useCreateTimelineEvent, useUpdateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { getMyTravelEvents, buildTravelMetadata, travelEventFlightRef, travelEventAirportCode } from '../lib/travelDetails'
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
  airportCode: string
}

interface TravelFormValues {
  arrival: LegState
  departure: LegState
}

const emptyLeg: LegState = { date: '', time: '', flightRef: '', airportCode: '' }
const EMPTY_VALUES: TravelFormValues = { arrival: emptyLeg, departure: emptyLeg }

function legFromEvent(event: TimelineEvent | null): LegState {
  if (!event) return emptyLeg
  return {
    date: event.event_date ?? '',
    time: event.start_time ? event.start_time.slice(0, 5) : '',
    flightRef: travelEventFlightRef(event) ?? '',
    airportCode: travelEventAirportCode(event) ?? '',
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

  const [saving, setSaving] = useState(false)

  const existing = getMyTravelEvents(events, user?.id)

  const draftKey = `travel-details:${tripId}:${user?.id ?? 'anon'}`
  // Draft persistence (Form & Flow Standard §5.1): this form is easy to
  // half-fill and then lose -- e.g. backgrounding the app to copy a flight
  // ref out of a confirmation email. Unlike ConfirmationSettingsSheet (an
  // edit-only sheet that deliberately disables draft persistence so a
  // stale autosave can never override the live trip record), a restored
  // draft here only wins over the live record once per mount (see the seed
  // effect below), so a normal reopen after saving still reflects reality.
  const { values, setValues, updateField, clearDraft, isRestored } = useFormDraft<TravelFormValues>(draftKey, EMPTY_VALUES)

  // Seed from existing events each time the sheet opens -- unless a
  // still-fresh draft was restored at mount, in which case the in-progress
  // draft wins (it's not "a previous submission's values", it's this one,
  // just interrupted).
  useEffect(() => {
    if (!isOpen || isRestored) return
    setValues({ arrival: legFromEvent(existing.arrival), departure: legFromEvent(existing.departure) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const seedForDirtyCheck: TravelFormValues = {
    arrival: legFromEvent(existing.arrival),
    departure: legFromEvent(existing.departure),
  }
  const isDirty = JSON.stringify(values) !== JSON.stringify(seedForDirtyCheck)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

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
      metadata: buildTravelMetadata(direction, leg.flightRef, leg.airportCode),
    }
    if (existingEvent) {
      await updateEvent.mutateAsync({ id: existingEvent.id, update: common })
    } else {
      await createEvent.mutateAsync({ ...common, trip_id: tripId, created_by: user.id })
    }
  }

  const handleSave = async () => {
    if (!values.arrival.date && !values.departure.date) {
      showToast({ type: 'error', message: 'Add at least one date', description: 'Tell the group when you arrive or leave.' })
      return
    }
    setSaving(true)
    try {
      await saveLeg('arrival', values.arrival, existing.arrival)
      await saveLeg('departure', values.departure, existing.departure)
      showToast({ type: 'success', message: 'Travel details saved' })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save travel details', description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Your travel details">
      <div className="space-y-6">
        <p className="text-sm text-[var(--text-secondary)]">
          When do you arrive and leave? This puts you on the plan (labelled local time) and helps split accommodation
          fairly by nights.
        </p>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-[var(--text-primary)]">Arrival flight details</legend>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Date"
              type="date"
              value={values.arrival.date}
              onChange={(e) => updateField('arrival', { ...values.arrival, date: e.target.value })}
            />
            <Input
              label="Time (local)"
              type="time"
              value={values.arrival.time}
              onChange={(e) => updateField('arrival', { ...values.arrival, time: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Flight or train ref (optional)"
              value={values.arrival.flightRef}
              onChange={(e) => updateField('arrival', { ...values.arrival, flightRef: e.target.value })}
              placeholder="BA 2704"
            />
            <Input
              label="Arrival airport code (optional)"
              value={values.arrival.airportCode}
              onChange={(e) => updateField('arrival', { ...values.arrival, airportCode: e.target.value.toUpperCase().slice(0, 3) })}
              placeholder="LHR"
              maxLength={3}
              helperText="3-letter code, if you know it"
            />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-[var(--text-primary)]">Departure flight details</legend>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Date"
              type="date"
              value={values.departure.date}
              onChange={(e) => updateField('departure', { ...values.departure, date: e.target.value })}
            />
            <Input
              label="Time (local)"
              type="time"
              value={values.departure.time}
              onChange={(e) => updateField('departure', { ...values.departure, time: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Flight or train ref (optional)"
              value={values.departure.flightRef}
              onChange={(e) => updateField('departure', { ...values.departure, flightRef: e.target.value })}
              placeholder="BA 2705"
            />
            <Input
              label="Departure airport code (optional)"
              value={values.departure.airportCode}
              onChange={(e) => updateField('departure', { ...values.departure, airportCode: e.target.value.toUpperCase().slice(0, 3) })}
              placeholder="JFK"
              maxLength={3}
              helperText="3-letter code, if you know it"
            />
          </div>
        </fieldset>

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={saving}>
            Save details
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
