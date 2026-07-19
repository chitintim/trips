import { useCallback, useMemo, useState } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { Button, Card, EmptyState, Skeleton } from '../../../components/ui'
import { useTrips } from '../../../lib/queries/useTrip'
import { TripCard } from './TripCard'
import { CreateTripWizard } from './CreateTripWizard'
import { LandingRedirectPrompt } from './LandingRedirectPrompt'
import { isMyTrip, orderDashboardTrips } from '../lib/landing'

/**
 * Non-admin "my trips" dashboard with the v2.1 landing rules
 * (UX_REDESIGN.md Part 2):
 * - Fresh app entry with exactly ONE active (non-completed) trip → redirect
 *   straight into it. In-app navigation back to the dashboard never
 *   redirects (only the initial history entry does).
 * - Cards ordered active-with-your-actions → active → upcoming; past trips
 *   collapse behind a toggle.
 */
export function MemberDashboard() {
  const { user } = useAuth()
  const { data: trips, isLoading } = useTrips()
  const [createOpen, setCreateOpen] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [attentionCounts, setAttentionCounts] = useState<Record<string, number>>({})

  const { myTrips, publicTrips } = useMemo(() => {
    if (!trips || !user) return { myTrips: [], publicTrips: [] }
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return {
      myTrips: trips.filter((t) => isMyTrip(t, user.id)),
      publicTrips: trips
        .filter((t) => !isMyTrip(t, user.id) && new Date(t.start_date) >= now)
        .sort((a, b) => a.start_date.localeCompare(b.start_date)),
    }
  }, [trips, user])

  // Landing rule (revised): the old instant single-active-trip redirect is
  // superseded by the countdown prompt below (LandingRedirectPrompt), which
  // handles the once-per-session guard and announcement sequencing itself.

  const ordered = useMemo(() => orderDashboardTrips(myTrips, attentionCounts), [myTrips, attentionCounts])

  const reportAttention = useCallback((tripId: string, count: number) => {
    setAttentionCounts((prev) => (prev[tripId] === count ? prev : { ...prev, [tripId]: count }))
  }, [])

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
          <div className="space-y-6">
            {ordered.active.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {ordered.active.map((trip) => (
                  <TripCard key={trip.id} trip={trip} onAttentionCount={reportAttention} />
                ))}
              </div>
            )}

            {ordered.past.length > 0 && (
              <div>
                <button
                  onClick={() => setShowPast((v) => !v)}
                  className="flex items-center gap-2 text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3"
                  aria-expanded={showPast}
                >
                  <span aria-hidden="true">{showPast ? '▾' : '▸'}</span>
                  Past trips ({ordered.past.length})
                </button>
                {showPast && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {ordered.past.map((trip) => (
                      <TripCard key={trip.id} trip={trip} />
                    ))}
                  </div>
                )}
              </div>
            )}
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

      <CreateTripWizard isOpen={createOpen} onClose={() => setCreateOpen(false)} />
      <LandingRedirectPrompt />
    </div>
  )
}
