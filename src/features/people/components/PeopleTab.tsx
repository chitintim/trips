import { useMemo, useState } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { Card, Button, CapacityProgressBar, Deadline, Tabs, Skeleton } from '../../../components/ui'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { ParticipantList } from './ParticipantList'
import { DependencyGraph } from './DependencyGraph'
import { WaitlistPanel } from './WaitlistPanel'
import { StatusModal } from './StatusModal'
import { ConfirmationSettingsSheet } from './ConfirmationSettingsSheet'

interface PeopleTabProps {
  tripId: string
}

/**
 * Trip "People" tab: rebuilt participant list (status-grouped), capacity +
 * deadline, dependency graph, waitlist lifecycle, and the organizer
 * confirmation-settings sheet. This is the Component exported from
 * src/features/people/index.ts for the coordinator to wire into
 * TripDetail's tab config.
 */
export function PeopleTab({ tripId }: PeopleTabProps) {
  const { user } = useAuth()
  const { data: trip, isLoading: tripLoading } = useTrip(tripId)
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)

  const [statusModalParticipant, setStatusModalParticipant] = useState<ParticipantWithUser | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<'list' | 'graph' | 'waitlist'>('list')

  const myParticipant = useMemo(
    () => participants?.find((p) => p.user_id === user?.id) ?? null,
    [participants, user?.id]
  )
  const isOrganizer = myParticipant?.role === 'organizer'

  const counts = useMemo(() => {
    const list = participants || []
    return {
      confirmed: list.filter((p) => p.confirmation_status === 'confirmed').length,
      conditional: list.filter((p) => p.confirmation_status === 'conditional').length,
      interested: list.filter((p) => p.confirmation_status === 'interested').length,
      waitlist: list.filter((p) => p.confirmation_status === 'waitlist').length,
    }
  }, [participants])

  if (tripLoading || participantsLoading || !trip) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton variant="card" height={120} />
        <Skeleton variant="list" lines={5} />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5 max-w-2xl mx-auto">
      <Card>
        <Card.Content className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Who's coming</h2>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                {counts.confirmed} confirmed
                {counts.conditional > 0 && ` · ${counts.conditional} conditional`}
                {counts.waitlist > 0 && ` · ${counts.waitlist} waitlisted`}
              </p>
            </div>
            {isOrganizer && (
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
            )}
          </div>

          <CapacityProgressBar
            confirmedCount={counts.confirmed}
            capacityLimit={trip.capacity_limit}
            interestedCount={counts.interested}
            conditionalCount={counts.conditional}
            waitlistCount={counts.waitlist}
          />

          {trip.confirmation_deadline && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]">RSVP by</span>
              <Deadline date={trip.confirmation_deadline} kind="deadline" size="sm" />
            </div>
          )}

          {myParticipant && (
            <Button fullWidth onClick={() => setStatusModalParticipant(myParticipant)}>
              {myParticipant.confirmation_status === 'confirmed' ? 'View my status' : 'Update my status'}
            </Button>
          )}
        </Card.Content>
      </Card>

      <Tabs value={view} onChange={(v) => setView(v as typeof view)}>
        <Tabs.List>
          <Tabs.Tab value="list">List</Tabs.Tab>
          <Tabs.Tab value="graph">Dependencies</Tabs.Tab>
          <Tabs.Tab value="waitlist">Waitlist{counts.waitlist > 0 ? ` (${counts.waitlist})` : ''}</Tabs.Tab>
        </Tabs.List>

        <div className="mt-4">
          <Tabs.Panel value="list">
            <ParticipantList
              participants={participants || []}
              currentUserId={user?.id}
              onSelect={(p) => {
                // Only the current user can edit their own status; viewing
                // someone else's just shows the read-only recap via the
                // same modal when they happen to be confirmed, otherwise
                // organizers can still open it read-only in a future pass.
                if (p.user_id === user?.id) setStatusModalParticipant(p)
              }}
            />
          </Tabs.Panel>
          <Tabs.Panel value="graph">
            <DependencyGraph participants={participants || []} />
          </Tabs.Panel>
          <Tabs.Panel value="waitlist">
            <WaitlistPanel tripId={tripId} participants={participants || []} isOrganizer={isOrganizer} />
          </Tabs.Panel>
        </div>
      </Tabs>

      <StatusModal
        isOpen={!!statusModalParticipant}
        onClose={() => setStatusModalParticipant(null)}
        tripId={tripId}
        participant={statusModalParticipant}
        participants={participants || []}
        capacityLimit={trip.capacity_limit}
        confirmedCount={counts.confirmed}
      />

      <ConfirmationSettingsSheet
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        tripId={tripId}
        isOrganizer={isOrganizer}
      />
    </div>
  )
}
