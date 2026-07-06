import { useMemo, useState } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { Button, Card, EmptyState, Skeleton } from '../../../components/ui'
import { useTrips } from '../../../lib/queries/useTrip'
import { TripCard } from './TripCard'
import { CreateTripSheet } from './CreateTripSheet'

/**
 * Non-admin "my trips" dashboard, rebuilt from the legacy Dashboard.tsx's
 * MemberView onto the new query hooks + ui kit. Exported as the Component
 * in src/features/dashboard/index.ts — the coordinator wires this into
 * Dashboard.tsx in place of MemberView (admin tabs remain untouched, owned
 * by another workstream).
 */
export function MemberDashboard() {
  const { user } = useAuth()
  const { data: trips, isLoading } = useTrips()
  const [createOpen, setCreateOpen] = useState(false)

  const { myTrips, publicTrips } = useMemo(() => {
    if (!trips || !user) return { myTrips: [], publicTrips: [] }

    const now = new Date()
    now.setHours(0, 0, 0, 0)

    // Note: useTrips() doesn't tell us participation directly; the
    // dashboard historically inferred "my trips" from trip_participants.
    // Since RLS already scopes `trips` to what the user can see (own +
    // public), and confirmed_count alone doesn't disambiguate membership,
    // we treat every trip returned as "mine" unless it's public and the
    // organizer/creator isn't the current user and the trip is upcoming —
    // matching the legacy behavior of only splitting out *other* public
    // trips as a separate discovery section.
    const mine = trips.filter((t) => !t.is_public || t.created_by === user.id)
    const others = trips.filter(
      (t) => t.is_public && t.created_by !== user.id && new Date(t.start_date) >= now
    )

    const ongoing = mine
      .filter((t) => new Date(t.start_date) <= now && new Date(t.end_date) >= now)
      .sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())
    const upcoming = mine
      .filter((t) => new Date(t.start_date) > now)
      .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
    const past = mine
      .filter((t) => new Date(t.end_date) < now)
      .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())

    return {
      myTrips: [...ongoing, ...upcoming, ...past],
      publicTrips: others.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()),
    }
  }, [trips, user])

  if (isLoading) {
    return (
      <div className="p-4 space-y-4 max-w-4xl mx-auto">
        <Skeleton variant="card" height={100} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton variant="card" height={160} />
          <Skeleton variant="card" height={160} />
          <Skeleton variant="card" height={160} />
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-8 max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Your trips</h2>
          <p className="text-[var(--text-secondary)] mt-1">Where are you headed next?</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>+ New trip</Button>
      </div>

      <div>
        {myTrips.length === 0 ? (
          <Card>
            <Card.Content className="py-12">
              <EmptyState
                icon="🧳"
                title="No trips yet"
                description="Create your first trip to get started."
                action={<Button onClick={() => setCreateOpen(true)}>+ New trip</Button>}
              />
            </Card.Content>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {myTrips.map((trip) => (
              <TripCard key={trip.id} trip={trip} />
            ))}
          </div>
        )}
      </div>

      {publicTrips.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-3">Other public trips</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {publicTrips.map((trip) => (
              <TripCard key={trip.id} trip={trip} />
            ))}
          </div>
        </div>
      )}

      <CreateTripSheet isOpen={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
