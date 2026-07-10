import { useMemo, useState } from 'react'
import { Button, Badge, Deadline, EmptyState, Modal, useToast, SelectionAvatars } from '../../../components/ui'
import { EmptyPlan } from '../../../components/ui/illustrations'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections, useCreateSection, useVotes } from '../../../lib/queries/usePlanning'
import { useAuth } from '../../../hooks/useAuth'
import { useToggleVote } from '../../../lib/queries/usePlanning'
import { useBookings } from '../../../lib/queries/useBookings'
import { useTimeline, useCreateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { generateDateRange, formatDayHeader } from '../../timeline/lib/dayGrouping'
import { MatrixView } from '../../decisions/components/MatrixView'
import { SectionEditorSheet } from '../../decisions/components/SectionEditorSheet'
import { getDecisionShape, sectionHasCatalogPricing } from '../../decisions/lib/decisionShapes'
import { computeQuestionState } from '../lib/responseState'
import { PlanItemCard } from './PlanItemCard'
import { DerivedMilestoneRow } from './DerivedMilestoneRow'
import { CompanionSuggestionCard } from './CompanionSuggestionCard'
import { OrderFormSheet } from './OrderFormSheet'
import { ConsolidatedOrdersSheet } from './ConsolidatedOrdersSheet'
import { EventEditorSheet } from '../../timeline/components/EventEditorSheet'
import { groupPlanItemsByDate, groupUndatedBySection } from '../lib/planItems'
import { useDaySwipe } from '../lib/useDaySwipe'
import {
  deriveMilestones,
  groupDerivedMilestones,
  materializedDerivedKeys,
  MATERIALIZE_METADATA_FIELD,
  type DerivedMilestone,
} from '../lib/derivedMilestones'
import {
  isOutsideTripDates,
  shouldSkipDayGroupingChrome,
  isLongTrip,
  chunkIntoWeeks,
  type WeekChunk,
} from '../lib/calendarEdgeCases'
import { shouldDensifyDay, isDensifiableStage, summarizeDayItems, loadExpandedDays, saveExpandedDays } from '../lib/density'
import {
  suggestTransfers,
  suggestAccommodationEvents,
  detectTimeClashes,
  clashedItemIds,
  loadDismissedKeys,
  dismissSuggestion,
  type CompanionSuggestion,
} from '../lib/companions'
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
  const { showToast } = useToast()
  const { data: places } = usePlaces(trip.id)
  const { data: sections } = useSections(trip.id)
  const { data: bookings } = useBookings(trip.id)
  const { data: events } = useTimeline(trip.id)
  const { data: votes } = useVotes(trip.id)
  const { data: participants } = useParticipants(trip.id)
  const toggleVote = useToggleVote(trip.id)
  const createSection = useCreateSection(trip.id)
  const createEvent = useCreateTimelineEvent(trip.id)
  const logActivity = useTripActivityLog(trip.id)
  const [votingId, setVotingId] = useState<string | null>(null)
  const [creatingStarters, setCreatingStarters] = useState(false)
  const [matrixSectionId, setMatrixSectionId] = useState<string | null>(null)
  const [sectionSettingsId, setSectionSettingsId] = useState<string | null>(null)
  const [orderFormSectionId, setOrderFormSectionId] = useState<string | null>(null)
  const [consolidatedOrdersSectionId, setConsolidatedOrdersSectionId] = useState<string | null>(null)
  const [expandedPicksSectionIds, setExpandedPicksSectionIds] = useState<Set<string>>(() => new Set())
  const [materializingKey, setMaterializingKey] = useState<string | null>(null)
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<number>>(() => new Set())
  const [expandedDenseDays, setExpandedDenseDays] = useState<Set<string>>(() => loadExpandedDays(trip.id))
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(() => loadDismissedKeys(trip.id))
  const [acceptingSuggestion, setAcceptingSuggestion] = useState<CompanionSuggestion | null>(null)

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

  // Date-derived presets (UX_REDESIGN.md Part 3): rendered, never stored.
  // Recomputed from trip + bookings + already-materialized events every
  // render — no separate query, no cache to invalidate.
  const milestones = useMemo(
    () => deriveMilestones({ trip, bookings: bookings || [], events: events || [] }),
    [trip, bookings, events]
  )
  const { byDate: milestonesByDate, spans: milestoneSpans } = useMemo(() => groupDerivedMilestones(milestones), [milestones])

  // Companion suggestions (UX_REDESIGN.md Part 3 "Ambient AI" #3): a
  // conservative rule engine over data already loaded here — no AI calls.
  // Flight/accommodation times for the transfer-window rule come from
  // whichever item is linked to that booking (its own event or option),
  // when one exists.
  const flightTimesByBookingId = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const item of items) {
      if (item.bookingId) map.set(item.bookingId, item.startTime)
    }
    return map
  }, [items])

  const materializedKeys = useMemo(() => materializedDerivedKeys(events || []), [events])

  const companionSuggestions = useMemo(() => {
    const transferSuggestions = suggestTransfers(bookings || [], items, flightTimesByBookingId)
    const accommodationSuggestions = suggestAccommodationEvents(bookings || [], items, materializedKeys, trip.end_date)
    return [...transferSuggestions, ...accommodationSuggestions].filter((s) => !dismissedSuggestionKeys.has(s.key))
  }, [bookings, items, flightTimesByBookingId, materializedKeys, trip.end_date, dismissedSuggestionKeys])

  const timeClashFlags = useMemo(() => detectTimeClashes(items), [items])
  const clashedIds = useMemo(() => clashedItemIds(timeClashFlags), [timeClashFlags])

  const handleDismissSuggestion = (suggestion: CompanionSuggestion) => {
    dismissSuggestion(trip.id, suggestion.key)
    setDismissedSuggestionKeys((prev) => new Set(prev).add(suggestion.key))
  }

  const skipDayChrome = shouldSkipDayGroupingChrome(dayDates)
  const longTrip = isLongTrip(dayDates)
  const weekChunks = useMemo(
    () => (longTrip ? chunkIntoWeeks(dayDates, byDate) : []),
    [longTrip, dayDates, byDate]
  )

  const handleMaterialize = async (milestone: DerivedMilestone) => {
    if (!user) return
    setMaterializingKey(milestone.derivedKey)
    try {
      await createEvent.mutateAsync({
        trip_id: trip.id,
        created_by: user.id,
        title: milestone.title,
        category: milestone.kind === 'flight_day' ? 'flight' : milestone.kind === 'accommodation_span' ? 'accommodation' : 'other',
        event_date: milestone.date,
        all_day: true,
        metadata: { [MATERIALIZE_METADATA_FIELD]: milestone.derivedKey },
      })
      logActivity({
        verb: 'milestone_materialized',
        entity: { type: 'timeline_event', label: milestone.title },
        metadata: { derived_key: milestone.derivedKey },
      })
      showToast({ type: 'success', message: `"${milestone.title}" is now a real event` })
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create this event', description: (err as Error).message })
    } finally {
      setMaterializingKey(null)
    }
  }

  // "Who picked what" expansion (UX_REDESIGN.md Part 5 + the legacy-data
  // migration): personal-order questions collapse to one summary line in
  // the tray; this reveals a per-option avatar stack of who's committed —
  // the same mechanism the new order-form questions use, auto-presented for
  // pre-v3 sections too since they're now decision_shape 'personal'.
  const togglePicksExpanded = (sectionId: string) => {
    setExpandedPicksSectionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const toggleWeekCollapse = (index: number) => {
    setCollapsedWeeks((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Display density (UPGRADE_MASTER_PLAN.md §13 build brief, no AI): busy
  // or past days collapse their decided/booked items behind a summary line
  // by default. `today` is computed once per render rather than per day —
  // cheap and keeps every day's density check consistent within one paint.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const toggleExpandedDenseDay = (date: string) => {
    setExpandedDenseDays((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      saveExpandedDays(trip.id, next)
      return next
    })
  }

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

  // Milestones (arrival/departure/etc.) are system rows, not "plan items" —
  // an otherwise-empty plan still shows them rather than falling through to
  // the empty state, since they're always meaningful (every trip has an
  // arrival day).
  if (items.length === 0 && milestones.length === 0) {
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
            const isPersonalOrder = section ? getDecisionShape(section.metadata) === 'personal' : false
            // Catalog-priced sections ("order form" style, e.g. ski rental
            // with per-day rates) read as "ordered"; pre-v3 legacy sections
            // stamped decision_shape 'personal' by the migration carry no
            // pricing at all and read as plain picks ("have picked") — same
            // underlying mechanism (selections), different wording.
            const hasCatalogPricing = section ? sectionHasCatalogPricing(section.options) : false
            const questionState = section
              ? computeQuestionState(section, votes || [], (participants || []).length, user?.id ?? null, trip.base_currency)
              : null
            const optionsWithPicks = section ? section.options.filter((o) => o.selections.length > 0) : []
            const picksExpanded = section ? expandedPicksSectionIds.has(section.id) : false
            // Questions, not sections (UX_REDESIGN.md Part 4 "Decisions:
            // questions, not sections"): the section's TITLE renders as the
            // question itself ("Where are we staying?"), with a plain
            // "N options · closes <date>" meta line -- no section_type
            // badge/chrome, no uppercase label treatment. Sections remain
            // the storage grouping only.
            return (
              <div key={sectionId ?? 'none'} className="space-y-2">
                {section && (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-medium text-[var(--text-primary)]">{section.title}</h4>
                        {questionState && (
                          <Badge variant={questionState.state === 'done' ? 'success' : 'warning'} size="sm">
                            {questionState.label}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <p className="text-xs text-[var(--text-muted)]">
                          {isPersonalOrder
                            ? `${questionState?.respondedCount ?? 0} of ${questionState?.totalParticipants ?? 0} ${hasCatalogPricing ? 'ordered' : 'have picked'}`
                            : `${section.options.length} option${section.options.length === 1 ? '' : 's'}`}
                        </p>
                        {section.vote_deadline && <Deadline date={section.vote_deadline} kind="vote" compact size="sm" />}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isMatrix && (
                        <Button variant="ghost" size="sm" onClick={() => setMatrixSectionId(section.id)}>
                          Grid view
                        </Button>
                      )}
                      {/* Poll settings (organizer-only, mirrors delete's
                          isOrganizer gate): wires the previously-unreachable
                          SectionEditorSheet (voting method/deadline/quorum/
                          decision shape) into the live tray. */}
                      {isOrganizer && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSectionSettingsId(section.id)}
                          aria-label={`Poll settings for ${section.title}`}
                          title="Poll settings"
                        >
                          ⚙️
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {isPersonalOrder && section ? (
                  // Personal-order (shape 2) questions collapse to one line —
                  // no per-catalog-item cards here (UX_REDESIGN.md Part 5's
                  // "Plan tray question rows collapse to one line each");
                  // full editing happens in the order form itself. "Who
                  // picked what" is a lightweight read-only expansion right
                  // here, reusing SelectionAvatars — this is what makes
                  // legacy multi-select sections (ski rental etc.) read like
                  // the new order-form questions with zero migration beyond
                  // the decision_shape stamp.
                  <div className="space-y-2">
                    <div className="flex gap-2 flex-wrap">
                      <Button variant="secondary" size="sm" onClick={() => setOrderFormSectionId(section.id)}>
                        {questionState?.state === 'done' ? 'Edit your order' : 'Fill in your order'}
                      </Button>
                      {isOrganizer && (
                        <Button variant="outline" size="sm" onClick={() => setConsolidatedOrdersSectionId(section.id)}>
                          View orders
                        </Button>
                      )}
                      {optionsWithPicks.length > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => togglePicksExpanded(section.id)}>
                          {picksExpanded ? 'Hide who picked ▲' : 'Who picked what ▾'}
                        </Button>
                      )}
                    </div>
                    {picksExpanded && (
                      <div className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5">
                        {optionsWithPicks.map((option) => (
                          <div key={option.id} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
                              {option.title}
                              {option.status === 'booked' && (
                                <Badge variant="success" size="sm" className="ml-1.5">
                                  🧾 Booked
                                </Badge>
                              )}
                            </span>
                            <SelectionAvatars
                              selections={option.selections.map((s) => ({
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
                              }))}
                              maxAvatars={4}
                              size="sm"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
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
                )}
                <ScheduleWinnerAffordance items={sectionItems} onScheduleIt={onScheduleIt} />
              </div>
            )
          })}
        </div>
      )}

      {/* Span banners (multi-day accommodation etc.) render ONCE, above the
          day list, rather than being repeated into every covered day
          (calendar edge case #3, UX_REDESIGN.md Part 3). */}
      {milestoneSpans.length > 0 && (
        <div className="space-y-1.5">
          {milestoneSpans.map((span) => (
            <DerivedMilestoneRow
              key={span.derivedKey}
              milestone={span}
              onMaterialize={handleMaterialize}
              isMaterializing={materializingKey === span.derivedKey}
            />
          ))}
        </div>
      )}

      {/* Companion suggestions (UX_REDESIGN.md Part 3 "Ambient AI" #3):
          dismissible cards, distinct from the muted derived-milestone rows
          above — these are opinions ("you might want this"), not facts. */}
      {companionSuggestions.length > 0 && (
        <div className="space-y-1.5">
          {companionSuggestions.map((s) => (
            <CompanionSuggestionCard
              key={s.key}
              suggestion={s}
              onAccept={setAcceptingSuggestion}
              onDismiss={handleDismissSuggestion}
            />
          ))}
        </div>
      )}

      {/* 1-day trips skip day-grouping chrome entirely (calendar edge case
          #5): a single flat list of the day's items/milestones with no
          "Day 1" header, sticky bar, or divider machinery. */}
      {skipDayChrome ? (
        <div className="space-y-2 stagger-list">
          {dayDates.map((date) => {
            const dayItems = byDate.get(date) || []
            const dense = shouldDensifyDay(dayItems.length, date, today)
            return (
              <div key={date} className="space-y-2">
                {(milestonesByDate.get(date) || []).map((m) => (
                  <DerivedMilestoneRow
                    key={m.derivedKey}
                    milestone={m}
                    onMaterialize={handleMaterialize}
                    isMaterializing={materializingKey === m.derivedKey}
                  />
                ))}
                {dayItems.map((item) => (
                  <div key={item.id} className="stagger-item">
                    <PlanItemCard
                      item={item}
                      place={item.placeId ? placesById.get(item.placeId) : undefined}
                      onOpen={onOpenItem}
                      onVote={item.vote ? handleVote : undefined}
                      isVoting={votingId === item.id}
                      myVoted={item.vote?.myVote.voted}
                      outsideTripDates={isOutsideTripDates(item, trip.start_date, trip.end_date)}
                      timeClash={clashedIds.has(item.id)}
                      dense={dense && isDensifiableStage(item.stage)}
                    />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      ) : longTrip ? (
        <div className="space-y-3">
          {weekChunks.map((chunk, i) =>
            chunk.isEmpty ? (
              <CollapsedWeekRow
                key={chunk.start}
                chunk={chunk}
                collapsed={!collapsedWeeks.has(i)}
                onToggle={() => toggleWeekCollapse(i)}
              />
            ) : (
              <div key={chunk.start} className="space-y-3">
                {chunk.dates.map((date, j) => {
                  const globalIndex = i * 7 + j
                  return (
                    <PlanDaySection
                      key={date}
                      date={date}
                      dayItems={byDate.get(date) || []}
                      milestones={milestonesByDate.get(date) || []}
                      header={formatDayHeader(date, trip.start_date, trip.end_date)}
                      prevDate={dayDates[globalIndex - 1]}
                      nextDate={dayDates[globalIndex + 1]}
                      placesById={placesById}
                      onOpenItem={onOpenItem}
                      onVote={handleVote}
                      votingId={votingId}
                      isLast={globalIndex === dayDates.length - 1}
                      tripStartDate={trip.start_date}
                      tripEndDate={trip.end_date}
                      onMaterialize={handleMaterialize}
                      materializingKey={materializingKey}
                      clashedIds={clashedIds}
                      today={today}
                      expanded={expandedDenseDays.has(date)}
                      onToggleExpand={() => toggleExpandedDenseDay(date)}
                    />
                  )
                })}
              </div>
            )
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {dayDates.map((date, i) => (
            <PlanDaySection
              key={date}
              date={date}
              dayItems={byDate.get(date) || []}
              milestones={milestonesByDate.get(date) || []}
              header={formatDayHeader(date, trip.start_date, trip.end_date)}
              prevDate={dayDates[i - 1]}
              nextDate={dayDates[i + 1]}
              placesById={placesById}
              onOpenItem={onOpenItem}
              onVote={handleVote}
              votingId={votingId}
              isLast={i === dayDates.length - 1}
              tripStartDate={trip.start_date}
              tripEndDate={trip.end_date}
              onMaterialize={handleMaterialize}
              materializingKey={materializingKey}
              clashedIds={clashedIds}
              today={today}
              expanded={expandedDenseDays.has(date)}
              onToggleExpand={() => toggleExpandedDenseDay(date)}
            />
          ))}
        </div>
      )}

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

      {/* Poll settings (UX_REDESIGN.md Part 5 / the vote-shape editing gap):
          wires the previously-unreachable SectionEditorSheet in with the
          real section record — voting method, deadline, quorum, decision
          shape are all editable from here now. */}
      <SectionEditorSheet
        isOpen={!!sectionSettingsId}
        onClose={() => setSectionSettingsId(null)}
        tripId={trip.id}
        section={(sections || []).find((s) => s.id === sectionSettingsId) ?? null}
      />

      {/* Personal order form (UX_REDESIGN.md Part 5, shape 2): the "Fill in
          your order"/"Edit your order" affordance above opens this instead
          of a vote UI — catalog items, dates, quantities, live total. */}
      {orderFormSectionId &&
        (() => {
          const orderSection = (sections || []).find((s) => s.id === orderFormSectionId)
          if (!orderSection) return null
          return (
            <OrderFormSheet
              isOpen
              onClose={() => setOrderFormSectionId(null)}
              trip={trip}
              section={orderSection}
              participants={participants || []}
            />
          )
        })()}

      {/* Organizer's consolidated orders matrix + "Copy order sheet". */}
      {consolidatedOrdersSectionId &&
        (() => {
          const orderSection = (sections || []).find((s) => s.id === consolidatedOrdersSectionId)
          if (!orderSection) return null
          return (
            <ConsolidatedOrdersSheet
              isOpen
              onClose={() => setConsolidatedOrdersSectionId(null)}
              section={orderSection}
              participants={participants || []}
              fallbackCurrency={trip.base_currency}
            />
          )
        })()}

      {/* Companion suggestion "accept" (UX_REDESIGN.md Part 3 "Ambient AI"
          #3): opens the same create-event sheet everything else uses,
          prefilled from the suggestion, so the organizer still reviews/
          edits before it's saved — never a silent write. */}
      <EventEditorSheet
        isOpen={!!acceptingSuggestion}
        onClose={() => {
          // Whether saved or cancelled, the suggestion has been acted on —
          // treat it like a dismissal so it doesn't linger (if the event
          // was actually created, the underlying data change also makes
          // the suggestion's own "not already present" condition false on
          // next compute; this dismissal is the fast-path for the cancel
          // case, where nothing changed).
          if (acceptingSuggestion) handleDismissSuggestion(acceptingSuggestion)
          setAcceptingSuggestion(null)
        }}
        trip={trip}
        event={null}
        defaultDate={acceptingSuggestion?.prefill.event_date}
        defaults={
          acceptingSuggestion
            ? {
                title: acceptingSuggestion.prefill.title,
                category: acceptingSuggestion.prefill.category,
                startTime: acceptingSuggestion.prefill.start_time,
              }
            : undefined
        }
      />
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
  /** Date-derived system rows anchored to this exact day (span banners are rendered separately, once, by the caller). */
  milestones: DerivedMilestone[]
  header: { dayNumber: number | null; dayLabel: string; label: string }
  prevDate?: string
  nextDate?: string
  placesById: Map<string, Tables<'places'>>
  onOpenItem: (item: PlanItem) => void
  onVote: (item: PlanItem) => void
  votingId: string | null
  isLast: boolean
  tripStartDate: string
  tripEndDate: string
  onMaterialize: (milestone: DerivedMilestone) => void
  materializingKey: string | null
  clashedIds: Set<string>
  /** Today's date (YYYY-MM-DD), for density.ts's isPastDay/shouldDensifyDay. */
  today: string
  /** Whether this day's collapsed dense summary has been expanded (persisted in sessionStorage by the caller — see PlanBoard's expandedDenseDays state). */
  expanded: boolean
  onToggleExpand: () => void
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
function PlanDaySection({
  date,
  dayItems,
  milestones,
  header,
  prevDate,
  nextDate,
  placesById,
  onOpenItem,
  onVote,
  votingId,
  isLast,
  tripStartDate,
  tripEndDate,
  onMaterialize,
  materializingKey,
  clashedIds,
  today,
  expanded,
  onToggleExpand,
}: PlanDaySectionProps) {
  const swipe = useDaySwipe(
    () => nextDate && scrollToDay(nextDate),
    () => prevDate && scrollToDay(prevDate)
  )

  // Display density (UPGRADE_MASTER_PLAN.md §13 build brief, no AI):
  // decided/booked items on a busy (>4 items) or already-past day collapse
  // behind a one-line summary by default. Proposals/ideas always render as
  // full cards — they still need the reviewer's attention — so they're
  // pulled out first and never counted into the collapsed summary.
  const dense = shouldDensifyDay(dayItems.length, date, today)
  const attentionItems = dayItems.filter((i) => !isDensifiableStage(i.stage))
  const settledItems = dayItems.filter((i) => isDensifiableStage(i.stage))
  const collapsed = dense && !expanded && settledItems.length > 0

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
        {milestones.map((m) => (
          <DerivedMilestoneRow key={m.derivedKey} milestone={m} onMaterialize={onMaterialize} isMaterializing={materializingKey === m.derivedKey} />
        ))}
        {dayItems.length === 0 && milestones.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] pl-1">Nothing planned yet</p>
        ) : (
          <>
            {attentionItems.map((item) => (
              <div key={item.id} className="stagger-item">
                <PlanItemCard
                  item={item}
                  place={item.placeId ? placesById.get(item.placeId) : undefined}
                  onOpen={onOpenItem}
                  onVote={item.vote ? onVote : undefined}
                  isVoting={votingId === item.id}
                  myVoted={item.vote?.myVote.voted}
                  outsideTripDates={isOutsideTripDates(item, tripStartDate, tripEndDate)}
                  timeClash={clashedIds.has(item.id)}
                />
              </div>
            ))}

            {collapsed ? (
              <button
                type="button"
                onClick={onToggleExpand}
                className="w-full flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-default)]"
              >
                <span>{summarizeDayItems(settledItems)}</span>
                <span aria-hidden="true">▾ Show</span>
              </button>
            ) : (
              <>
                {settledItems.map((item) => (
                  <div key={item.id} className="stagger-item">
                    <PlanItemCard
                      item={item}
                      place={item.placeId ? placesById.get(item.placeId) : undefined}
                      onOpen={onOpenItem}
                      onVote={item.vote ? onVote : undefined}
                      isVoting={votingId === item.id}
                      myVoted={item.vote?.myVote.voted}
                      outsideTripDates={isOutsideTripDates(item, tripStartDate, tripEndDate)}
                      timeClash={clashedIds.has(item.id)}
                      dense={dense}
                    />
                  </div>
                ))}
                {dense && settledItems.length > 0 && (
                  <button
                    type="button"
                    onClick={onToggleExpand}
                    className="w-full text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] px-1 py-1"
                  >
                    ▲ Show less
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
      {!isLast && <div className="mt-3 border-b border-[var(--border-subtle)]" />}
    </div>
  )
}

/**
 * A fully-empty week collapsed behind an expander (calendar edge case #5,
 * long trips >14 days): shows the date span and a one-tap expand instead of
 * seven blank "Nothing planned yet" day rows.
 */
function CollapsedWeekRow({ chunk, collapsed, onToggle }: { chunk: WeekChunk; collapsed: boolean; onToggle: () => void }) {
  if (!collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] px-1 py-1"
      >
        ▲ Collapse {chunk.dates.length} empty day{chunk.dates.length === 1 ? '' : 's'}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-muted)] hover:border-[var(--border-default)]"
    >
      <span>
        {chunk.dates.length} day{chunk.dates.length === 1 ? '' : 's'} — nothing planned yet
      </span>
      <span aria-hidden="true">▾ Show</span>
    </button>
  )
}
