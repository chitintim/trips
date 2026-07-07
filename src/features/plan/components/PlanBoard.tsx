import { useMemo, useState } from 'react'
import { Button, EmptyState, Modal } from '../../../components/ui'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections } from '../../../lib/queries/usePlanning'
import { useAuth } from '../../../hooks/useAuth'
import { useToggleVote } from '../../../lib/queries/usePlanning'
import { generateDateRange, formatDayHeader } from '../../timeline/lib/dayGrouping'
import { MatrixView } from '../../decisions/components/MatrixView'
import { PlanItemCard } from './PlanItemCard'
import { groupPlanItemsByDate, groupUndatedBySection } from '../lib/planItems'
import type { PlanItem } from '../lib/planItems'
import type { Trip } from '../../../types'

export interface PlanBoardProps {
  trip: Trip
  items: PlanItem[]
  onOpenItem: (item: PlanItem) => void
  onScheduleIt: (item: PlanItem) => void
}

/**
 * The List lens (default view, plan §2): a day-by-day board from trip
 * start..end with sticky day headers, plus the Undecided tray pinned above
 * day 1 for anything without a date yet, grouped by its planning section.
 *
 * Layering rule (UX_REDESIGN.md "Systemic layering"): sticky day headers
 * use z-20 (well under the z-30 ceiling for in-content sticky elements)
 * and live inside this component's own scroll container, never escaping
 * into the app chrome's stacking context.
 */
export function PlanBoard({ trip, items, onOpenItem, onScheduleIt }: PlanBoardProps) {
  const { user } = useAuth()
  const { data: places } = usePlaces(trip.id)
  const { data: sections } = useSections(trip.id)
  const toggleVote = useToggleVote(trip.id)
  const [votingId, setVotingId] = useState<string | null>(null)
  const [matrixSectionId, setMatrixSectionId] = useState<string | null>(null)

  const placesById = useMemo(() => new Map((places || []).map((p) => [p.id, p])), [places])

  const dayDates = useMemo(() => {
    const eventDates = items.filter((i) => i.date).map((i) => i.date as string)
    if (eventDates.length === 0) return generateDateRange(trip.start_date, trip.end_date)
    const minDate = [trip.start_date, ...eventDates].sort()[0]
    const maxDate = [trip.end_date, ...eventDates].sort().pop()!
    return generateDateRange(minDate, maxDate)
  }, [items, trip.start_date, trip.end_date])

  const byDate = useMemo(() => groupPlanItemsByDate(items), [items])
  const undatedBySection = useMemo(() => groupUndatedBySection(items), [items])
  const hasUndated = undatedBySection.size > 0

  // The board's inline vote button only supports casting a fresh vote
  // (one tap = vote/approve). Un-voting requires the vote row's id, which
  // isn't loaded at board scope — that's a deliberate "do it in the detail
  // sheet" affordance, so a second tap on an already-voted card just opens
  // the item sheet instead of silently no-op'ing.
  const handleVote = (item: PlanItem) => {
    if (!user || !item.optionId || !item.vote) return
    const optionSection = (sections || []).find((s) => s.id === item.sectionId)
    const option = optionSection?.options.find((o) => o.id === item.optionId)
    if (option?.locked) return
    if (item.vote.myVote.voted) {
      onOpenItem(item)
      return
    }
    setVotingId(item.id)
    toggleVote.mutate(
      { optionId: item.optionId, userId: user.id, action: 'add' },
      { onSettled: () => setVotingId(null) }
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="🧭"
        title="Nothing on the plan yet"
        description="Add an idea, a vote, or a dated event with the + button to get started."
      />
    )
  }

  return (
    <div className="relative space-y-4">
      {hasUndated && (
        <div className="rounded-[var(--radius-lg)] border border-accent-200 bg-accent-50/60 dark:bg-accent-950/20 p-3 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">📥 Undecided</h3>
          {Array.from(undatedBySection.entries()).map(([sectionId, sectionItems]) => {
            const section = sectionId ? (sections || []).find((s) => s.id === sectionId) : undefined
            const isMatrix = sectionItems.some((i) => i.isMatrixSection)
            return (
              <div key={sectionId ?? 'none'} className="space-y-2">
                {section && (
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{section.title}</h4>
                    {isMatrix && (
                      <Button variant="ghost" size="sm" onClick={() => setMatrixSectionId(section.id)}>
                        Grid view
                      </Button>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  {sectionItems.map((item) => (
                    <PlanItemCard
                      key={item.id}
                      item={item}
                      place={item.placeId ? placesById.get(item.placeId) : undefined}
                      onOpen={onOpenItem}
                      onVote={item.vote ? handleVote : undefined}
                      isVoting={votingId === item.id}
                      myVoted={item.vote?.myVote.voted}
                      compact
                    />
                  ))}
                </div>
                <ScheduleWinnerAffordance items={sectionItems} onScheduleIt={onScheduleIt} />
              </div>
            )
          })}
        </div>
      )}

      <div className="space-y-3">
        {dayDates.map((date, i) => {
          const dayItems = byDate.get(date) || []
          const header = formatDayHeader(date, trip.start_date, trip.end_date)
          return (
            <div key={date} className="relative">
              <div className="sticky top-0 z-20 -mx-4 px-4 py-1.5 bg-[var(--surface-page)]/95 backdrop-blur-sm">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {header.dayNumber ? `Day ${header.dayNumber}` : header.dayLabel}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{header.label}</span>
                </div>
              </div>
              <div className="mt-2 space-y-2">
                {dayItems.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)] pl-1">Nothing planned yet</p>
                ) : (
                  dayItems.map((item) => (
                    <PlanItemCard
                      key={item.id}
                      item={item}
                      place={item.placeId ? placesById.get(item.placeId) : undefined}
                      onOpen={onOpenItem}
                      onVote={item.vote ? handleVote : undefined}
                      isVoting={votingId === item.id}
                      myVoted={item.vote?.myVote.voted}
                    />
                  ))
                )}
              </div>
              {i < dayDates.length - 1 && <div className="mt-3 border-b border-[var(--border-subtle)]" />}
            </div>
          )
        })}
      </div>

      {/* Matrix/grid view, portal-rendered via the shared Modal (layering
          rule: overlays never nest inside content, always use the token
          z-scale via Modal rather than an ad-hoc fixed/z-* div). */}
      <Modal isOpen={!!matrixSectionId} onClose={() => setMatrixSectionId(null)} size="lg" title="Grid view">
        {matrixSectionId && (
          <MatrixView
            tripId={trip.id}
            options={(sections || []).find((s) => s.id === matrixSectionId)?.options || []}
            currency={trip.base_currency}
          />
        )}
      </Modal>
    </div>
  )
}

/** "Schedule it" affordance for undated items that are already decided/won but not yet on the timeline. */
function ScheduleWinnerAffordance({ items, onScheduleIt }: { items: PlanItem[]; onScheduleIt: (item: PlanItem) => void }) {
  const schedulable = items.find((i) => i.isUnscheduledWinner)
  if (!schedulable) return null
  return (
    <Button variant="secondary" size="sm" onClick={() => onScheduleIt(schedulable)}>
      📅 Schedule "{schedulable.title}"
    </Button>
  )
}
