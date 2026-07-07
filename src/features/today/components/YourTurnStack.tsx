import { useMemo } from 'react'
import { Button, Card, Deadline } from '../../../components/ui'
import { useNeedsAttention } from '../../../lib/queries/useNeedsAttention'
import { useSections } from '../../../lib/queries/usePlanning'
import type { NeedsAttentionItem } from '../../../components/layout'

export interface YourTurnStackProps {
  tripId: string
  /** Map of needs-attention target space id → navigation. */
  onNavigate: (spaceId: string) => void
}

/**
 * "Your turn" stack (UX_REDESIGN Part 2): the user's open actions rendered
 * as one action card each — votes (with the closest poll deadline as a
 * Deadline chip) first, then RSVP, claims, settlements.
 */
export function YourTurnStack({ tripId, onNavigate }: YourTurnStackProps) {
  const items = useNeedsAttention(tripId, onNavigate)
  const { data: sections } = useSections(tripId)

  const earliestPollDeadline = useMemo(() => {
    const now = Date.now()
    let earliest: string | null = null
    for (const s of sections || []) {
      if (!s.vote_deadline) continue
      if (new Date(s.vote_deadline).getTime() <= now) continue
      if (!earliest || s.vote_deadline < earliest) earliest = s.vote_deadline
    }
    return earliest
  }, [sections])

  const ordered = useMemo(() => {
    const isVote = (i: NeedsAttentionItem) => i.icon === '🗳️'
    return [...items.filter(isVote), ...items.filter((i) => !isVote(i))]
  }, [items])

  if (ordered.length === 0) return null

  return (
    <section aria-label="Your turn" className="space-y-2">
      <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide">Your turn</h2>
      {ordered.map((item, idx) => (
        <Card key={`${item.label}-${idx}`}>
          <Card.Content className="flex items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xl" aria-hidden="true">
                {item.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                  {item.label}
                  {item.count != null && item.count > 1 ? ` (${item.count})` : ''}
                </p>
                {item.icon === '🗳️' && earliestPollDeadline && (
                  <div className="mt-1">
                    <Deadline date={earliestPollDeadline} kind="deadline" size="sm" />
                  </div>
                )}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={item.onClick}>
              Go
            </Button>
          </Card.Content>
        </Card>
      ))}
    </section>
  )
}
