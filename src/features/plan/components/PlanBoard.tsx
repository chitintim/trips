import { useMemo, useState } from 'react'
import { Button, EmptyState, Modal, formatDeadlineLabel } from '../../../components/ui'
import { EmptyPlan } from '../../../components/ui/illustrations'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections, useCreateSection } from '../../../lib/queries/usePlanning'
import { useAuth } from '../../../hooks/useAuth'
import { useToggleVote } from '../../../lib/queries/usePlanning'
import { generateDateRange, formatDayHeader } from '../../timeline/lib/dayGrouping'
import { MatrixView } from '../../decisions/components/MatrixView'
import { PlanItemCard } from './PlanItemCard'
import { groupPlanItemsByDate, groupUndatedBySection } from '../lib/planItems'
import { useDaySwipe } from '../lib/useDaySwipe'
import type { PlanItem } from '../lib/planItems'
import type { Trip } from '../../../types'
import type { Tables } from '../../../types/database.types'

const dayAnchorId = (date: string) => `plan-day-${date}`

/** Smooth-scrolls to a day's sticky header, honoring reduced-motion. */
function scrollToDay(date: string) {
  const el = document.getElementById(dayAnchorId(date))
  if (!el) return
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' })
}

export interface PlanBoardProps {
  trip: Trip
  items: PlanItem[]
  isOrganizer?: boolean
  onOpenItem: (item: PlanItem) => void
  onScheduleIt: (item: PlanItem) => void
  /** "New question" affordance in the Open questions tray (organizer only, UX_REDESIGN.md Part 4). */
  onNewQuestion?: () => void
}

/**
 * Starter questions offered to organizers on a completely empty plan
 * (UX_REDESIGN.md Part 2 "guided setup" + Part 4 "questions, not sections":
 * section machinery stays hidden — users see the questions).
 */
const STARTER_QUESTIONS: Array<{ title: string; section_type: 'accommodation' | 'transport' | 'activities' }> = [
  { title: 'Where are we staying?', section_type: 'accommodation' },
  { title: 'How are we getting there?', section_type: 'transport' },
  { title: 'What do we want to do?', section_type: 'activities' },
]

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
export function PlanBoard({ trip, items, isOrganizer = false, onOpenItem, onScheduleIt, onNewQuestion }: PlanBoardProps) {
  const { user } = useAuth()
  const { data: places } = usePlaces(trip.id)
  const { data: sections } = useSections(trip.id)
  const toggleVote = useToggleVote(trip.id)
  const createSection = useCreateSection(trip.id)
  const [votingId, setVotingId] = useState<string | null>(null)
  const [creatingStarters, setCreatingStarters] = useState(false)
  const [matrixSectionId, setMatrixSectionId] = useState<string | null>(null)

  const handleCreateStarterQuestions = async () => {
    setCreatingStarters(true)
    try {
      for (const [i, q] of STARTER_QUESTIONS.entries()) {
        await createSection.mutateAsync({
          title: q.title,
          section_type: q.section_type,
          status: 'in_progress',
          allow_multiple_selections: q.section_type === 'activities',
          order_index: i,
        })
      }
    } finally {
      setCreatingStarters(false)
    }
  }

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
    const planCompletelyEmpty = sections !== undefined && (sections || []).length === 0
    if (isOrganizer && planCompletelyEmpty) {
      return (
        <EmptyState
          icon={<EmptyPlan className="w-32 h-24 text-accent-500" />}
          title="Start with the big questions"
          description="Most trips begin by answering three things — set them up as group votes in one tap, or add your own with the + button."
          action={
            <div className="space-y-2 text-left">
              <ul className="text-sm text-[var(--text-secondary)] space-y-1">
                {STARTER_QUESTIONS.map((q) => (
                  <li key={q.section_type}>• {q.title}</li>
                ))}
              </ul>
              <Button onClick={handleCreateStarterQuestions} isLoading={creatingStarters} fullWidth>
                Set up these questions
              </Button>
            </div>
          }
        />
      )
    }
    return (
      <EmptyState
        icon={<EmptyPlan className="w-32 h-24 text-[var(--text-muted)]" />}
        title="Nothing on the plan yet"
        description="Add an idea, a vote, or a dated event with the + button to get started."
      />
    )
  }

  return (
    <div className="relative space-y-4">
      {hasUndated && (
        <div className="rounded-[var(--radius-lg)] border border-accent-200 bg-accent-50/60 dark:bg-accent-950/20 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">❔ Open questions</h3>
            {isOrganizer && onNewQuestion && (
              <Button variant="ghost" size="sm" onClick={onNewQuestion}>
                + New question
              </Button>
            )}
          </div>
          {Array.from(undatedBySection.entries()).map(([sectionId, sectionItems]) => {
            const section = sectionId ? (sections || []).find((s) => s.id === sectionId) : undefined
            const isMatrix = sectionItems.some((i) => i.isMatrixSection)
            // Questions, not sections (UX_REDESIGN.md Part 4 "Decisions:
            // questions, not sections"): the section's TITLE renders as the
            // question itself ("Where are we staying?"), with a plain
            // "N options · closes <date>" meta line -- no section_type
            // badge/chrome, no uppercase label treatment. Sections remain
            // the storage grouping only.
            return (
              <div key={sectionId ?? 'none'} className="space-y-2">
                {section && (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="text-sm font-medium text-[var(--text-primary)]">{section.title}</h4>
                      <p className="text-xs text-[var(--text-muted)]">
                        {section.options.length} option{section.options.length === 1 ? '' : 's'}
                        {section.vote_deadline && <> · closes {formatDeadlineLabel(section.vote_deadline, 'vote')}</>}
                      </p>
                    </div>
                    {isMatrix && (
                      <Button variant="ghost" size="sm" onClick={() => setMatrixSectionId(section.id)} className="shrink-0">
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
        {dayDates.map((date, i) => (
          <PlanDaySection
            key={date}
            date={date}
            dayItems={byDate.get(date) || []}
            header={formatDayHeader(date, trip.start_date, trip.end_date)}
            prevDate={dayDates[i - 1]}
            nextDate={dayDates[i + 1]}
            placesById={placesById}
            onOpenItem={onOpenItem}
            onVote={handleVote}
            votingId={votingId}
            isLast={i === dayDates.length - 1}
          />
        ))}
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

interface PlanDaySectionProps {
  date: string
  dayItems: PlanItem[]
  header: { dayNumber: number | null; dayLabel: string; label: string }
  prevDate?: string
  nextDate?: string
  placesById: Map<string, Tables<'places'>>
  onOpenItem: (item: PlanItem) => void
  onVote: (item: PlanItem) => void
  votingId: string | null
  isLast: boolean
}

/**
 * One day's section of the board, with the swipe-between-days gesture
 * (UX_REDESIGN.md Part 4) applied to its item list: a horizontal pan
 * previews with a translateX rubber-band, and a swipe past the threshold
 * scrolls to the next/previous day's sticky header. Vertical scrolling is
 * never intercepted (see useDaySwipe's axis lock) — see PlanBoard.tsx's
 * dayAnchorId/scrollToDay helpers for the anchor-jump mechanics and the
 * useDaySwipe module doc for the "why not a full paged carousel" judgment
 * call.
 */
function PlanDaySection({ date, dayItems, header, prevDate, nextDate, placesById, onOpenItem, onVote, votingId, isLast }: PlanDaySectionProps) {
  const swipe = useDaySwipe(
    () => nextDate && scrollToDay(nextDate),
    () => prevDate && scrollToDay(prevDate)
  )

  return (
    <div id={dayAnchorId(date)} className="relative scroll-mt-16">
      <div className="sticky top-0 z-20 -mx-4 px-4 py-1.5 bg-[var(--surface-page)]/95 backdrop-blur-sm">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {header.dayNumber ? `Day ${header.dayNumber}` : header.dayLabel}
          </span>
          <span className="text-xs text-[var(--text-muted)]">{header.label}</span>
        </div>
      </div>
      <div
        className="mt-2 space-y-2 stagger-list touch-pan-y"
        onTouchStart={swipe.onTouchStart}
        onTouchMove={swipe.onTouchMove}
        onTouchEnd={swipe.onTouchEnd}
        style={swipe.style}
      >
        {dayItems.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] pl-1">Nothing planned yet</p>
        ) : (
          dayItems.map((item) => (
            <div key={item.id} className="stagger-item">
              <PlanItemCard
                item={item}
                place={item.placeId ? placesById.get(item.placeId) : undefined}
                onOpen={onOpenItem}
                onVote={item.vote ? onVote : undefined}
                isVoting={votingId === item.id}
                myVoted={item.vote?.myVote.voted}
              />
            </div>
          ))
        )}
      </div>
      {!isLast && <div className="mt-3 border-b border-[var(--border-subtle)]" />}
    </div>
  )
}
