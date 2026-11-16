import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { Modal, Button, Input, TextArea, Select, useToast, ConfirmDiscardSheet, Chip } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateBooking, useUpdateBooking, useCancelBookingFollowUps, useUnmarkBooked, useBookings, type Booking } from '../../../lib/queries/useBookings'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useCreateExpense, type SplitRow } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useSections } from '../../../lib/queries/usePlanning'
import { inScopePeople } from '../../people/lib/inScopePeople'
import { useAuth } from '../../../hooks/useAuth'
import { largestRemainderDistribute, toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { PlacePicker, PlaceChip } from '../../places'
import { ReopenDecisionDialog } from '../../decisions/components/ReopenDecisionDialog'
import { readDecidedOptionId } from '../../decisions/lib/closeDecision'
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
  optionId: string
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
  optionId: '',
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
    optionId: booking.option_id ?? '',
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
  /** New bookings only: pre-select this option in "Linked option" (e.g. "Mark booked" on a decided question). */
  initialOptionId?: string | null
  /** Editing a booking that has an amount but no expense: start with "Log as an expense" ticked (Mark booked's follow-up). */
  initialLogExpense?: boolean
}

/**
 * Booking create/edit sheet (plan §9, Form & Flow Standard §5). The
 * "clever linking": creating a booking offers to auto-create the linked
 * timeline event and expense draft in the same submit — one action
 * populates three systems consistently, via the shared src/lib/queries
 * hooks (never reaching into the expenses feature's internals).
 */
export function BookingEditorSheet({ isOpen, onClose, trip, booking, initialOptionId = null, initialLogExpense = false }: BookingEditorSheetProps) {
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
  const cancelFollowUps = useCancelBookingFollowUps(tripId)
  const unmarkBooked = useUnmarkBooked(tripId)
  const { data: allBookings } = useBookings(tripId)
  const { data: sections } = useSections(tripId)
  // Options the booking can be linked to (so the plan card turns "Booked"
  // for the decided option). Closed decisions first.
  const optionChoices = (sections ?? [])
    .slice()
    .sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed'))
    .flatMap((s) =>
      s.options
        .filter((o) => o.status !== 'cancelled')
        .map((o) => ({ value: o.id, label: `${s.title} — ${o.title}${s.status === 'completed' ? ' (decided)' : ''}` }))
    )
  // Cancel-booking confirm step: shown on save when the status is being
  // switched to cancelled and the booking has a linked expense/event.
  const [cancelStep, setCancelStep] = useState(false)
  const [removeExpense, setRemoveExpense] = useState(false)
  const [removeEvent, setRemoveEvent] = useState(false)
  const [logExpense, setLogExpense] = useState(false)
  // After cancelling the booking of a decided option: offer to reopen the question.
  const [reopenOffer, setReopenOffer] = useState<{ sectionId: string; optionTitle: string } | null>(null)
  const [reopenOpen, setReopenOpen] = useState(false)

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
      const seeded = fromBooking(booking, baseCurrency)
      setValues(!booking && initialOptionId ? { ...seeded, optionId: initialOptionId } : seeded)
      setPickedPlace(null)
      setLogExpense(initialLogExpense)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, booking?.id, initialOptionId])

  const seed = fromBooking(booking, baseCurrency)
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  const isSaving = createBooking.isPending || updateBooking.isPending || createExpense.isPending || cancelFollowUps.isPending || unmarkBooked.isPending
  const amountNumber = values.amount ? parseFloat(values.amount) : null
  const canCreateExpense = amountNumber != null && !Number.isNaN(amountNumber) && amountNumber > 0
  const canCreateEvent = !!values.bookingDate
  const canLogExpenseOnEdit = isEditing && !booking!.expense_id && canCreateExpense && values.status !== 'cancelled'
  const cancelling = isEditing && values.status === 'cancelled' && booking!.status !== 'cancelled'

  /** Creates the expense for a booking: paid by you, split equally among everyone who is in. Returns its id. */
  const createLinkedExpense = async (e: { description: string; amount: number; currency: string; date: string; placeId: string | null; vendor: string | null }): Promise<string> => {
    // Same in-scope rule as new-expense defaults, cost per person and vote counts.
    const activeIds = inScopePeople(participants ?? [], trip.confirmation_enabled === true).map((p) => p.user_id)
    const splitUserIds = activeIds.length > 0 ? activeIds : [user!.id]
    const totalMinor = toMinorUnits(e.amount, e.currency)
    const shares = largestRemainderDistribute(totalMinor, splitUserIds.map(() => 1))
    const splits: SplitRow[] = splitUserIds.map((userId, i) => ({
      user_id: userId,
      amount: fromMinorUnits(shares[i], e.currency),
      split_type: 'equal',
    }))
    const expense = await createExpense.mutateAsync({
      expense: {
        description: e.description,
        amount: e.amount,
        currency: e.currency,
        paid_by: user!.id,
        payment_date: e.date || new Date().toISOString().slice(0, 10),
        category: 'other' as const,
        participant_ids: splitUserIds,
        place_id: e.placeId,
        vendor_name: e.vendor,
      },
      splits,
    })
    logActivity({ verb: 'expense_added', entity: { type: 'expense', id: expense.id, label: e.description } })
    return expense.id
  }

  const handleSave = async (followUps?: { removeExpense: boolean; removeEvent: boolean }) => {
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
      option_id: values.optionId || null,
    }

    // Cancelling a booking with linked records: ask first, never silently.
    if (
      isEditing &&
      !followUps &&
      values.status === 'cancelled' &&
      booking!.status !== 'cancelled' &&
      (booking!.expense_id || booking!.timeline_event_id)
    ) {
      setRemoveExpense(false)
      setRemoveEvent(false)
      setCancelStep(true)
      return
    }

    try {
      if (isEditing) {
        await updateBooking.mutateAsync({ id: booking!.id, update: bookingFields })
        if (followUps && (followUps.removeExpense || followUps.removeEvent)) {
          await cancelFollowUps.mutateAsync({
            bookingId: booking!.id,
            removeExpenseId: followUps.removeExpense ? booking!.expense_id : null,
            removeEventId: followUps.removeEvent ? booking!.timeline_event_id : null,
          })
        }
        if (logExpense && canLogExpenseOnEdit && amountNumber != null) {
          const expenseId = await createLinkedExpense({
            description: bookingFields.title,
            amount: amountNumber,
            currency: values.currency || baseCurrency,
            date: values.bookingDate,
            placeId: values.placeId,
            vendor: bookingFields.vendor,
          })
          await updateBooking.mutateAsync({ id: booking!.id, update: { expense_id: expenseId } })
        }
        logActivity({ verb: 'booking_updated', entity: { type: 'booking', id: booking!.id, label: bookingFields.title } })
        showToast({ type: 'success', message: logExpense && canLogExpenseOnEdit ? 'Booking updated and expense logged' : 'Booking updated' })

        // Cancelled the booking of a booked option: clear Booked and bring the "Book: ..." to-do
        // back ("Booking cancelled - needs rebooking"), then offer to reopen the question.
        if (cancelling && booking!.option_id) {
          const optionId = booking!.option_id
          const otherLive = (allBookings ?? []).some((b) => b.option_id === optionId && b.id !== booking!.id && b.status !== 'cancelled')
          if (!otherLive) {
            try {
              await unmarkBooked.mutateAsync({ optionId, cancelBooking: false, reopenQuestion: false })
            } catch (err) {
              showToast({ type: 'error', message: 'The booking is cancelled, but Booked could not be cleared', description: (err as Error).message })
            }
            const owner = (sections ?? []).find((sec) => sec.options.some((o) => o.id === optionId))
            if (owner && owner.status === 'completed' && readDecidedOptionId(owner.metadata) === optionId) {
              setReopenOffer({ sectionId: owner.id, optionTitle: owner.options.find((o) => o.id === optionId)?.title ?? bookingFields.title })
              setReopenOpen(true)
            }
          }
        }
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
          expenseId = await createLinkedExpense({
            description: bookingFields.title,
            amount: amountNumber,
            currency: values.currency || baseCurrency,
            date: values.bookingDate,
            placeId: values.placeId,
            vendor: bookingFields.vendor,
          })
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
              ? 'Added to the plan and expense created too.'
              : timelineEventId
                ? 'Added to the plan too.'
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
    <>
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
        {/* [&>*]:min-w-0 — date/datetime inputs have a large intrinsic
            min-content width and grid items default to min-width:auto, so
            this row overflows at 375px without it (same fix as
            TravelDetailsSheet). */}
        <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
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

        {optionChoices.length > 0 && (
          <Select
            label="Booking for which option?"
            value={values.optionId}
            onChange={(e) => updateField('optionId', e.target.value)}
            placeholder="Not linked to a question"
            fullWidth
            options={optionChoices}
          />
        )}

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

        {canLogExpenseOnEdit && (
          <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
            <input type="checkbox" checked={logExpense} onChange={(e) => setLogExpense(e.target.checked)} className="mt-0.5 h-5 w-5 accent-accent-600" />
            <span className="text-sm text-[var(--text-primary)]">
              Log this as an expense
              <span className="block text-xs text-[var(--text-muted)]">Paid by you, split equally among everyone who's in (editable later).</span>
            </span>
          </label>
        )}

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
                Add to the plan on the booking date
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
                Expense, paid by you, split equally among everyone who's in (editable later)
                {!canCreateExpense && <span className="block text-xs text-[var(--text-muted)]">Enter an amount to enable</span>}
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => handleSave()} isLoading={isSaving}>
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

      <Modal isOpen={cancelStep} onClose={() => setCancelStep(false)} size="sm" title="Booking cancelled">
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">
            This booking has linked records. Nothing is removed unless you tick it.
          </p>
          {booking?.expense_id && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={removeExpense} onChange={(e) => setRemoveExpense(e.target.checked)} className="mt-0.5 w-5 h-5 accent-accent-600" />
              <span className="text-sm text-[var(--text-primary)]">
                Remove the linked expense
                <span className="block text-xs text-[var(--text-muted)]">It will leave everyone's balances. Only the payer or an organizer can do this.</span>
              </span>
            </label>
          )}
          {booking?.timeline_event_id && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={removeEvent} onChange={(e) => setRemoveEvent(e.target.checked)} className="mt-0.5 w-5 h-5 accent-accent-600" />
              <span className="text-sm text-[var(--text-primary)]">
                Remove the linked entry from the plan
                <span className="block text-xs text-[var(--text-muted)]">It will disappear from the plan.</span>
              </span>
            </label>
          )}
          <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" onClick={() => setCancelStep(false)} disabled={isSaving}>
              Back
            </Button>
            <Button
              isLoading={isSaving}
              onClick={async () => {
                await handleSave({ removeExpense, removeEvent })
                setCancelStep(false)
              }}
            >
              Mark cancelled
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>

    <ReopenDecisionDialog
      isOpen={reopenOpen}
      onClose={() => setReopenOpen(false)}
      tripId={tripId}
      section={reopenOffer ? (sections ?? []).find((sec) => sec.id === reopenOffer.sectionId) ?? null : null}
      decidedTitle={reopenOffer?.optionTitle ?? null}
      heading="Reopen the question?"
      intro="The booking was cancelled. If the group should choose again, reopen the question."
      confirmLabel="Reopen the question"
      cancelLabel="Keep it decided"
    />
    </>
  )
}
