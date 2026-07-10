import { useMemo, useState } from 'react'
import { Button, Card, useToast } from '../../../components/ui'
import { useParticipants, useOptimisticUpdateTrip } from '../../../lib/queries/useTrip'
import { useBookings } from '../../../lib/queries/useBookings'
import { useTripActivityLog } from '../../organizer'
import { computeStageSuggestion } from '../lib/stageSuggestions'
import { isCardDismissed, dismissCard } from '../lib/dismissals'
import { getTripStatusLabel } from '../../../lib/tripStatus'
import type { Trip, TripStatus } from '../../../types'

export interface StageSuggestionCardProps {
  trip: Trip
  effectiveStage: TripStatus
}

/**
 * Stage-advance suggestion (UX_REDESIGN "Trip status: derived, suggested,
 * never nagging"): one-tap apply updates the STORED status (the effective
 * stage already drives UX), activity-logged, dismissible per suggestion.
 * Organizer-only — the caller gates.
 */
export function StageSuggestionCard({ trip, effectiveStage }: StageSuggestionCardProps) {
  const { showToast } = useToast()
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: bookings = [] } = useBookings(trip.id)
  const updateTrip = useOptimisticUpdateTrip(trip.id)
  const logActivity = useTripActivityLog(trip.id)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  const suggestion = useMemo(
    () =>
      computeStageSuggestion({
        storedStatus: trip.status,
        effectiveStage,
        confirmationEnabled: trip.confirmation_enabled === true,
        participantStatuses: participants.map((p) => p.confirmation_status ?? 'pending'),
        bookingCount: bookings.filter((b) => b.status !== 'cancelled').length,
      }),
    [trip.status, effectiveStage, trip.confirmation_enabled, participants, bookings]
  )

  if (!suggestion) return null
  if (dismissedKey === suggestion.key || isCardDismissed(trip.id, `stage-${suggestion.key}`)) return null

  const apply = async () => {
    try {
      await updateTrip.mutateAsync({ status: suggestion.to })
      logActivity({
        verb: 'status_changed',
        entity: { type: 'trip', id: trip.id, label: getTripStatusLabel(suggestion.to) },
        metadata: { from: trip.status, to: suggestion.to, source: 'stage_suggestion' },
      })
      showToast({ type: 'success', message: `Trip is now "${getTripStatusLabel(suggestion.to)}"` })
    } catch (err) {
      showToast({ type: 'error', message: 'Could not update the trip status', description: (err as Error).message })
    }
  }

  const dismiss = () => {
    dismissCard(trip.id, `stage-${suggestion.key}`)
    setDismissedKey(suggestion.key)
  }

  return (
    <Card variant="flat">
      <Card.Content className="py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {suggestion.kind === 'sync' ? '🔄 ' : '📈 '}
              {suggestion.title}
            </h3>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">{suggestion.detail}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={apply} isLoading={updateTrip.isPending}>
            {suggestion.kind === 'sync' ? 'Sync status' : 'Move it forward'}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </Card.Content>
    </Card>
  )
}
