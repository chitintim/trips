import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { Modal, Button, Input, TextArea, Select, useToast, ConfirmDiscardSheet, Chip } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateBooking, useUpdateBooking, type Booking } from '../../../lib/queries/useBookings'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useCreateExpense, type SplitRow } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useAuth } from '../../../hooks/useAuth'
import { largestRemainderDistribute, toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { PlacePicker, PlaceChip } from '../../places'
import { useTripActivityLog } from '../lib/activity'
import type { Trip } from '../../../types'
import type { Tables } from '../../../types/database.types'

interface BookingFormValues {
  title: string
  vendor: string
  confirmationRef: string
  amount: string
  currency: string
  bookingDate: string
  cancellationDeadline: string
  refundable: boolean
  status: string
  notes: string
  placeId: string | null
  placeName: string | null
  // Linked-creation choices (create mode only)
  createEvent: boolean
  createExpense: boolean
}

const EMPTY = (baseCurrency: string): BookingFormValues => ({
  title: '',
  vendor: '',
  confirmationRef: '',
  amount: '',
  currency: baseCurrency,
  bookingDate: '',
  cancellationDeadline: '',
  refundable: false,
  status: 'reserved',
  notes: '',
  placeId: null,
  placeName: null,
  createEvent: true,
  createExpense: true,
})

function fromBooking(booking: Booking | null, baseCurrency: string): BookingFormValues {
  if (!booking) return EMPTY(baseCurrency)
  return {
    title: booking.title,
    vendor: booking.vendor ?? '',
    confirmationRef: booking.confirmation_ref ?? '',
    amount: booking.amount != null ? String(booking.amount) : '',
    currency: booking.currency ?? baseCurrency,
    bookingDate: booking.booking_date ?? '',
    cancellationDeadline: booking.cancellation_deadline ? booking.cancellation_deadline.slice(0, 16) : '',
    refundable: booking.refundable ?? false,
    status: booking.status,
    notes: booking.notes ?? '',
    placeId: booking.place_id,
    placeName: null,
    createEvent: false,
    createExpense: false,
  }
}

export interface BookingEditorSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  booking: Booking | null
}

/**
 * Booking create/edit sheet (plan §9, Form & Flow Standard §5). The
 * "clever linking": creating a booking offers to auto-create the linked
 * timeline event and expense draft in the same submit — one action
 * populates three systems consistently, via the shared src/lib/queries
 * hooks (never reaching into the expenses feature's internals).
 */
export function BookingEditorSheet({ isOpen, onClose, trip, booking }: BookingEditorSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const tripId = trip.id
  const baseCurrency = trip.base_currency || 'GBP'

  const queryClient = useQueryClient()
  const createBooking = useCreateBooking(tripId)
  const updateBooking = useUpdateBooking(tripId)
  const createExpense = useCreateExpense(tripId)
  const { data: participants } = useParticipants(tripId)
  const logActivity = useTripActivityLog(tripId)

  const isEditing = !!booking
  const draftKey = isEditing ? `booking-editor:${booking!.id}` : `booking-editor:new:${tripId}`
  // Edit mode always seeds from the booking record -- draft persistence is
  // disabled so a stale autosave can never leak in (Form & Flow Standard
  // §5.2). Create mode keeps draft persistence.
  const { values, setValues, updateField, clearDraft } = useFormDraft<BookingFormValues>(
    draftKey,
    EMPTY(baseCurrency),
    { enabled: !isEditing }
  )
  const [placePickerOpen, setPlacePickerOpen] = useState(false)
  const [pickedPlace, setPickedPlace] = useState<Tables<'places'> | null>(null)

  useEffect(() => {
    if (isOpen) {
      setValues(fromBooking(booking, baseCurrency))
      setPickedPlace(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, booking?.id])

  const seed = fromBooking(booking, baseCurrency)
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const isSaving = createBooking.isPending || updateBooking.isPending || createExpense.isPending
  const amountNumber = values.amount ? parseFloat(values.amount) : null
  const canCreateExpense = amountNumber != null && !Number.isNaN(amountNumber) && amountNumber > 0
  const canCreateEvent = !!values.bookingDate

  const handleSave = async () => {
    if (!user) return
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a booking title' })
      return
    }
    if (values.amount && (amountNumber == null || Number.isNaN(amountNumber))) {
      showToast({ type: 'error', message: 'Amount must be a number' })
      return
    }

    const bookingFields = {
      title: values.title.trim(),
      vendor: values.vendor.trim() || null,
      confirmation_ref: values.confirmationRef.trim() || null,
      amount: canCreateExpense ? amountNumber : values.amount ? amountNumber : null,
      currency: values.currency || baseCurrency,
      booking_date: values.bookingDate || null,
      cancellation_deadline: values.cancellationDeadline ? new Date(values.cancellationDeadline).toISOString() : null,
      refundable: values.refundable,
      status: values.status,
      notes: values.notes.trim() || null,
      place_id: values.placeId,
    }

    try {
      if (isEditing) {
        await updateBooking.mutateAsync({ id: booking!.id, update: bookingFields })
        logActivity({ verb: 'booking_updated', entity: { type: 'booking', id: booking!.id, label: bookingFields.title } })
        showToast({ type: 'success', message: 'Booking updated' })
      } else {
        const created = await createBooking.mutateAsync({ ...bookingFields, booked_by: user.id })

        // ---- Linked creation: timeline event ---------------------------
        let timelineEventId: string | null = null
        if (values.createEvent && canCreateEvent) {
          const { data: eventRow, error: eventError } = await supabase
            .from('trip_timeline_events')
            .insert({
              trip_id: tripId,
              created_by: user.id,
              title: bookingFields.title,
              event_date: values.bookingDate,
              location: pickedPlace?.name ?? null,
              place_id: values.placeId,
              description: bookingFields.vendor ? `Booked with ${bookingFields.vendor}` : null,
            })
            .select()
            .single()
          if (eventError) throw eventError
          timelineEventId = eventRow.id
          queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
          logActivity({ verb: 'event_added', entity: { type: 'timeline_event', id: eventRow.id, label: bookingFields.title } })
        }

        // ---- Linked creation: expense draft ----------------------------
        let expenseId: string | null = null
        if (values.createExpense && canCreateExpense && amountNumber != null) {
          const activeIds = (participants ?? []).filter((p) => p.active !== false).map((p) => p.user_id)
          const splitUserIds = activeIds.length > 0 ? activeIds : [user.id]
          const currency = values.currency || baseCurrency
          const totalMinor = toMinorUnits(amountNumber, currency)
          const shares = largestRemainderDistribute(totalMinor, splitUserIds.map(() => 1))
          const splits: SplitRow[] = splitUserIds.map((userId, i) => ({
            user_id: userId,
            amount: fromMinorUnits(shares[i], currency),
            split_type: 'equal',
          }))
          const expense = await createExpense.mutateAsync({
            expense: {
              description: bookingFields.title,
              amount: amountNumber,
              currency,
              paid_by: user.id,
              payment_date: values.bookingDate || new Date().toISOString().slice(0, 10),
              category: 'other' as const,
              participant_ids: splitUserIds,
              place_id: values.placeId,
              vendor_name: bookingFields.vendor,
            },
            splits,
          })
          expenseId = expense.id
          logActivity({ verb: 'expense_added', entity: { type: 'expense', id: expense.id, label: bookingFields.title } })
        }

        // Back-link the booking to whatever got created alongside it.
        if (timelineEventId || expenseId) {
          await updateBooking.mutateAsync({
            id: created.id,
            update: {
              ...(timelineEventId ? { timeline_event_id: timelineEventId } : {}),
              ...(expenseId ? { expense_id: expenseId } : {}),
            },
          })
        }

        logActivity({ verb: 'booking_added', entity: { type: 'booking', id: created.id, label: bookingFields.title } })
        showToast({
          type: 'success',
          message: 'Booking tracked',
          description:
            timelineEventId && expenseId
              ? 'Timeline event and expense created too.'
              : timelineEventId
                ? 'Timeline event created too.'
                : expenseId
                  ? 'Expense created too.'
                  : undefined,
        })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save booking', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={isEditing ? 'Edit booking' : 'Track a booking'}>
      <div className="space-y-4">
        <Input
          label="What did you book?"
          value={values.title}
          onChange={(e) => updateField('title', e.target.value)}
          placeholder="e.g. Chalet Les Marmottes"
          required
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Vendor" value={values.vendor} onChange={(e) => updateField('vendor', e.target.value)} placeholder="Booking.com" />
          <Input
            label="Confirmation ref"
            value={values.confirmationRef}
            onChange={(e) => updateField('confirmationRef', e.target.value)}
            placeholder="ABC123"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Amount paid"
            type="number"
            min={0}
            step="0.01"
            value={values.amount}
            onChange={(e) => updateField('amount', e.target.value)}
          />
          <Input
            label="Currency"
            value={values.currency}
            onChange={(e) => updateField('currency', e.target.value.toUpperCase().slice(0, 3))}
            placeholder={baseCurrency}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Booking date"
            type="date"
            value={values.bookingDate}
            onChange={(e) => updateField('bookingDate', e.target.value)}
          />
          <Input
            label="Free cancellation until"
            type="datetime-local"
            value={values.cancellationDeadline}
            onChange={(e) => updateField('cancellationDeadline', e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <Select
            label="Status"
            value={values.status}
            onChange={(e) => updateField('status', e.target.value)}
            options={[
              { value: 'reserved', label: 'Reserved' },
              { value: 'paid', label: 'Paid' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <label className="flex items-center gap-2 pb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={values.refundable}
              onChange={(e) => updateField('refundable', e.target.checked)}
              className="w-5 h-5 accent-accent-600"
            />
            <span className="text-sm text-[var(--text-primary)]">Refundable</span>
          </label>
        </div>

        <div>
          <span className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Place</span>
          {pickedPlace ? (
            <div className="flex items-center gap-2">
              <PlaceChip place={pickedPlace} compact />
              <Button variant="ghost" size="sm" onClick={() => { setPickedPlace(null); updateField('placeId', null) }}>
                Remove
              </Button>
            </div>
          ) : values.placeId ? (
            <div className="flex items-center gap-2">
              <Chip icon={<span>📍</span>}>Linked place</Chip>
              <Button variant="ghost" size="sm" onClick={() => updateField('placeId', null)}>
                Remove
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setPlacePickerOpen(true)}>
              📍 Attach a place
            </Button>
          )}
        </div>

        <TextArea label="Notes" value={values.notes} onChange={(e) => updateField('notes', e.target.value)} rows={2} />

        {!isEditing && (
          <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Also create</p>
            <label className={`flex items-start gap-3 ${canCreateEvent ? 'cursor-pointer' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={values.createEvent && canCreateEvent}
                disabled={!canCreateEvent}
                onChange={(e) => updateField('createEvent', e.target.checked)}
                className="mt-0.5 w-5 h-5 accent-accent-600"
              />
              <span className="text-sm text-[var(--text-primary)]">
                Timeline event on the booking date
                {!canCreateEvent && <span className="block text-xs text-[var(--text-muted)]">Set a booking date to enable</span>}
              </span>
            </label>
            <label className={`flex items-start gap-3 ${canCreateExpense ? 'cursor-pointer' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={values.createExpense && canCreateExpense}
                disabled={!canCreateExpense}
                onChange={(e) => updateField('createExpense', e.target.checked)}
                className="mt-0.5 w-5 h-5 accent-accent-600"
              />
              <span className="text-sm text-[var(--text-primary)]">
                Expense, paid by you, split equally among everyone
                {!canCreateExpense && <span className="block text-xs text-[var(--text-muted)]">Enter an amount to enable</span>}
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={isSaving}>
            {isEditing ? 'Save booking' : 'Track booking'}
          </Button>
        </div>
      </div>

      <PlacePicker
        isOpen={placePickerOpen}
        onClose={() => setPlacePickerOpen(false)}
        tripId={tripId}
        title="Where is this booking?"
        onPicked={(place) => {
          setPickedPlace(place)
          updateField('placeId', place.id)
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
    </Modal>
  )
}
