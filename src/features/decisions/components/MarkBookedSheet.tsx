import { useEffect, useState } from 'react'
import { Button, Input, Modal, useToast } from '../../../components/ui'
import { useBookings, useMarkBooked, useUnmarkBooked } from '../../../lib/queries/useBookings'
import { formatMoney } from '../../../lib/money'
import { BookingEditorSheet } from '../../organizer/components/BookingEditorSheet'
import { buildMarkBookedBooking, parsePaidAmount, shouldOfferExpense } from '../lib/decideSheetModel'
import type { Trip } from '../../../types'

export interface MarkBookedSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** The decided option being booked / un-booked. */
  option: { id: string; title: string } | null
  /** `mark`: "Booked ✓". `unmark`: "Not booked after all". */
  mode: 'mark' | 'unmark'
}

/**
 * Mark booked (proposal 5.6): the one-tap "Booked ✓" with optional details tucked
 * behind "Add booking details" (reference, amount paid). One `mark_booked` call
 * sets the flag, records the booking, and ticks off the "Book: X" to-do. An amount
 * then offers to log it as an expense through the booking editor (the existing
 * flow), instead of creating expenses here.
 *
 * `unmark` is "Not booked after all": one `unmark_booked` call cancels the booking,
 * clears Booked and puts the to-do back ("Booking cancelled — needs rebooking").
 */
export function MarkBookedSheet({ isOpen, onClose, trip, option, mode }: MarkBookedSheetProps) {
  const { showToast } = useToast()
  const markBooked = useMarkBooked(trip.id)
  const unmarkBooked = useUnmarkBooked(trip.id)
  const { data: bookings } = useBookings(trip.id)
  const baseCurrency = trip.base_currency || 'GBP'

  const [showDetails, setShowDetails] = useState(false)
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(baseCurrency)
  const [reopen, setReopen] = useState(false)
  const [offerBookingId, setOfferBookingId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setShowDetails(false)
      setReference('')
      setAmount('')
      setCurrency(baseCurrency)
      setReopen(false)
      setOfferBookingId(null)
      setEditorOpen(false)
    }
  }, [isOpen, option?.id, baseCurrency])

  if (!option) return null

  const handleMark = async () => {
    const form = { optionTitle: option.title, reference, amount, currency }
    try {
      const result = await markBooked.mutateAsync({ optionId: option.id, booking: buildMarkBookedBooking(form) })
      showToast({ type: 'success', message: 'Marked booked' })
      if (shouldOfferExpense(form, result.booking_id)) setOfferBookingId(result.booking_id)
      else onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not mark this booked', description: (err as Error).message })
    }
  }

  const handleUnmark = async () => {
    try {
      await unmarkBooked.mutateAsync({ optionId: option.id, cancelBooking: true, reopenQuestion: reopen })
      showToast({
        type: 'success',
        message: reopen ? 'Question reopened' : 'Not booked after all',
        description: reopen ? 'It is open again and answers were kept.' : 'It needs rebooking, so the to-do is back on the list.',
      })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not undo the booking', description: (err as Error).message })
    }
  }

  // Step 2 of Mark booked with an amount: offer to log the expense.
  if (mode === 'mark' && offerBookingId) {
    const paid = parsePaidAmount(amount)
    const booking = (bookings ?? []).find((b) => b.id === offerBookingId) ?? null
    return (
      <>
        <Modal isOpen={isOpen && !editorOpen} onClose={onClose} size="sm" title="Booked ✓">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              {paid != null ? `Log ${formatMoney(paid, currency.trim().toUpperCase() || baseCurrency, { mode: 'exact' })} as an expense so it counts in who owes what?` : 'Log it as an expense?'}
            </p>
            <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
              <Button variant="ghost" onClick={onClose}>
                Not now
              </Button>
              <Button onClick={() => setEditorOpen(true)} disabled={!booking}>
                Log expense
              </Button>
            </div>
          </div>
        </Modal>
        <BookingEditorSheet
          isOpen={isOpen && editorOpen}
          onClose={onClose}
          trip={trip}
          booking={booking}
          initialLogExpense
        />
      </>
    )
  }

  if (mode === 'unmark') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Not booked after all: "${option.title}"`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            This cancels the booking record and takes away Booked. The to-do to book it comes back so someone can rebook. Anything already on the plan or in expenses stays until you remove it.
          </p>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={reopen} onChange={(e) => setReopen(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-accent-600" />
            <span className="text-sm text-[var(--text-primary)]">
              Also reopen the question
              <span className="block text-xs text-[var(--text-muted)]">Use this if the group should choose again. Answers are kept.</span>
            </span>
          </label>
          <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" onClick={onClose} disabled={unmarkBooked.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleUnmark} isLoading={unmarkBooked.isPending}>
              Not booked after all
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title={`Mark booked: "${option.title}"`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">Tell the group it is booked. The “Book: …” to-do is ticked off.</p>
        {showDetails ? (
          <div className="space-y-3">
            <Input label="Booking reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} fullWidth />
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
              <Input label="Cost paid (optional)" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} fullWidth />
              <Input label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} fullWidth />
            </div>
            <p className="text-xs text-[var(--text-muted)]">Entering a cost lets you log it as an expense next.</p>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setShowDetails(true)}>
            Add booking details
          </Button>
        )}
        <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="ghost" onClick={onClose} disabled={markBooked.isPending}>
            Cancel
          </Button>
          <Button onClick={handleMark} isLoading={markBooked.isPending}>
            Booked ✓
          </Button>
        </div>
      </div>
    </Modal>
  )
}
