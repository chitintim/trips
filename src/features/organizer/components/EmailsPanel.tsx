import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { EmptyState, Select, Skeleton, UserAvatar } from '../../../components/ui'
import { useNotifications } from '../../../lib/queries/useNotifications'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useActions } from '../../../lib/queries/useActions'
import { describeNotificationKind } from '../lib/activity'

export interface EmailsPanelProps {
  tripId: string
}

/**
 * Organizer "Emails" panel: every email the app has actually sent about
 * this trip (recipient, what it was about, when), newest first.
 *
 * Source: the `notifications` table, written by the auto-chase edge
 * function (the ONLY sender of trip-related email in this codebase as of
 * 2026-07 — nudge-draft only drafts WhatsApp text, and invitations/signup
 * go through Supabase Auth's own emails, which are account-level rather
 * than "about this trip" and aren't logged here). auto-chase logs one row
 * per reminder it decides to send, with `channel` recording whether the
 * email actually went out ('email') or was skipped (no provider configured,
 * the recipient opted out, or the send failed — 'skipped'). We only show
 * `channel === 'email'` rows here, since a 'skipped' row is precisely a
 * case where NO email was sent — showing it would overclaim.
 *
 * Entity titles: `notifications` doesn't store a description, only
 * entity_type/entity_id. We resolve titles for entity_type 'trip_action'
 * (the dominant real-world case — the 7d/1d/overdue action-deadline
 * ladder) via the already-standard useActions() cache; other entity types
 * (expense/settlement/booking/planning_section, only reachable via opt-in
 * chase settings) render with their kind label but no quoted title rather
 * than adding several more per-panel fetches for a rarer path.
 */
export function EmailsPanel({ tripId }: EmailsPanelProps) {
  const { data: notifications, isLoading: notificationsLoading } = useNotifications(tripId)
  const { data: participants, isLoading: participantsLoading } = useParticipants(tripId)
  const { data: actions, isLoading: actionsLoading } = useActions(tripId)
  const [kindFilter, setKindFilter] = useState<string>('all')

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

  const actionTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of actions ?? []) map.set(a.id, a.title)
    return map
  }, [actions])

  // Only rows that represent an email that actually went out — 'skipped'
  // rows are reminders auto-chase decided NOT to email (see file header).
  const emailsSent = useMemo(() => (notifications ?? []).filter((n) => n.channel === 'email'), [notifications])

  const kindOptions = useMemo(() => {
    const seen = [...new Set(emailsSent.map((n) => n.kind))].sort()
    return [
      { value: 'all', label: `All kinds (${emailsSent.length})` },
      ...seen.map((kind) => ({ value: kind, label: describeNotificationKind(kind).label })),
    ]
  }, [emailsSent])

  const filtered = kindFilter === 'all' ? emailsSent : emailsSent.filter((n) => n.kind === kindFilter)

  const isLoading = notificationsLoading || participantsLoading || actionsLoading

  if (isLoading) return <Skeleton variant="list" lines={5} />

  if (emailsSent.length === 0) {
    return (
      <EmptyState
        icon="📭"
        title="No emails logged yet"
        description="Automated reminder emails sent by the trip's chase engine will show up here as they go out."
        compact
      />
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        Emails we&apos;ve logged — automated reminders sent by the trip&apos;s chase engine. This isn&apos;t
        necessarily every email ever sent about the trip, only the ones the sender recorded.
      </p>

      {kindOptions.length > 2 && (
        <Select
          size="sm"
          fullWidth={false}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          options={kindOptions}
          aria-label="Filter by email type"
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState icon="🔍" title="No emails match this filter" compact />
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {filtered.map((n) => {
            const recipient = usersById.get(n.user_id)
            const { icon, label } = describeNotificationKind(n.kind)
            const entityTitle =
              n.entity_type === 'trip_action' && n.entity_id ? actionTitleById.get(n.entity_id) : undefined
            return (
              <li key={n.id} className="flex items-start gap-3 py-2.5">
                {recipient ? (
                  <UserAvatar avatarData={recipient} size="sm" />
                ) : (
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-sm"
                    aria-hidden="true"
                  >
                    {icon}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[var(--text-primary)]">
                    <span className="mr-1" aria-hidden="true">
                      {icon}
                    </span>
                    <span className="font-medium">{recipient?.name ?? 'Someone'}</span> — {label}
                    {entityTitle && <> — &quot;{entityTitle}&quot;</>}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {formatDistanceToNow(new Date(n.sent_at), { addSuffix: true })}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
