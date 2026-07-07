import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Card, Deadline } from '../../../components/ui'
import { StageRail, getTripAccentStyle } from '../../../components/layout'
import { useNeedsAttention } from '../../../lib/queries/useNeedsAttention'
import { getTripStatusLabel } from '../../../lib/tripStatus'
import { effectiveTripStage } from '../../../lib/tripStage'
import type { TripWithCount } from '../../../lib/queries/useTrip'

interface TripCardProps {
  trip: TripWithCount
  /** Reports this card's needs-attention badge count up (dashboard ordering). */
  onAttentionCount?: (tripId: string, count: number) => void
}

function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', opts)}, ${start.getFullYear()}`
  }
  return `${start.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })} – ${end.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`
}

/**
 * Dashboard trip card: per-trip accent (via getTripAccentStyle, deterministic
 * from trip id until a real accent_hue column exists), compact stage rail,
 * countdown, and needs-attention badge count for the current user on this
 * trip.
 */
export function TripCard({ trip, onAttentionCount }: TripCardProps) {
  const navigate = useNavigate()
  const needsAttention = useNeedsAttention(trip.id)
  const totalAttentionCount = needsAttention.reduce((sum, item) => sum + (item.count ?? 1), 0)

  useEffect(() => {
    onAttentionCount?.(trip.id, totalAttentionCount)
  }, [onAttentionCount, trip.id, totalAttentionCount])

  // Stage-driven UI runs on the EFFECTIVE stage (date-upgraded, never
  // downgraded) — a trip whose dates have started reads as ongoing even if
  // the organizer hasn't bumped the stored status yet.
  const stage = effectiveTripStage(trip)

  const now = Date.now()
  const isUpcoming = new Date(trip.start_date).getTime() > now
  const isOngoing = stage === 'trip_ongoing'

  // Countdown chip (UX_REDESIGN.md Part 3 "Countdown: ... dashboard
  // TripCard chip"): days-to-go for upcoming trips, computed off local
  // midnight so it doesn't flicker between values within the same day.
  const daysToGo = isUpcoming
    ? Math.max(0, Math.round((new Date(trip.start_date + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000))
    : null

  return (
    <div data-trip-accent style={getTripAccentStyle(trip.id)}>
      <Card hoverable clickable onClick={() => navigate(`/${trip.id}`)} className="overflow-hidden">
        <div className="h-2 -mx-6 -mt-6 mb-4 bg-accent-500" />
        <Card.Content className="space-y-3 pt-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-[var(--text-primary)] truncate">{trip.name}</h3>
              <p className="text-sm text-[var(--text-secondary)] truncate">{trip.location}</p>
            </div>
            {totalAttentionCount > 0 && (
              <Badge variant="warning" size="sm" dot>
                {totalAttentionCount}
              </Badge>
            )}
          </div>

          <p className="text-sm text-[var(--text-secondary)]">{formatDateRange(trip.start_date, trip.end_date)}</p>

          <StageRail status={stage} compact />

          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="neutral" size="sm">
              {getTripStatusLabel(stage)}
            </Badge>
            {isOngoing && (
              <Badge variant="info" size="sm">
                Happening now
              </Badge>
            )}
            {daysToGo != null && (
              <Badge variant="neutral" size="sm">
                ⏳ {daysToGo === 0 ? 'Today' : `${daysToGo} day${daysToGo === 1 ? '' : 's'} to go`}
              </Badge>
            )}
            {isUpcoming && trip.confirmation_deadline && <Deadline date={trip.confirmation_deadline} kind="deadline" size="sm" />}
            <span className="text-xs text-[var(--text-muted)]">{trip.confirmed_count} confirmed</span>
          </div>
        </Card.Content>
      </Card>
    </div>
  )
}
