import { Badge, Deadline, SelectionAvatars } from '../../../components/ui'
import { useSections } from '../../../lib/queries/usePlanning'
import { useQuestionAnswers } from '../../decisions'
import { planItemStatus } from '../lib/itemSheet'
import { PlaceChip } from '../../places/components/PlaceChip'
import { CATEGORY_CONFIG, formatTimeRange } from '../../timeline/lib/categoryConfig'
import { formatMoney, splitAcrossNote } from '../../decisions/lib/costImpact'
import type { PlanItem } from '../lib/planItems'
import type { Tables } from '../../../types/database.types'
import type { Trip } from '../../../types'

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

/**
 * The ONE place the card states money (Phase 3 swaps this for the shared
 * PriceTag): the per-person cost badge. Returns null when the item has none.
 */
function ItemCost({ item }: { item: PlanItem }) {
  if (item.costImpact?.perPerson == null || !item.costImpact.currency) return null
  return (
    <Badge variant="info" size="sm">
      {item.costImpact.isEstimate ? '≈ ' : item.costImpact.isTiered ? '≈' : '+'}
      {formatMoney(item.costImpact.perPerson, item.costImpact.currency)}
      {item.costImpact.isEstimate && item.costImpact.headcount > 0 ? ` per person (${splitAcrossNote(item.costImpact.headcount)})` : '/person'}
    </Badge>
  )
}

/** Compact cost text for the one-line dense row (same slot, shorter form). */
function denseCostText(item: PlanItem): string | null {
  if (item.costImpact?.perPerson == null || !item.costImpact.currency) return null
  return `${formatMoney(item.costImpact.perPerson, item.costImpact.currency)}/pp`
}

/**
 * "Needs your answer" / "Answered ✓" straight from the answers engine, so it
 * always equals the question card and the to-do. Mounted only for open
 * option-backed items when the caller passes `trip`.
 */
function AnswerChip({ trip, sectionId }: { trip: Trip; sectionId: string }) {
  const { data: sections } = useSections(trip.id)
  const section = (sections || []).find((s) => s.id === sectionId)
  if (!section) return null
  return <AnswerChipInner trip={trip} section={section} />
}

function AnswerChipInner({ trip, section }: { trip: Trip; section: NonNullable<ReturnType<typeof useSections>['data']>[number] }) {
  const { card } = useQuestionAnswers(trip, section)
  if (!card.chip || card.stage !== 'open') return null
  return (
    <Badge variant={card.chip.tone} size="sm">
      {card.chip.label}
    </Badge>
  )
}

export interface PlanItemCardProps {
  item: PlanItem
  place?: Tables<'places'>
  onOpen: (item: PlanItem) => void
  /**
   * The trip, so an open question's item can show the engine's answers chip
   * ("Needs your answer" / "Answered ✓"). Optional: without it no chip shows.
   */
  trip?: Trip
  /** Compact rendering for dense contexts (Undecided tray). */
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
 * One plan item card. State shows with the approved statuses only
 * (Open / Decided / Booked / Done); answering happens in the item sheet or the
 * question card, never on this card.
 */
export function PlanItemCard({
  item,
  place,
  onOpen,
  trip,
  compact = false,
  dense = false,
  outsideTripDates = false,
  timeClash = false,
}: PlanItemCardProps) {
  const category = item.category ? CATEGORY_CONFIG[item.category as keyof typeof CATEGORY_CONFIG] ?? CATEGORY_CONFIG.other : null
  const timeRange = !item.allDay && item.startTime ? formatTimeRange(item.allDay, item.startTime, item.endTime) : item.allDay ? 'All day' : null

  const isSolid = item.stage === 'decided' || item.stage === 'booked'
  const status = planItemStatus(item)
  const showAnswerChip = !!trip && !!item.sectionId && !isSolid

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
        {item.booking?.cancelled && (
          <span className="shrink-0 text-xs" aria-hidden="true" title="Booking cancelled — needs rebooking">
            ⚠️
          </span>
        )}
        {denseCostText(item) && <span className="shrink-0 text-xs text-[var(--text-muted)]">{denseCostText(item)}</span>}
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
    // Non-interactive container; the single focusable "open" affordance is the inner content wrapper.
    <div
      className={`w-full rounded-[var(--radius-lg)] border p-3 transition-colors ${
        isSolid
          ? 'border-[var(--border-default)] bg-[var(--surface-raised)] hover:border-accent-300'
          : 'border-accent-300 bg-accent-50 dark:bg-accent-950/30 hover:border-accent-400'
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
            {status && (
              <Badge variant={status.variant} size="sm">
                {status.label === 'Booked' ? '🧾 ' : ''}
                {status.label}
              </Badge>
            )}
            {showAnswerChip && <AnswerChip trip={trip!} sectionId={item.sectionId!} />}
            {item.booking?.cancelled && (
              <Badge variant="error" size="sm" wrap>
                ⚠️ Booking cancelled — needs rebooking
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

          <h4 className={`mt-1 font-medium text-[var(--text-primary)] ${compact ? 'text-sm' : ''}`}>
            {item.title}
          </h4>

          {place && (
            <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
              <PlaceChip place={place} compact />
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <ItemCost item={item} />
            {item.expenseId && (
              <Badge variant="neutral" size="sm">
                💵 Linked expense
              </Badge>
            )}
            {status?.label === 'Open' && item.vote?.voteDeadline && <Deadline date={item.vote.voteDeadline} kind="vote" compact size="sm" />}
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
        </div>
      </div>
    </div>
  )
}
