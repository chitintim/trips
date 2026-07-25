import { useMemo } from 'react'
import { Badge, Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTrip } from '../../../lib/queries/useTrip'
import { useActions, useSectionVoters } from '../../../lib/queries/useActions'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import { countdownBadgeVariant, countdownLabel, isActionOpenForUser, isOverdue } from '../lib/actionStatus'

export interface ActionsSectionProps {
  tripId: string
  isOrganizer: boolean
  onOpenActions: () => void
}

/**
 * Today-tab card: up to 3 most-urgent OPEN actions relevant to the current
 * user — assigned to them directly, or a whole-group action they haven't
 * confirmed yet — overdue first. Mirrors YourTurnStack's card idiom.
 *
 * `ActionsSection` is the ONLY entry point into `ActionsSheet` (no
 * bottom-nav slot) — it used to return null for non-organizers whenever
 * nothing was open for them, which made the actions/bring list completely
 * unreachable for a participant with a clean plate. Every participant now
 * always gets a slim, visually quiet card that still opens the sheet: an
 * empty-state row when nothing's open trip-wide, "You're all caught up"
 * when something's open for someone else, or the full top-3 list.
 */
export function ActionsSection({ tripId, onOpenActions }: ActionsSectionProps) {
  const { user } = useAuth()
  const { data: trip } = useTrip(tripId)
  const { data: actions } = useActions(tripId)
  const sectionVoters = useSectionVoters(tripId)

  const relevant = useMemo(() => {
    if (!user) return []
    // Same predicate as the sheet's segment badge — assigned to me and
    // open, or a whole-group action I haven't confirmed yet. A
    // section-linked action drops out here the moment I cast my vote
    // (isActionOpenForUser is derived from sectionVoters, see actionStatus.ts).
    const mine = (actions || []).filter((a) => isActionOpenForUser(a, user.id, sectionVoters))
    return [...mine].sort((a, b) => {
      const aOverdue = isOverdue(a, trip)
      const bOverdue = isOverdue(b, trip)
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    })
  }, [actions, user, trip, sectionVoters])

  const topThree = relevant.slice(0, 3)

  if (topThree.length === 0) {
    // Two quiet flavors of the same slim entry-point row, neither gated by
    // isOrganizer: a genuinely empty trip still invites creating the first
    // action (any participant can, per ActionsSheet's un-gated "+ New
    // action"); a trip with actions open for OTHER people reads as "caught
    // up" rather than falsely implying nothing exists yet.
    const hasAnyActions = (actions || []).length > 0
    return (
      <button
        onClick={onOpenActions}
        className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
      >
        <span className="text-sm text-[var(--text-primary)]">{hasAnyActions ? "✅ You're all caught up" : '✅ Add an action'}</span>
        <span className="text-sm text-[var(--text-muted)]">{hasAnyActions ? 'View all →' : 'Actions →'}</span>
      </button>
    )
  }

  return (
    <section aria-label="Actions" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide">
          Actions
          <span
            aria-label={`${relevant.length} open for you`}
            className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-danger-500 text-white text-[10px] font-bold leading-none normal-case tracking-normal"
          >
            {relevant.length > 99 ? '99+' : relevant.length}
          </span>
        </h2>
        <Button variant="ghost" size="sm" onClick={onOpenActions}>
          View all
        </Button>
      </div>
      <Card>
        <Card.Content className="space-y-2 py-3">
          {topThree.map((action) => (
            <ActionSectionRow key={action.id} action={action} trip={trip} onOpenActions={onOpenActions} />
          ))}
        </Card.Content>
      </Card>
    </section>
  )
}

function ActionSectionRow({
  action,
  trip,
  onOpenActions,
}: {
  action: ActionWithCompletions
  trip: { start_date?: string | null } | null | undefined
  onOpenActions: () => void
}) {
  return (
    <button
      onClick={onOpenActions}
      className="w-full flex items-center justify-between gap-3 text-left rounded-[var(--radius-md)] hover:bg-[var(--surface-sunken)] px-1 py-1 -mx-1 transition-colors"
    >
      <span className="text-sm text-[var(--text-primary)] truncate">{action.title}</span>
      <Badge variant={countdownBadgeVariant(action, trip)} size="sm">
        {countdownLabel(action, trip)}
      </Badge>
    </button>
  )
}
