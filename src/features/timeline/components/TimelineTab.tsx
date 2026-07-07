import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Skeleton, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTimeline, useUpdateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useParticipants } from '../../../lib/queries/useTrip'
import { TimelineEventCard } from './TimelineEventCard'
import { EventEditorSheet } from './EventEditorSheet'
import {
  computeTimelineDateRange,
  groupEventsByDate,
  computeDefaultCollapsedDays,
  classifyDay,
  formatDayHeader,
  formatLocalDate,
  findNextUpEvent,
} from '../lib/dayGrouping'
import type { Trip, TimelineEvent } from '../../../types'

export interface TimelineTabProps {
  trip: Trip
}

/**
 * Trip timeline tab (plan §Timeline): day-grouped chronological events with
 * sticky day headers, per-category accents, smart default collapse (past
 * collapsed, today/future expanded), and a "next up" highlight while the
 * trip is ongoing. Organizers get full CRUD via EventEditorSheet.
 */
export function TimelineTab({ trip }: TimelineTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: events, isLoading } = useTimeline(trip.id)
  const { data: participants } = useParticipants(trip.id)
  const updateEvent = useUpdateTimelineEvent(trip.id)

  const [sheet, setSheet] = useState<{ event: TimelineEvent | null; defaultDate?: string } | null>(null)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const [hasInitializedCollapse, setHasInitializedCollapse] = useState(false)

  const myParticipant = (participants ?? []).find((p) => p.user_id === user?.id)
  const isOrganizer = myParticipant?.role === 'organizer' || trip.created_by === user?.id

  const today = formatLocalDate(new Date())
  const nowTime = new Date().toTimeString().slice(0, 5)

  const allDates = useMemo(
    () => computeTimelineDateRange(events ?? [], trip.start_date, trip.end_date),
    [events, trip.start_date, trip.end_date]
  )
  const eventsByDate = useMemo(() => groupEventsByDate(events ?? []), [events])
  const nextUpEvent = useMemo(
    () => (trip.status === 'trip_ongoing' ? findNextUpEvent(events ?? [], today, nowTime) : null),
    // nowTime intentionally excluded from deps — recomputing every render on
    // the minute isn't necessary; the tab re-renders on every query refetch anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, trip.status, today]
  )

  // Smart default collapse, computed once per mount after data loads.
  useEffect(() => {
    if (isLoading || hasInitializedCollapse || allDates.length === 0) return
    setCollapsedDays(computeDefaultCollapsedDays(allDates, today))
    setHasInitializedCollapse(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, hasInitializedCollapse, allDates.length])

  const toggleDay = (dateStr: string) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev)
      if (next.has(dateStr)) next.delete(dateStr)
      else next.add(dateStr)
      return next
    })
  }

  const handlePlacePicked = (event: TimelineEvent, place: { id: string; name: string }) => {
    updateEvent.mutate(
      { id: event.id, update: { place_id: place.id, location: place.name } },
      {
        onSuccess: () => showToast({ type: 'success', message: `Pinned "${place.name}"` }),
        onError: (err) => showToast({ type: 'error', message: 'Could not pin place', description: (err as Error).message }),
      }
    )
  }

  const openQuickCapture = () => {
    // Documented contract (plan §Timeline empty state): the shell listens
    // for this event to open its "+" quick-capture flow (scan receipt / add
    // expense / paste link / add event) so every empty state in the app can
    // invite the same fast path without importing the shell's internals.
    window.dispatchEvent(new CustomEvent('open-quick-capture'))
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton variant="card" height={56} />
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
      </div>
    )
  }

  const totalEvents = events?.length ?? 0

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Timeline</h2>
          {totalEvents > 0 && (
            <p className="text-sm text-[var(--text-muted)]">
              {totalEvents} event{totalEvents !== 1 ? 's' : ''} across {allDates.length} day{allDates.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        {isOrganizer && totalEvents > 0 && (
          <Button size="sm" onClick={() => setSheet({ event: null })}>
            + Add event
          </Button>
        )}
      </div>

      {totalEvents === 0 ? (
        <EmptyState
          icon="🗓️"
          title="Nothing on the itinerary yet"
          description={
            isOrganizer
              ? 'Add the first event, or paste a booking confirmation and let AI fill in the details.'
              : 'The organizer will start building the itinerary soon.'
          }
          action={
            isOrganizer ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setSheet({ event: null })}>+ Add event</Button>
                <Button variant="secondary" onClick={openQuickCapture}>
                  📋 Paste a booking
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {allDates.map((dateStr) => {
            const { dayLabel, label } = formatDayHeader(dateStr, trip.start_date, trip.end_date)
            const dayEvents = eventsByDate.get(dateStr) || []
            const isCollapsed = collapsedDays.has(dateStr)
            const { isToday } = classifyDay(dateStr, today)

            return (
              <div key={dateStr} className={isToday ? 'rounded-[var(--radius-lg)] ring-2 ring-accent-300' : ''}>
                <button
                  type="button"
                  onClick={() => toggleDay(dateStr)}
                  className={`sticky top-0 z-30 flex w-full items-center justify-between rounded-t-[var(--radius-lg)] px-4 py-2.5 transition-colors ${
                    isToday
                      ? 'bg-accent-50 hover:bg-accent-100 dark:bg-accent-950/60'
                      : 'border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--surface-sunken)]'
                  } ${isCollapsed ? 'rounded-b-[var(--radius-lg)]' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <svg
                      className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className={`font-semibold ${isToday ? 'text-accent-700 dark:text-accent-300' : 'text-[var(--text-primary)]'}`}>
                      {dayLabel}
                    </span>
                    <span className={`text-sm ${isToday ? 'text-accent-600 dark:text-accent-400' : 'text-[var(--text-muted)]'}`}>{label}</span>
                    {isToday && (
                      <span className="rounded-[var(--radius-full)] bg-accent-600 px-2 py-0.5 text-xs font-medium text-white">Today</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {dayEvents.length > 0 && (
                      <span className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                        {dayEvents.length}
                      </span>
                    )}
                    {isOrganizer && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSheet({ event: null, defaultDate: dateStr })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation()
                            setSheet({ event: null, defaultDate: dateStr })
                          }
                        }}
                        className="rounded px-1 text-[var(--text-muted)] hover:text-accent-600"
                        title="Add event to this day"
                        aria-label="Add event to this day"
                      >
                        +
                      </span>
                    )}
                  </div>
                </button>

                {!isToday && isCollapsed ? null : (
                  <div
                    className={`space-y-2 px-0 py-3 ${
                      isToday ? '' : 'rounded-b-[var(--radius-lg)] border-x border-b border-[var(--border-subtle)] px-4'
                    } ${isToday && !isCollapsed ? 'px-4' : ''}`}
                  >
                    {isCollapsed ? null : dayEvents.length === 0 ? (
                      <p className="py-2 text-center text-sm text-[var(--text-muted)]">No events planned</p>
                    ) : (
                      dayEvents.map((event) => (
                        <TimelineEventCard
                          key={event.id}
                          event={event}
                          tripId={trip.id}
                          isOrganizer={isOrganizer}
                          isNextUp={nextUpEvent?.id === event.id}
                          participants={participants ?? []}
                          onEdit={(e) => setSheet({ event: e })}
                          onDelete={(e) => setSheet({ event: e })}
                          onPlacePicked={handlePlacePicked}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {sheet && (
        <EventEditorSheet
          isOpen
          onClose={() => setSheet(null)}
          trip={trip}
          event={sheet.event}
          defaultDate={sheet.defaultDate}
        />
      )}
    </div>
  )
}
