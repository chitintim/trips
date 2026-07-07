import { useMemo, useState } from 'react'
import { useActivityFeed } from '../../../lib/queries/useActivityFeed'
import { useParticipants } from '../../../lib/queries/useTrip'
import { renderActivity } from '../../organizer'
import { formatRelativeTime } from '../../notes'

const SHOWN = 8

/**
 * Collapsed "recent activity" section at the bottom of Today (UX_REDESIGN
 * §1: the activity feed folds in here; the full feed stays in the Console).
 */
export function RecentActivitySection({ tripId }: { tripId: string }) {
  const [open, setOpen] = useState(false)
  const { data: entries = [] } = useActivityFeed(tripId)
  const { data: participants = [] } = useParticipants(tripId)

  const nameFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of participants) map.set(p.user_id, p.user?.first_name || p.user?.full_name || 'Someone')
    return (userId: string | null) => (userId ? (map.get(userId) ?? 'Someone') : 'Someone')
  }, [participants])

  if (entries.length === 0) return null

  return (
    <section aria-label="Recent activity" className="pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide py-1"
        aria-expanded={open}
      >
        <span>Recent activity</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {entries.slice(0, SHOWN).map((entry) => {
            const rendered = renderActivity(entry, nameFor(entry.actor))
            return (
              <li key={entry.id} className="text-sm text-[var(--text-secondary)] flex items-baseline gap-2">
                <span aria-hidden="true">{rendered.icon}</span>
                <span className="min-w-0 truncate">{rendered.text}</span>
                <span className="text-xs text-[var(--text-muted)] shrink-0 ml-auto">
                  {formatRelativeTime(entry.created_at)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
