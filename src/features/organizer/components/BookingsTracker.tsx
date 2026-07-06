import { useMemo, useState } from 'react'
import { Badge, Button, Card, Deadline, EmptyState, Skeleton } from '../../../components/ui'
import { useBookings, type Booking } from '../../../lib/queries/useBookings'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { PlaceChip } from '../../places'
import { BookingEditorSheet } from './BookingEditorSheet'
import type { Trip } from '../../../types'

const STATUS_BADGE: Record<string, { label: string; variant: 'success' | 'info' | 'error' | 'neutral' }> = {
  reserved: { label: 'Reserved', variant: 'info' },
  paid: { label: 'Paid', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'error' },
}

export interface BookingsTrackerProps {
  trip: Trip
}

/**
 * Bookings tracker (plan §9): everything the group has booked — vendor,
 * confirmation ref, amount, cancellation-deadline radar, linked place —
 * plus the create/edit sheet with its auto-create linking flow.
 */
export function BookingsTracker({ trip }: BookingsTrackerProps) {
  const { data: bookings, isLoading } = useBookings(trip.id)
  const { data: places } = usePlaces(trip.id)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Booking | null>(null)
  const [editorKey, setEditorKey] = useState(0)

  const placesById = useMemo(() => new Map((places ?? []).map((p) => [p.id, p])), [places])

  const openCreate = () => {
    setEditing(null)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }
  const openEdit = (booking: Booking) => {
    setEditing(booking)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="card" height={80} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-secondary)]">
          {bookings?.length
            ? `${bookings.length} booking${bookings.length === 1 ? '' : 's'} tracked`
            : 'Nothing tracked yet'}
        </p>
        <Button size="sm" onClick={openCreate}>
          + Track booking
        </Button>
      </div>

      {!bookings || bookings.length === 0 ? (
        <EmptyState
          icon="🧾"
          title="No bookings tracked"
          description="Track what's booked — confirmation refs, amounts and free-cancellation deadlines — and let one entry create the timeline event and expense too."
          action={<Button onClick={openCreate}>Track your first booking</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {bookings.map((booking) => {
            const status = STATUS_BADGE[booking.status] ?? { label: booking.status, variant: 'neutral' as const }
            const place = booking.place_id ? placesById.get(booking.place_id) : undefined
            return (
              <li key={booking.id}>
                <Card hoverable clickable onClick={() => openEdit(booking)}>
                  <Card.Content>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[var(--text-primary)]">{booking.title}</span>
                          <Badge variant={status.variant} size="sm">
                            {status.label}
                          </Badge>
                          {booking.refundable && (
                            <Badge variant="success" size="sm">
                              Refundable
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          {[
                            booking.vendor,
                            booking.confirmation_ref ? `#${booking.confirmation_ref}` : null,
                            booking.amount != null ? `${booking.currency ?? ''} ${booking.amount}`.trim() : null,
                            booking.booking_date,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'No details yet'}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {place && <PlaceChip place={place} compact />}
                          {booking.cancellation_deadline && booking.status !== 'cancelled' && (
                            <Deadline date={booking.cancellation_deadline} kind="cancellation" compact />
                          )}
                          {booking.expense_id && (
                            <Badge variant="neutral" size="sm">
                              💰 expense linked
                            </Badge>
                          )}
                          {booking.timeline_event_id && (
                            <Badge variant="neutral" size="sm">
                              📅 on timeline
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(booking)
                        }}
                      >
                        Edit
                      </Button>
                    </div>
                  </Card.Content>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      <BookingEditorSheet
        key={editorKey}
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        trip={trip}
        booking={editing}
      />
    </div>
  )
}
