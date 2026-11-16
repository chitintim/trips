import { useMemo, useState } from 'react'
import { EmptyState, useToast } from '../../../components/ui'
import { EmptyPlan } from '../../../components/ui/illustrations'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections } from '../../../lib/queries/usePlanning'
import { useAuth } from '../../../hooks/useAuth'
import { useBookings } from '../../../lib/queries/useBookings'
import { useTimeline, useMaterializeMilestone } from '../../../lib/queries/useTimeline'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { generateDateRange, formatDayHeader } from '../../timeline/lib/dayGrouping'
import { PlanItemCard } from './PlanItemCard'
import { ConsolidatedTravelRow } from './ConsolidatedTravelRow'
import { DerivedMilestoneRow } from './DerivedMilestoneRow'
import { CompanionSuggestionCard } from './CompanionSuggestionCard'
import { EventEditorSheet } from '../../timeline/components/EventEditorSheet'
import { groupPlanItemsByDate } from '../lib/planItems'
import { selectDaysItems } from '../lib/questionsModel'
import {
  groupTravelForDay,
  mergeDayEntries,
  type DayTravelGrouping,
  type TravelUserLike,
} from '../lib/travelGrouping'
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
  /** Gates organiser-only chrome on this lens (making a derived milestone a real event). */
  isOrganizer?: boolean
  onOpenItem: (item: PlanItem) => void
}

/**
 * The Days lens (proposal 5.1): what is happening, day by day from trip
 * start..end with sticky day headers. Questions (open or decided) live in the
 * Questions lens, not here; decided-but-unscheduled items sit in a small
 * "Not scheduled yet" group. There is no vote-casting on this lens.
 *
 * Layering rule (UX_REDESIGN.md "Systemic layering"): sticky day headers
 * use z-20 (well under the z-30 ceiling for in-content sticky elements)
 * and live inside this component's own scroll container, never escaping
 * into the app chrome's stacking context.
 */
export function PlanBoard({ trip, items, isOrganizer = false, onOpenItem }: PlanBoardProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: places } = usePlaces(trip.id)
  const { data: sections } = useSections(trip.id)
  const { data: bookings } = useBookings(trip.id)
  const { data: events } = useTimeline(trip.id)
  const { data: participants } = useParticipants(trip.id)
  const materializeMilestone = useMaterializeMilestone(trip.id)
  const logActivity = useTripActivityLog(trip.id)
  // A Set (not a single string) so two different rows materializing at once
  // each keep their own spinner/disabled state instead of the second click
  // clobbering the first row's in-flight indicator.
  const [materializingKeys, setMaterializingKeys] = useState<Set<string>>(() => new Set())
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<number>>(() => new Set())
  const [expandedDenseDays, setExpandedDenseDays] = useState<Set<string>>(() => loadExpandedDays(trip.id))
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(() => loadDismissedKeys(trip.id))
  const [acceptingSuggestion, setAcceptingSuggestion] = useState<CompanionSuggestion | null>(null)

  const placesById = useMemo(() => new Map((places || []).map((p) => [p.id, p])), [places])

  // What is happening: events, booked items and decided winners. Options of
  // open questions never show here.
  const days = useMemo(() => {
    const decidedIds = new Set((sections || []).filter((s) => s.status === 'completed').map((s) => s.id))
    return selectDaysItems(items, decidedIds)
  }, [items, sections])
  const shown = days.scheduled

  const dayDates = useMemo(() => {
    const eventDates = shown.filter((i) => i.date).map((i) => i.date as string)
    if (eventDates.length === 0) return generateDateRange(trip.start_date, trip.end_date)
    const minDate = [trip.start_date, ...eventDates].sort()[0]
    const maxDate = [trip.end_date, ...eventDates].sort().pop()!
    return generateDateRange(minDate, maxDate)
  }, [shown, trip.start_date, trip.end_date])


  const byDate = useMemo(() => groupPlanItemsByDate(shown), [shown])
  // Same-flight/same-minute travel consolidation (travelGrouping.ts):
  // display-level only — the per-person DB rows are untouched, each day
  // just swaps N near-identical "X arrives" cards for one grouped row.
  const eventsById = useMemo(() => new Map((events || []).map((e) => [e.id, e])), [events])
  const travelUsersById = useMemo<Map<string, TravelUserLike>>(
    () =>
      new Map(
        (participants || []).map((p) => [p.user_id, { full_name: p.user?.full_name ?? null, email: p.user?.email ?? null }])
      ),
    [participants]
  )
  const travelByDate = useMemo(() => {
    const map = new Map<string, DayTravelGrouping>()
    for (const [date, dateItems] of byDate) map.set(date, groupTravelForDay(dateItems, eventsById))
    return map
  }, [byDate, eventsById])

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

  const timeClashFlags = useMemo(() => detectTimeClashes(shown), [shown])
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
    // Guard against a second click on the same row while its own request is
    // still in flight (e.g. a slow connection) — a different row is fine,
    // each tracked independently in the Set above.
    if (materializingKeys.has(milestone.derivedKey)) return
    setMaterializingKeys((prev) => new Set(prev).add(milestone.derivedKey))
    try {
      await materializeMilestone.mutateAsync({
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
      setMaterializingKeys((prev) => {
        const next = new Set(prev)
        next.delete(milestone.derivedKey)
        return next
      })
    }
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


  // Milestones (arrival/departure/etc.) are system rows, not "plan items" —
  // an otherwise-empty plan still shows them rather than falling through to
  // the empty state, since they're always meaningful (every trip has an
  // arrival day).
  if (shown.length === 0 && days.notScheduled.length === 0 && milestones.length === 0) {
    return (
      <EmptyState
        icon={<EmptyPlan className="w-32 h-24 text-[var(--text-muted)]" />}
        title="Nothing planned."
        description="Events and decided plans show up here, day by day. Open questions are in the Questions tab."
      />
    )
  }

  return (
    <div className="relative space-y-4">
      {days.notScheduled.length > 0 && (
        <section aria-label={`Not scheduled yet (${days.notScheduled.length})`} className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Not scheduled yet ({days.notScheduled.length})</h3>
          {days.notScheduled.map((item) => (
            <PlanItemCard
              trip={trip}
              key={item.id}
              item={item}
              place={item.placeId ? placesById.get(item.placeId) : undefined}
              onOpen={onOpenItem}
              compact
            />
          ))}
        </section>
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
              isMaterializing={materializingKeys.has(span.derivedKey)}
              canMaterialize={isOrganizer}
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
            const grouping = travelByDate.get(date)
            const groupedIds = grouping?.groupedItemIds
            const entries = mergeDayEntries(
              groupedIds ? dayItems.filter((i) => !groupedIds.has(i.id)) : dayItems,
              grouping?.groups ?? []
            )
            return (
              <div key={date} className="space-y-2">
                {(milestonesByDate.get(date) || []).map((m) => (
                  <DerivedMilestoneRow
                    key={m.derivedKey}
                    milestone={m}
                    onMaterialize={handleMaterialize}
                    isMaterializing={materializingKeys.has(m.derivedKey)}
                    canMaterialize={isOrganizer}
                  />
                ))}
                {entries.map((entry) =>
                  entry.kind === 'group' ? (
                    <div key={entry.group.key} className="stagger-item">
                      <ConsolidatedTravelRow group={entry.group} usersById={travelUsersById} onOpenMember={onOpenItem} />
                    </div>
                  ) : (
                    <div key={entry.item.id} className="stagger-item">
                      <PlanItemCard
                        trip={trip}
                        item={entry.item}
                        place={entry.item.placeId ? placesById.get(entry.item.placeId) : undefined}
                        onOpen={onOpenItem}
                        outsideTripDates={isOutsideTripDates(entry.item, trip.start_date, trip.end_date)}
                        timeClash={clashedIds.has(entry.item.id)}
                        dense={dense && isDensifiableStage(entry.item.stage)}
                      />
                    </div>
                  )
                )}
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
                      trip={trip}
                      key={date}
                      date={date}
                      dayItems={byDate.get(date) || []}
                      milestones={milestonesByDate.get(date) || []}
                      header={formatDayHeader(date, trip.start_date, trip.end_date)}
                      prevDate={dayDates[globalIndex - 1]}
                      nextDate={dayDates[globalIndex + 1]}
                      placesById={placesById}
                      onOpenItem={onOpenItem}
                      isLast={globalIndex === dayDates.length - 1}
                      tripStartDate={trip.start_date}
                      tripEndDate={trip.end_date}
                      onMaterialize={handleMaterialize}
                      materializingKeys={materializingKeys}
                      canMaterialize={isOrganizer}
                      clashedIds={clashedIds}
                      today={today}
                      expanded={expandedDenseDays.has(date)}
                      onToggleExpand={() => toggleExpandedDenseDay(date)}
                      travelGrouping={travelByDate.get(date)}
                      travelUsersById={travelUsersById}
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
              trip={trip}
              key={date}
              date={date}
              dayItems={byDate.get(date) || []}
              milestones={milestonesByDate.get(date) || []}
              header={formatDayHeader(date, trip.start_date, trip.end_date)}
              prevDate={dayDates[i - 1]}
              nextDate={dayDates[i + 1]}
              placesById={placesById}
              onOpenItem={onOpenItem}
              isLast={i === dayDates.length - 1}
              tripStartDate={trip.start_date}
              tripEndDate={trip.end_date}
              onMaterialize={handleMaterialize}
              materializingKeys={materializingKeys}
              canMaterialize={isOrganizer}
              clashedIds={clashedIds}
              today={today}
              expanded={expandedDenseDays.has(date)}
              onToggleExpand={() => toggleExpandedDenseDay(date)}
              travelGrouping={travelByDate.get(date)}
              travelUsersById={travelUsersById}
            />
          ))}
        </div>
      )}


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


interface PlanDaySectionProps {
  trip: Trip
  date: string
  dayItems: PlanItem[]
  /** Date-derived system rows anchored to this exact day (span banners are rendered separately, once, by the caller). */
  milestones: DerivedMilestone[]
  header: { dayNumber: number | null; dayLabel: string; label: string }
  prevDate?: string
  nextDate?: string
  placesById: Map<string, Tables<'places'>>
  onOpenItem: (item: PlanItem) => void
  isLast: boolean
  tripStartDate: string
  tripEndDate: string
  onMaterialize: (milestone: DerivedMilestone) => void
  materializingKeys: Set<string>
  /** Organizer-only gate on DerivedMilestoneRow's "+ Make it an event" button (developer call: milestones are informative for everyone, materializing them is an organizer action). */
  canMaterialize: boolean
  clashedIds: Set<string>
  /** Today's date (YYYY-MM-DD), for density.ts's isPastDay/shouldDensifyDay. */
  today: string
  /** Whether this day's collapsed dense summary has been expanded (persisted in sessionStorage by the caller — see PlanBoard's expandedDenseDays state). */
  expanded: boolean
  onToggleExpand: () => void
  /** Same-flight/same-minute travel consolidation for this day (travelGrouping.ts) — undefined when the day has no travel-details items at all. */
  travelGrouping?: DayTravelGrouping
  /** user_id -> name/email lookup for the consolidated rows' traveller names. */
  travelUsersById: Map<string, TravelUserLike>
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
  trip,
  date,
  dayItems,
  milestones,
  header,
  prevDate,
  nextDate,
  placesById,
  onOpenItem,
  isLast,
  tripStartDate,
  tripEndDate,
  onMaterialize,
  materializingKeys,
  canMaterialize,
  clashedIds,
  today,
  expanded,
  onToggleExpand,
  travelGrouping,
  travelUsersById,
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
  const groupedTravelIds = travelGrouping?.groupedItemIds
  const attentionItems = dayItems.filter((i) => !isDensifiableStage(i.stage) && !groupedTravelIds?.has(i.id))
  // Includes grouped travel members so the collapsed summary line still
  // counts every underlying item ("8 items · 6 flights ..."), while the
  // expanded render below swaps the grouped ones for consolidated rows.
  const settledItems = dayItems.filter((i) => isDensifiableStage(i.stage))
  const settledEntries = mergeDayEntries(
    groupedTravelIds ? settledItems.filter((i) => !groupedTravelIds.has(i.id)) : settledItems,
    travelGrouping?.groups ?? []
  )
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
          <DerivedMilestoneRow
            key={m.derivedKey}
            milestone={m}
            onMaterialize={onMaterialize}
            isMaterializing={materializingKeys.has(m.derivedKey)}
            canMaterialize={canMaterialize}
          />
        ))}
        {dayItems.length === 0 && milestones.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] pl-1">Nothing planned.</p>
        ) : (
          <>
            {attentionItems.map((item) => (
              <div key={item.id} className="stagger-item">
                <PlanItemCard
                  trip={trip}
                  item={item}
                  place={item.placeId ? placesById.get(item.placeId) : undefined}
                  onOpen={onOpenItem}
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
                {settledEntries.map((entry) =>
                  entry.kind === 'group' ? (
                    <div key={entry.group.key} className="stagger-item">
                      <ConsolidatedTravelRow group={entry.group} usersById={travelUsersById} onOpenMember={onOpenItem} />
                    </div>
                  ) : (
                    <div key={entry.item.id} className="stagger-item">
                      <PlanItemCard
                        trip={trip}
                        item={entry.item}
                        place={entry.item.placeId ? placesById.get(entry.item.placeId) : undefined}
                        onOpen={onOpenItem}
                        outsideTripDates={isOutsideTripDates(entry.item, tripStartDate, tripEndDate)}
                        timeClash={clashedIds.has(entry.item.id)}
                        dense={dense}
                      />
                    </div>
                  )
                )}
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
