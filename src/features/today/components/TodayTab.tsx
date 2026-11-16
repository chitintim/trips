import { useMemo, useState } from 'react'
import { Button, Card, Skeleton } from '../../../components/ui'
import { useBriefData, BriefCover, OrganizerMessageCard, WhosInRow } from '../../brief'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { StatusModal } from '../../people'
import { usePlanItems } from '../../plan'
import { formatTime } from '../../timeline'
import { AnnouncementsSection } from './AnnouncementsSection'
import { YourCostCard } from './YourCostCard'
import { CountdownHero } from './CountdownHero'
import { TripProgressStrip } from './TripProgressStrip'
import { NowNextCard } from './NowNextCard'
import { SettleStatusCard } from './SettleStatusCard'
import { RecentActivitySection } from './RecentActivitySection'
import { StageSuggestionCard } from './StageSuggestionCard'
import { SetDatesFromWinnerCard } from './SetDatesFromWinnerCard'
import { KeyBookingsCard } from './KeyBookingsCard'
import { YourTodosCard } from './YourTodosCard'
import { OrganiserSummaryCard } from './OrganiserSummaryCard'
import { CapacityCard } from './CapacityCard'
import type { Trip, TripStatus } from '../../../types'

export interface TodayTabProps {
  trip: Trip
  /** effectiveTripStage(trip) — the shell computes it once and passes it down. */
  effectiveStage: TripStatus
  isOrganizer: boolean
  onNavigate: (spaceId: string) => void
  onOpenConsole: () => void
  onOpenRecap: () => void
  onQuickCapture: () => void
  /** Opens the Actions sheet (trip to-dos + bring list); pass 'bring' to land on the packing segment. */
  onOpenActions: (segment?: 'actions' | 'bring') => void
}

/**
 * Today — the stage-aware home (UX_REDESIGN §1 + Part 2 layouts). One
 * scrollable action center per lifecycle stage, leading with "your turn",
 * absorbing the old Brief and Notes tabs, and hosting the organizer's
 * organiser summary + suggestion cards. Part 3's date-intelligence cards slot
 * into the same stack (each layout is just an ordered list of sections).
 */
export function TodayTab({
  trip,
  effectiveStage,
  isOrganizer,
  onNavigate,
  onOpenConsole,
  onOpenRecap,
  onQuickCapture,
  onOpenActions,
}: TodayTabProps) {
  const brief = useBriefData(trip.id)
  const [rsvpOpen, setRsvpOpen] = useState(false)
  const { canManageTrip } = useTripPermissions(trip)
  const organiser = isOrganizer || canManageTrip

  if (brief.isLoading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton variant="card" height={160} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  const todos = <YourTodosCard tripId={trip.id} onOpenAll={() => onOpenActions('actions')} />
  const yourCost = <YourCostCard trip={trip} />
  const announcements = <AnnouncementsSection trip={trip} isOrganizer={organiser} />
  const activity = <RecentActivitySection tripId={trip.id} />
  // Organiser-only: the summary, plus the two prompts that have no to-do yet
  // (move the stage forward, set dates from the winning range).
  const organiserCards = organiser && (
    <>
      <OrganiserSummaryCard tripId={trip.id} onOpenConsole={onOpenConsole} />
      <SetDatesFromWinnerCard trip={trip} />
      <StageSuggestionCard trip={trip} effectiveStage={effectiveStage} />
    </>
  )

  let layout: React.ReactNode
  switch (effectiveStage) {
    case 'gathering_interest':
    case 'confirming_participants':
      layout = (
        <>
          <BriefCover trip={trip} statusOverride={effectiveStage} />
          {todos}
          {yourCost}
          <OrganizerMessageCard message={trip.confirmation_message} />
          <CapacityCard
            trip={trip}
            participants={brief.participants}
            myParticipant={brief.myParticipant}
            confirmedCount={brief.confirmedCount}
            onOpenStatusModal={() => setRsvpOpen(true)}
          />
          <WhosInRow participants={brief.participants} />
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
      break

    case 'booking_details':
      layout = (
        <>
          {todos}
          {yourCost}
          <KeyBookingsCard tripId={trip.id} />
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
      break

    case 'booked_awaiting_departure':
      layout = (
        <>
          <CountdownHero trip={trip} />
          {todos}
          {yourCost}
          <KeyBookingsCard tripId={trip.id} />
          <ChecklistNudgeCard onOpen={() => onOpenActions('bring')} />
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
      break

    case 'trip_ongoing':
      layout = (
        <>
          <TripProgressStrip trip={trip} />
          {todos}
          {yourCost}
          <NowNextCard trip={trip} />
          <TodayItemsList trip={trip} />
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={onQuickCapture}>
              📷 Scan a receipt
            </Button>
          </div>
          <SettleStatusCard trip={trip} onNavigate={onNavigate} />
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
      break

    case 'trip_completed':
      layout = (
        <>
          {todos}
          {yourCost}
          <RecapTeaserCard onOpenRecap={onOpenRecap} />
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
      break

    default:
      layout = (
        <>
          {todos}
          {yourCost}
          {announcements}
          {organiserCards}
          {activity}
        </>
      )
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {layout}

      {brief.myParticipant && (
        <StatusModal
          isOpen={rsvpOpen}
          onClose={() => setRsvpOpen(false)}
          tripId={trip.id}
          participant={brief.myParticipant}
          participants={brief.participants}
          capacityLimit={trip.capacity_limit}
          confirmedCount={brief.confirmedCount}
        />
      )}
    </div>
  )
}

/** Small "today's items" list under the NOW/NEXT card (ongoing layout). */
function TodayItemsList({ trip }: { trip: Trip }) {
  const { items } = usePlanItems(trip.id)
  const today = useMemo(() => {
    const d = new Date()
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return items
      .filter((i) => i.date === iso && (i.stage === 'decided' || i.stage === 'booked'))
      .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))
  }, [items])

  if (today.length === 0) return null
  return (
    <Card>
      <Card.Content className="space-y-1.5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Today's plan</h3>
        <ul className="space-y-1">
          {today.map((item) => (
            <li key={item.id} className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
              <span className="text-xs text-[var(--text-muted)] w-14 shrink-0">
                {item.startTime ? formatTime(item.startTime) : '—'}
              </span>
              <span className="truncate">{item.title}</span>
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  )
}

// v2.2: the bring list lives in the Actions sheet ('bring' segment), not
// under People — the nudge opens the sheet there directly.
function ChecklistNudgeCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
    >
      <span className="text-sm text-[var(--text-primary)]">🎒 Check the packing & bring-list</span>
      <span className="text-sm text-[var(--text-muted)]">To-dos →</span>
    </button>
  )
}

function RecapTeaserCard({ onOpenRecap }: { onOpenRecap: () => void }) {
  return (
    <Card hoverable clickable onClick={onOpenRecap}>
      <Card.Content className="flex items-center justify-between gap-3 py-4">
        <div>
          <h3 className="font-semibold text-[var(--text-primary)]">🎉 The recap is ready</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">Totals, superlatives and the story of the trip.</p>
        </div>
        <span aria-hidden="true" className="text-[var(--text-muted)]">
          →
        </span>
      </Card.Content>
    </Card>
  )
}
