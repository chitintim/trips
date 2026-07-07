import { useEffect, useState } from 'react'
import { Modal, Button, Input, TextArea, Select, Chip, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateTimelineEvent, useUpdateTimelineEvent, useDeleteTimelineEvent } from '../../../lib/queries/useTimeline'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { PlacePicker, PlaceChip } from '../../places'
import { CATEGORY_OPTIONS } from '../lib/categoryConfig'
import type { Trip, TimelineEvent, TimelineEventCategory } from '../../../types'
import type { Tables } from '../../../types/database.types'

interface EventFormValues {
  title: string
  category: TimelineEventCategory
  eventDate: string
  allDay: boolean
  startTime: string
  endTime: string
  location: string
  placeId: string | null
  description: string
  /** null = everyone (the default). Non-null = explicit subset. */
  participantIds: string[] | null
}

/** Optional prefill for a brand-new event — the companion-suggestions "accept" flow (UX_REDESIGN.md Part 3 "Ambient AI" #3) uses this to seed title/category/time from the suggestion instead of an entirely blank form. */
export interface EventEditorDefaults {
  title?: string
  category?: TimelineEventCategory
  startTime?: string | null
}

function emptyValues(defaultDate: string, defaults?: EventEditorDefaults): EventFormValues {
  return {
    title: defaults?.title ?? '',
    category: defaults?.category ?? 'other',
    eventDate: defaultDate,
    allDay: false,
    startTime: defaults?.startTime ?? '',
    endTime: '',
    location: '',
    placeId: null,
    description: '',
    participantIds: null,
  }
}

function fromEvent(event: TimelineEvent | null, defaultDate: string, defaults?: EventEditorDefaults): EventFormValues {
  if (!event) return emptyValues(defaultDate, defaults)
  return {
    title: event.title,
    category: event.category as TimelineEventCategory,
    eventDate: event.event_date,
    allDay: event.all_day ?? false,
    startTime: event.start_time ?? '',
    endTime: event.end_time ?? '',
    location: event.location ?? '',
    placeId: event.place_id,
    description: event.description ?? '',
    participantIds: event.participant_ids ?? null,
  }
}

export interface EventEditorSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Null = creating a new event. Non-null = editing this event. */
  event: TimelineEvent | null
  /** When creating, pre-fill the date (e.g. the day header's "+" tap). */
  defaultDate?: string
  /** When creating, pre-fill title/category/time (the companion-suggestions "accept" flow). Ignored when editing. */
  defaults?: EventEditorDefaults
}

/**
 * Create/edit/delete sheet for a timeline event (organizer-only mutation
 * surface). Form & Flow Standard compliant: draft persistence for create
 * (disabled for edit, which always seeds from the record), dirty-close
 * guard, fresh state on every open.
 */
export function EventEditorSheet({ isOpen, onClose, trip, event, defaultDate, defaults }: EventEditorSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const tripId = trip.id
  const isEditing = !!event

  const createEvent = useCreateTimelineEvent(tripId)
  const updateEvent = useUpdateTimelineEvent(tripId)
  const deleteEvent = useDeleteTimelineEvent(tripId)
  const { data: participants } = useParticipants(tripId)
  const logActivity = useTripActivityLog(tripId)

  // Prefilled creates (companion suggestions) get their own draft key per
  // suggestion title so accepting suggestion A never leaks a draft into
  // suggestion B's form.
  const draftKey = isEditing
    ? `timeline-event-editor:${event!.id}`
    : `timeline-event-editor:new:${tripId}${defaults?.title ? `:${defaults.title}` : ''}`
  const seed = fromEvent(event, defaultDate || trip.start_date, defaults)
  const { values, setValues, updateField, clearDraft } = useFormDraft<EventFormValues>(draftKey, seed, {
    // Edit forms must always seed from the record, never restore a stale
    // autosaved draft (Form & Flow Standard §5.2).
    enabled: !isEditing,
  })

  const [placePickerOpen, setPlacePickerOpen] = useState(false)
  const [pickedPlace, setPickedPlace] = useState<Tables<'places'> | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Fresh-state guarantee: reset to a clean seed every time the sheet opens.
  useEffect(() => {
    if (isOpen) {
      setValues(fromEvent(event, defaultDate || trip.start_date, defaults))
      setPickedPlace(null)
      setConfirmingDelete(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, event?.id, defaults?.title])

  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const isSaving = createEvent.isPending || updateEvent.isPending
  const activeParticipants = (participants ?? []).filter((p) => p.active !== false)
  const allSelected = values.participantIds === null

  const toggleParticipant = (userId: string) => {
    setValues((prev) => {
      const current = prev.participantIds ?? activeParticipants.map((p) => p.user_id)
      const next = current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
      // If every active participant ends up selected, collapse back to "everyone" (null).
      const isEveryone = activeParticipants.every((p) => next.includes(p.user_id))
      return { ...prev, participantIds: isEveryone ? null : next }
    })
  }

  const handleSave = async () => {
    if (!user) return
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }
    if (!values.eventDate) {
      showToast({ type: 'error', message: 'Please pick a date' })
      return
    }

    const fields = {
      title: values.title.trim(),
      category: values.category,
      event_date: values.eventDate,
      all_day: values.allDay,
      start_time: values.allDay ? null : values.startTime || null,
      end_time: values.allDay ? null : values.endTime || null,
      location: values.location.trim() || null,
      place_id: values.placeId,
      description: values.description.trim() || null,
      participant_ids: values.participantIds,
    }

    try {
      if (isEditing) {
        await updateEvent.mutateAsync({ id: event!.id, update: fields })
        logActivity({ verb: 'event_updated', entity: { type: 'timeline_event', id: event!.id, label: fields.title } })
        showToast({ type: 'success', message: 'Event updated' })
      } else {
        await createEvent.mutateAsync({ ...fields, trip_id: tripId, created_by: user.id })
        logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: fields.title } })
        showToast({ type: 'success', message: 'Event added' })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save event', description: (err as Error).message })
    }
  }

  const handleDelete = async () => {
    if (!event) return
    try {
      await deleteEvent.mutateAsync(event.id)
      showToast({ type: 'success', message: 'Event deleted' })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete event', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={isEditing ? 'Edit event' : 'Add event'}>
      <div className="space-y-4">
        <Input
          label="Title"
          value={values.title}
          onChange={(e) => updateField('title', e.target.value)}
          placeholder="e.g. Lunch at Mountain Hut"
          required
          autoFocus
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            value={values.eventDate}
            onChange={(e) => updateField('eventDate', e.target.value)}
          />
          <Select
            label="Category"
            value={values.category}
            onChange={(e) => updateField('category', e.target.value as TimelineEventCategory)}
            options={CATEGORY_OPTIONS}
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={values.allDay}
            onChange={(e) => updateField('allDay', e.target.checked)}
            className="h-5 w-5 accent-accent-600"
          />
          <span className="text-sm text-[var(--text-primary)]">All day event</span>
        </label>

        {!values.allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start time" type="time" value={values.startTime} onChange={(e) => updateField('startTime', e.target.value)} />
            <Input label="End time" type="time" value={values.endTime} onChange={(e) => updateField('endTime', e.target.value)} />
          </div>
        )}

        <Input
          label="Location"
          value={values.location}
          onChange={(e) => updateField('location', e.target.value)}
          placeholder="e.g. Chalet Restaurant, Verbier"
        />

        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Place</span>
          {pickedPlace || values.placeId ? (
            <div className="flex items-center gap-2">
              {pickedPlace ? (
                <PlaceChip place={pickedPlace} compact />
              ) : (
                <Chip icon={<span>📍</span>}>Linked place</Chip>
              )}
              <Button variant="ghost" size="sm" onClick={() => { setPickedPlace(null); updateField('placeId', null) }}>
                Remove
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setPlacePickerOpen(true)}>
              📍 Attach a place
            </Button>
          )}
        </div>

        <TextArea
          label="Description"
          value={values.description}
          onChange={(e) => updateField('description', e.target.value)}
          placeholder="Additional details, booking references..."
          rows={3}
        />

        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Who's this for?</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip selected={allSelected} onClick={() => setValues((prev) => ({ ...prev, participantIds: null }))}>
              Everyone
            </Chip>
            {activeParticipants.map((p) => {
              const selected = allSelected || (values.participantIds?.includes(p.user_id) ?? false)
              return (
                <Chip key={p.user_id} selected={selected} onClick={() => toggleParticipant(p.user_id)}>
                  {p.user?.full_name || p.user?.email || 'Participant'}
                </Chip>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
          {isEditing ? (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={isSaving || deleteEvent.isPending}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={handleClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={isSaving}>
              {isEditing ? 'Save event' : 'Add event'}
            </Button>
          </div>
        </div>
      </div>

      <PlacePicker
        isOpen={placePickerOpen}
        onClose={() => setPlacePickerOpen(false)}
        tripId={tripId}
        title="Where is this event?"
        onPicked={(place) => {
          setPickedPlace(place)
          updateField('placeId', place.id)
          updateField('location', place.name)
          setPlacePickerOpen(false)
        }}
      />

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />

      {confirmingDelete && (
        <Modal isOpen onClose={() => setConfirmingDelete(false)} size="sm" title="Delete this event?">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              "{event?.title}" will be removed from the timeline. This can't be undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} isLoading={deleteEvent.isPending}>
                Delete event
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  )
}
