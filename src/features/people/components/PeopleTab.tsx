import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { Card, Button, CapacityProgressBar, Deadline, Tabs, Skeleton, EmptyState } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { useTrip, useParticipants, useCurrentUserRow } from '../../../lib/queries/useTrip'
import { useTimeline } from '../../../lib/queries/useTimeline'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import { ParticipantList } from './ParticipantList'
import { DependencyGraph } from './DependencyGraph'
import { WaitlistPanel } from './WaitlistPanel'
import { StatusModal } from './StatusModal'
import { ConfirmationSettingsSheet } from './ConfirmationSettingsSheet'
import { TravelDetailsSheet } from './TravelDetailsSheet'
import { ManageParticipantSheet } from './ManageParticipantSheet'
import { AddParticipantModal } from '../../../components/AddParticipantModal'
import { getMyTravelEvents, travelEventFlightRef, travelEventAirportCode } from '../lib/travelDetails'
import { formatTime } from '../../timeline'

interface PeopleTabProps {
  tripId: string
}

/**
 * Trip "People" tab: rebuilt participant list (status-grouped), capacity +
 * deadline, dependency graph, waitlist lifecycle, and the organizer
 * confirmation-settings sheet. This is the Component exported from
 * src/features/people/index.ts for the coordinator to wire into
 * TripDetail's tab config.
 *
 * Every RSVP/confirmation-status affordance below is gated on
 * trip.confirmation_enabled (via isConfirmationEnabled) -- when a trip
 * doesn't use confirmation tracking, this tab still needs to be fully
 * useful: a plain participant list, the self-service travel-details card,
 * and the Checklist tab all stay regardless.
 */
export function PeopleTab({ tripId }: PeopleTabProps) {
  const { user } = useAuth()
  const { data: trip, isLoading: tripLoading, isError: tripError, refetch: refetchTrip } = useTrip(tripId)
  const {
    data: participants,
    isLoading: participantsLoading,
    isError: participantsError,
    refetch: refetchParticipants,
  } = useParticipants(tripId)
  const { data: currentUserRow } = useCurrentUserRow(user?.id)

  const { data: timelineEvents = [] } = useTimeline(tripId)

  const [statusModalParticipant, setStatusModalParticipant] = useState<ParticipantWithUser | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [travelOpen, setTravelOpen] = useState(false)
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)
  const [manageParticipant, setManageParticipant] = useState<ParticipantWithUser | null>(null)
  const [view, setView] = useState<'list' | 'graph' | 'waitlist'>('list')

  const myTravel = useMemo(() => getMyTravelEvents(timelineEvents, user?.id), [timelineEvents, user?.id])

  const myParticipant = useMemo(
    () => participants?.find((p) => p.user_id === user?.id) ?? null,
    [participants, user?.id]
  )
  // Same definition TripDetail.tsx uses for its own isOrganizer: a system
  // admin (users.role = 'admin') or the trip's creator can manage the
  // roster even without an active 'organizer' participant row -- e.g. an
  // admin helping out on a trip they didn't personally organize.
  const isSystemAdmin = currentUserRow?.role === 'admin'
  const isOrganizer = isSystemAdmin || myParticipant?.role === 'organizer' || trip?.created_by === user?.id
  const confirmationEnabled = isConfirmationEnabled(trip)

  const counts = useMemo(() => {
    const list = participants || []
    return {
      confirmed: list.filter((p) => p.confirmation_status === 'confirmed').length,
      conditional: list.filter((p) => p.confirmation_status === 'conditional').length,
      interested: list.filter((p) => p.confirmation_status === 'interested').length,
      waitlist: list.filter((p) => p.confirmation_status === 'waitlist').length,
    }
  }, [participants])

  // The Dependencies/Waitlist tabs only exist while confirmation tracking is
  // on -- if an organizer turns it off while someone has one of those tabs
  // open, fall back to the always-available List tab rather than stranding
  // them on a tab that no longer has a button or panel.
  useEffect(() => {
    if (!confirmationEnabled && (view === 'graph' || view === 'waitlist')) setView('list')
  }, [confirmationEnabled, view])

  if (tripLoading || participantsLoading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton variant="card" height={120} />
        <Skeleton variant="list" lines={5} />
      </div>
    )
  }

  if (tripError || participantsError || !trip) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<ErrorState className="w-20 h-20 text-danger-500" />}
          title="Couldn't load this trip's people"
          description="Something went wrong fetching the roster. Check your connection and try again."
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
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5 max-w-2xl mx-auto">
      {confirmationEnabled ? (
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
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => setAddParticipantOpen(true)}>
                    Add participant
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </Button>
                </div>
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
      ) : (
        isOrganizer && (
          <Card>
            <Card.Content className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Participants</h2>
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                  {(participants || []).length} {(participants || []).length === 1 ? 'person' : 'people'} on this trip
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => setAddParticipantOpen(true)}>
                  Add participant
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                  Settings
                </Button>
              </div>
            </Card.Content>
          </Card>
        )
      )}

      {/* Travel details (UX_REDESIGN Part 2 "People additions"): self-service
          arrival/departure — the events land on the Plan board automatically. */}
      {myParticipant && (
        <Card>
          <Card.Content className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Your travel details</h3>
                {myTravel.arrival || myTravel.departure ? (
                  <div className="text-sm text-[var(--text-secondary)] mt-1 space-y-0.5">
                    {myTravel.arrival && (
                      <p>
                        ✈️ Arrive {new Date(myTravel.arrival.event_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        {myTravel.arrival.start_time ? ` · ${formatTime(myTravel.arrival.start_time)} local` : ''}
                        {travelEventFlightRef(myTravel.arrival) ? ` · ${travelEventFlightRef(myTravel.arrival)}` : ''}
                        {travelEventAirportCode(myTravel.arrival) ? ` · ${travelEventAirportCode(myTravel.arrival)}` : ''}
                      </p>
                    )}
                    {myTravel.departure && (
                      <p>
                        🧳 Depart {new Date(myTravel.departure.event_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        {myTravel.departure.start_time ? ` · ${formatTime(myTravel.departure.start_time)} local` : ''}
                        {travelEventFlightRef(myTravel.departure) ? ` · ${travelEventFlightRef(myTravel.departure)}` : ''}
                        {travelEventAirportCode(myTravel.departure) ? ` · ${travelEventAirportCode(myTravel.departure)}` : ''}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-muted)] mt-1">
                    When do you arrive and leave? It helps with pickups and fair cost splits.
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setTravelOpen(true)}>
                {myTravel.arrival || myTravel.departure ? 'Edit' : 'Add'}
              </Button>
            </div>
          </Card.Content>
        </Card>
      )}

      {confirmationEnabled ? (
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
                groupByStatus
                onSelect={(p) => {
                  // Only the current user can edit their own status --
                  // ParticipantList only renders a self row as a tappable
                  // button (grouped view) or nothing at all (flat view when
                  // confirmation tracking is off), so onSelect is only ever
                  // invoked for `user`'s own row.
                  setStatusModalParticipant(p)
                }}
                canManage={isOrganizer}
                onManage={(p) => setManageParticipant(p)}
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
      ) : (
        // Confirmation tracking off → only the roster view exists, so a
        // one-tab "List" strip is pure chrome; render the list directly.
        <ParticipantList
          participants={participants || []}
          currentUserId={user?.id}
          groupByStatus={false}
          onSelect={(p) => setStatusModalParticipant(p)}
          canManage={isOrganizer}
          onManage={(p) => setManageParticipant(p)}
        />
      )}

      {confirmationEnabled && (
        <StatusModal
          isOpen={!!statusModalParticipant}
          onClose={() => setStatusModalParticipant(null)}
          tripId={tripId}
          participant={statusModalParticipant}
          participants={participants || []}
          capacityLimit={trip.capacity_limit}
          confirmedCount={counts.confirmed}
        />
      )}

      <ConfirmationSettingsSheet
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        tripId={tripId}
        isOrganizer={isOrganizer}
      />

      <TravelDetailsSheet isOpen={travelOpen} onClose={() => setTravelOpen(false)} tripId={tripId} />

      {isOrganizer && (
        <AddParticipantModal
          isOpen={addParticipantOpen}
          onClose={() => setAddParticipantOpen(false)}
          tripId={tripId}
          existingParticipantIds={(participants || []).map((p) => p.user_id)}
          onSuccess={() => {}}
        />
      )}

      {/* Conditionally mounted (rather than always-mounted + isOpen) so the
          balance lookup inside only fires while an organizer/admin actually
          has it open. */}
      {manageParticipant && (
        <ManageParticipantSheet
          tripId={tripId}
          participant={manageParticipant}
          onClose={() => setManageParticipant(null)}
          participants={participants || []}
          baseCurrency={trip.base_currency}
          confirmationEnabled={confirmationEnabled}
          currentUserId={user?.id}
        />
      )}
    </div>
  )
}
