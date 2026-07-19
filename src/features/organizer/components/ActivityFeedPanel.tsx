import { useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { EmptyState, Skeleton, UserAvatar } from '../../../components/ui'
import { useActivityFeed } from '../../../lib/queries/useActivityFeed'
import { useParticipants } from '../../../lib/queries/useTrip'
import { renderActivity } from '../lib/activity'

export interface ActivityFeedPanelProps {
  tripId: string
}

/**
 * Lightweight per-trip activity feed (plan §14) with human-readable verbs:
 * "Alex claimed 3 items", "Poll 'Saturday dinner' closed".
 */
export function ActivityFeedPanel({ tripId }: ActivityFeedPanelProps) {
  const { data: entries, isLoading } = useActivityFeed(tripId)
  const { data: participants } = useParticipants(tripId)

  const usersById = useMemo(() => {
    const map = new Map<string, { name: string; avatar_url: unknown; avatar_data: unknown }>()
    for (const p of participants ?? []) {
      map.set(p.user_id, {
        name: p.user?.full_name || p.user?.email || 'Someone',
        avatar_url: p.user?.avatar_url ?? null,
        avatar_data: p.user?.avatar_data ?? null,
      })
    }
    return map
  }, [participants])

  if (isLoading) return <Skeleton variant="list" lines={5} />

  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        icon="🌱"
        title="Nothing yet"
        description="Trip activity — votes, expenses, bookings, approvals — will show up here as it happens."
        compact
      />
    )
  }

  return (
    <ul className="divide-y divide-[var(--border-subtle)]">
      {entries.map((entry) => {
        const actor = entry.actor ? usersById.get(entry.actor) : undefined
        const actorName = actor?.name ?? (entry.actor ? 'Someone' : 'Trip Planner')
        const rendered = renderActivity(entry, actorName)
        return (
          <li key={entry.id} className="flex items-start gap-3 py-2.5">
            {actor ? (
              <UserAvatar avatarData={actor} size="sm" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-sm" aria-hidden="true">
                {rendered.icon}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--text-primary)]">
                <span className="mr-1" aria-hidden="true">
                  {rendered.icon}
                </span>
                {rendered.text}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
