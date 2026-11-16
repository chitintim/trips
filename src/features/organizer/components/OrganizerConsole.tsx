import { useState } from 'react'
import { Button, Card, EmptyState, SegmentedControl, Skeleton } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { WaitingOnBoard } from './WaitingOnBoard'
import { BookingsTracker } from './BookingsTracker'
import { ActivityFeedPanel } from './ActivityFeedPanel'
import { EmailsPanel } from './EmailsPanel'
import { ChaseSettingsSheet } from './ChaseSettingsSheet'
import { parseChaseSettings } from '../lib/chaseSettings'

export interface OrganizerConsoleProps {
  tripId: string
  /** Tab to open on. Defaults to 'waiting' (Waiting on), so a plain `?tab=organizer` lands there. */
  initialView?: ConsoleView
}

export type ConsoleView = 'waiting' | 'bookings' | 'activity' | 'emails'

/**
 * Organizer console (plan §14): Waiting on, bookings tracker and the
 * activity feed behind one organizer-only tab, plus the per-trip
 * auto-chase settings sheet. The tab config exported from the feature
 * barrel is marked organizerOnly — the coordinator hides it for
 * participants — but the component also self-guards so a deep link can't
 * expose it.
 */
export function OrganizerConsole({ tripId, initialView = 'waiting' }: OrganizerConsoleProps) {
  const { data: trip, isLoading: tripLoading, isError: tripError, refetch: refetchTrip } = useTrip(tripId)
  const {
    isLoading: participantsLoading,
    isError: participantsError,
    refetch: refetchParticipants,
  } = useParticipants(tripId)
  const [view, setView] = useState<ConsoleView>(initialView)
  const [chaseOpen, setChaseOpen] = useState(false)
  const { canManageTrip, isLoading: permissionsLoading } = useTripPermissions(trip)

  if (tripLoading || participantsLoading || permissionsLoading) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton variant="card" height={44} />
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
      </div>
    )
  }

  if (tripError || participantsError || !trip) {
    return (
      <EmptyState
        icon={<ErrorState className="w-20 h-20 text-danger-500" />}
        title="Couldn't load the organizer console"
        description="Something went wrong fetching this trip. Check your connection and try again."
        action={
          <Button
            variant="primary"
            onClick={() => {
              refetchTrip()
              refetchParticipants()
            }}
          >
            Try again
          </Button>
        }
      />
    )
  }

  if (!canManageTrip) {
    return (
      <Card variant="flat">
        <Card.Content>
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">
            The organizer console is only visible to trip organizers.
          </p>
        </Card.Content>
      </Card>
    )
  }

  const chase = parseChaseSettings(trip.chase_settings)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SegmentedControl
            size="sm"
            value={view}
            onChange={(v) => setView(v as ConsoleView)}
            options={[
              { value: 'waiting', label: 'Waiting on', icon: <span>⏳</span> },
              { value: 'bookings', label: 'Bookings', icon: <span>🧾</span> },
              { value: 'activity', label: 'Activity', icon: <span>📰</span> },
              { value: 'emails', label: 'Emails', icon: <span>📧</span> },
            ]}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setChaseOpen(true)} title="Auto-chase settings" className="shrink-0">
          ⚙️ Chase{' '}
          <span className={chase.enabled ? 'text-success-600 font-medium' : 'text-[var(--text-muted)]'}>
            {chase.enabled ? 'on' : 'off'}
          </span>
        </Button>
      </div>

      {view === 'waiting' && <WaitingOnBoard trip={trip} />}
      {view === 'bookings' && <BookingsTracker trip={trip} />}
      {view === 'activity' && (
        <Card variant="flat">
          <Card.Content>
            <ActivityFeedPanel tripId={tripId} />
          </Card.Content>
        </Card>
      )}
      {view === 'emails' && (
        <Card variant="flat">
          <Card.Content>
            <EmailsPanel tripId={tripId} />
          </Card.Content>
        </Card>
      )}

      <ChaseSettingsSheet isOpen={chaseOpen} onClose={() => setChaseOpen(false)} trip={trip} />
    </div>
  )
}
