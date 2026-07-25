import { Badge, Button, Deadline, SelectionAvatars } from '../../../components/ui'
import { PlaceChip } from '../../places/components/PlaceChip'
import { CATEGORY_CONFIG, formatTimeRange } from '../../timeline/lib/categoryConfig'
import { formatMoney } from '../../decisions/lib/costImpact'
import { areVotesVisible } from '../../decisions/lib/voting'
import type { PlanItem } from '../lib/planItems'
import type { OptionVoteWithUser } from '../../../lib/queries/usePlanning'
import type { Tables } from '../../../types/database.types'

/** "Chosen by Alex & Sarah" / "Chosen by Alex, Sarah +3" — a compact summary of who committed to this option (planItems.ts rule 7's `selections`), used for both legacy pre-v3 picks and any new-era option that happens to carry selections. */
function formatChosenBy(selections: PlanItem['selections']): string {
  const names = selections.map((s) => s.user?.full_name || s.user?.email || 'Someone')
  if (names.length <= 2) return `Chosen by ${names.join(' & ')}`
  return `Chosen by ${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

function toAvatarSelections(selections: PlanItem['selections']) {
  return selections.map((s) => ({
    id: s.id,
    selected_at: s.selected_at ?? undefined,
    user: s.user
      ? {
          full_name: s.user.full_name ?? undefined,
          email: s.user.email ?? undefined,
          avatar_url: s.user.avatar_url ?? undefined,
          avatar_data: (s.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
        }
      : undefined,
  }))
}

/** "Alex & Sarah voted" / "Alex, Sarah +3 voted" — same compact-summary shape as formatChosenBy above, but for `option_votes` rather than `selections`, so the two mechanisms read as clearly distinct affordances when a card happens to carry both. */
function formatVotedBy(voters: OptionVoteWithUser[]): string {
  const names = voters.map((v) => v.user?.full_name || v.user?.email || 'Someone')
  if (names.length <= 2) return `${names.join(' & ')} voted`
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} voted`
}

function toAvatarVotes(voters: OptionVoteWithUser[]) {
  return voters
    .filter((v) => v.user)
    .map((v) => ({
      id: v.id,
      selected_at: v.created_at ?? undefined,
      user: v.user
        ? {
            full_name: v.user.full_name ?? undefined,
            email: v.user.email ?? undefined,
            avatar_url: v.user.avatar_url ?? undefined,
            avatar_data: (v.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
          }
        : undefined,
    }))
}

export interface PlanItemCardProps {
  item: PlanItem
  place?: Tables<'places'>
  onOpen: (item: PlanItem) => void
  onVote?: (item: PlanItem) => void
  isVoting?: boolean
  myVoted?: boolean
  /**
   * `option_votes` rows (with the voting user embedded) cast for THIS
   * item's option — the "voted for this" affordance, distinct from
   * `item.selections`' "Chosen by" affordance above. Gated by
   * `areVotesVisible` below (hide_votes_until_close), never by
   * isOrganizer/isAdmin: any participant who can see the vote button can
   * see who else voted, once votes are visible at all.
   */
  voters?: OptionVoteWithUser[]
  /** Compact rendering for dense contexts (Undecided tray, Decide lens list). */
  compact?: boolean
  /**
   * One-line variant (UPGRADE_MASTER_PLAN.md §13 build brief, "display
   * density"): time · title · chips, no description, no vote affordance —
   * used automatically for decided/booked items on busy/past days (see
   * density.ts's shouldDensifyDay). Only ever applied when the item is
   * `decided`/`booked` (checked below) — proposals/ideas always keep the
   * full card regardless of what a caller passes here, since they still
   * need the reviewer's attention.
   */
  dense?: boolean
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
  voters = [],
  compact = false,
  dense = false,
  outsideTripDates = false,
  timeClash = false,
}: PlanItemCardProps) {
  const category = item.category ? CATEGORY_CONFIG[item.category as keyof typeof CATEGORY_CONFIG] ?? CATEGORY_CONFIG.other : null
  const timeRange = !item.allDay && item.startTime ? formatTimeRange(item.allDay, item.startTime, item.endTime) : item.allDay ? 'All day' : null

  const isSolid = item.stage === 'decided' || item.stage === 'booked'
  const isProposal = item.stage === 'proposal'
  const isIdea = item.stage === 'idea'
  // Same hide_votes_until_close gate the item sheet uses (voting.ts's
  // areVotesVisible) — before that, nobody (organizer included) sees the
  // breakdown, only their own vote + total, so the card must stay silent
  // about voter identity too.
  const votesVisible = item.vote
    ? areVotesVisible({ vote_deadline: item.vote.voteDeadline, hide_votes_until_close: item.vote.hideVotesUntilClose })
    : false

  if (dense && isSolid) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(item)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(item)}
        className="w-full flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-1.5 text-sm cursor-pointer hover:border-accent-300 transition-colors"
      >
        {timeRange && <span className="shrink-0 text-xs font-medium text-[var(--text-secondary)]">{timeRange}</span>}
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{item.title}</span>
        {category && (
          <span className="shrink-0 text-xs" aria-hidden="true" title={category.label}>
            {category.emoji}
          </span>
        )}
        {item.stage === 'booked' && (
          <span className="shrink-0 text-xs" aria-hidden="true" title="Booked">
            🧾
          </span>
        )}
        {item.costImpact?.perPerson != null && item.costImpact.currency && (
          <span className="shrink-0 text-xs text-[var(--text-muted)]">
            {formatMoney(item.costImpact.perPerson, item.costImpact.currency)}/pp
          </span>
        )}
        {outsideTripDates && (
          <span className="shrink-0 text-xs" aria-hidden="true" title="Outside trip dates">
            ⚠️
          </span>
        )}
        {timeClash && (
          <span className="shrink-0 text-xs" aria-hidden="true" title="Time clash">
            ⏰
          </span>
        )}
      </div>
    )
  }

  return (
    // Non-interactive container (UPGRADE_MASTER_PLAN.md audit item 5): this
    // used to be div[role=button] wrapping a real vote/approve Button —
    // invalid interactive-in-interactive nesting with a double tab stop, on
    // the board's most-repeated component. The single focusable "open"
    // affordance now lives on the inner content wrapper below; the vote
    // Button is a sibling of it, outside the interactive region. Hover/
    // stage styling stays on this outer box so the whole card still reacts
    // to hover exactly as before.
    <div
      className={`w-full rounded-[var(--radius-lg)] border p-3 transition-colors ${
        isSolid
          ? 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-accent-300'
          : isProposal
            ? 'border-accent-300 bg-accent-50 dark:bg-accent-950/30 hover:border-accent-400'
            : 'border-dashed border-[var(--border-subtle)] bg-[var(--surface-sunken)] opacity-80 hover:opacity-100'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpen(item)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(item)}
          className="min-w-0 flex-1 text-left cursor-pointer"
        >
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

          {/* Who's committed to this option (planItems.ts rule 7): pre-v3
              legacy picks and any personal-order/decided option that
              carries `selections`, shown regardless of stage. */}
          {item.selections.length > 0 && (
            <div className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <SelectionAvatars selections={toAvatarSelections(item.selections)} maxAvatars={4} size="sm" />
              <span className="text-xs text-[var(--text-muted)]">{formatChosenBy(item.selections)}</span>
            </div>
          )}

          {/* Who's voted for this option — right where the vote is cast
              (feedback: "when I vote for something I can't see others
              voted what as well"), not just in the detail sheet. Uses
              entityLabel="voted for this" (vs. the default "selected
              this" above) so the popover header never reads as the same
              affordance as "Chosen by" if a card somehow carries both. */}
          {isProposal && item.vote && votesVisible && voters.length > 0 && (
            <div className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <SelectionAvatars selections={toAvatarVotes(voters)} maxAvatars={4} size="sm" entityLabel="voted for this" />
              <span className="text-xs text-[var(--text-muted)]">{formatVotedBy(voters)}</span>
            </div>
          )}
        </div>

        {/* Sibling of the interactive content wrapper above, not nested
            inside it — no stopPropagation needed since there's no parent
            click handler to bubble into. */}
        {isProposal && onVote && (
          <Button
            variant={myVoted ? 'primary' : 'secondary'}
            size="sm"
            isLoading={isVoting}
            onClick={() => onVote(item)}
          >
            {myVoted ? '✓ Voted' : item.vote?.votingMethod === 'approval' ? 'Approve' : item.vote?.votingMethod === 'ranked' ? 'Rank' : 'Vote'}
          </Button>
        )}
      </div>
    </div>
  )
}
