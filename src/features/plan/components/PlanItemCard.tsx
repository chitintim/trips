import { Badge, Button, Deadline } from '../../../components/ui'
import { PlaceChip } from '../../places/components/PlaceChip'
import { CATEGORY_CONFIG, formatTimeRange } from '../../timeline/lib/categoryConfig'
import { formatMoney } from '../../decisions/lib/costImpact'
import type { PlanItem } from '../lib/planItems'
import type { Tables } from '../../../types/database.types'

export interface PlanItemCardProps {
  item: PlanItem
  place?: Tables<'places'>
  onOpen: (item: PlanItem) => void
  onVote?: (item: PlanItem) => void
  isVoting?: boolean
  myVoted?: boolean
  /** Compact rendering for dense contexts (Undecided tray, Decide lens list). */
  compact?: boolean
  /**
   * Calendar edge case #1 (UX_REDESIGN.md Part 3): the trip's dates changed
   * after this item was scheduled and it now falls outside [start_date,
   * end_date]. Never auto-moved/deleted — just flagged, with the card tap
   * (onOpen -> the item sheet's Edit affordance) as the re-anchor path.
   */
  outsideTripDates?: boolean
  /** Companion-suggestions rule 3 (UX_REDESIGN.md Part 3 "Ambient AI" #3): this item's time overlaps another item on the same day. */
  timeClash?: boolean
}

/**
 * One plan item card, styled by stage (plan §2): solid for decided/booked,
 * inline voting card for proposals, muted for ideas. Shared between
 * PlanBoard's day rows/tray and the Decide lens so stage styling stays
 * consistent everywhere the item appears.
 */
export function PlanItemCard({
  item,
  place,
  onOpen,
  onVote,
  isVoting,
  myVoted,
  compact = false,
  outsideTripDates = false,
  timeClash = false,
}: PlanItemCardProps) {
  const category = item.category ? CATEGORY_CONFIG[item.category as keyof typeof CATEGORY_CONFIG] ?? CATEGORY_CONFIG.other : null
  const timeRange = !item.allDay && item.startTime ? formatTimeRange(item.allDay, item.startTime, item.endTime) : item.allDay ? 'All day' : null

  const isSolid = item.stage === 'decided' || item.stage === 'booked'
  const isProposal = item.stage === 'proposal'
  const isIdea = item.stage === 'idea'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(item)}
      className={`w-full text-left rounded-[var(--radius-lg)] border p-3 transition-colors cursor-pointer ${
        isSolid
          ? 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-accent-300'
          : isProposal
            ? 'border-accent-300 bg-accent-50 dark:bg-accent-950/30 hover:border-accent-400'
            : 'border-dashed border-[var(--border-subtle)] bg-[var(--surface-sunken)] opacity-80 hover:opacity-100'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {timeRange && (
              <span className="rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
                {timeRange}
              </span>
            )}
            {category && (
              <span className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium ${category.badgeClassName}`}>
                {category.emoji} {category.label}
              </span>
            )}
            {item.stage === 'booked' && (
              <Badge variant="success" size="sm">
                🧾 Booked
              </Badge>
            )}
            {isIdea && (
              <Badge variant="neutral" size="sm">
                💡 Idea
              </Badge>
            )}
            {outsideTripDates && (
              <Badge variant="warning" size="sm">
                ⚠️ Outside trip dates
              </Badge>
            )}
            {timeClash && (
              <Badge variant="error" size="sm">
                ⏰ Time clash
              </Badge>
            )}
          </div>

          <h4 className={`mt-1 font-medium ${isSolid ? 'text-[var(--text-primary)]' : 'text-[var(--text-primary)]'} ${!compact ? '' : 'text-sm'}`}>
            {item.title}
          </h4>

          {place && (
            <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
              <PlaceChip place={place} compact />
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {item.costImpact?.perPerson != null && item.costImpact.currency && (
              <Badge variant="info" size="sm">
                {item.costImpact.isTiered ? '≈' : '+'}
                {formatMoney(item.costImpact.perPerson, item.costImpact.currency)}/person
              </Badge>
            )}
            {item.expenseId && (
              <Badge variant="neutral" size="sm">
                💵 Linked expense
              </Badge>
            )}
            {isProposal && item.vote?.voteDeadline && <Deadline date={item.vote.voteDeadline} kind="vote" compact size="sm" />}
          </div>
          {item.costImpact?.sensitivityLine && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">{item.costImpact.sensitivityLine}</p>
          )}
        </div>

        {isProposal && onVote && (
          <Button
            variant={myVoted ? 'primary' : 'secondary'}
            size="sm"
            isLoading={isVoting}
            onClick={(e) => {
              e.stopPropagation()
              onVote(item)
            }}
          >
            {myVoted ? '✓ Voted' : item.vote?.votingMethod === 'approval' ? 'Approve' : item.vote?.votingMethod === 'ranked' ? 'Rank' : 'Vote'}
          </Button>
        )}
      </div>
    </div>
  )
}
