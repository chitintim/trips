import { useMemo, useState } from 'react'
import { Button, Card, Skeleton } from '../../../components/ui'
import {
  useBriefData,
  BriefCover,
  OrganizerMessageCard,
  CostBandCard,
  RsvpCard,
  WhosInRow,
  FaqCard,
} from '../../brief'
import { StatusModal, ConfirmationSettingsSheet } from '../../people'
import { usePlanItems } from '../../plan'
import { formatTime } from '../../timeline'
import { YourTurnStack } from './YourTurnStack'
import { AnnouncementsSection } from './AnnouncementsSection'
import { DecidedSoFarCard } from './DecidedSoFarCard'
import { BlockersStrip } from './BlockersStrip'
import { CountdownHero } from './CountdownHero'
import { NowNextCard } from './NowNextCard'
import { SettleStatusCard } from './SettleStatusCard'
import { RecentActivitySection } from './RecentActivitySection'
import { NextStepsCard } from './NextStepsCard'
import { StageSuggestionCard } from './StageSuggestionCard'
import { SetDatesFromWinnerCard } from './SetDatesFromWinnerCard'
import { TravelDetailsPromptCard } from './TravelDetailsPromptCard'
import { KeyBookingsCard } from './KeyBookingsCard'
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
  /** Organizer "invite people" affordance (Add participant sheet). */
  onInvite: () => void
}

/**
 * Today — the stage-aware home (UX_REDESIGN §1 + Part 2 layouts). One
 * scrollable action center per lifecycle stage, leading with "your turn",
 * absorbing the old Brief and Notes tabs, and hosting the organizer's
 * blockers strip + suggestion cards. Part 3's date-intelligence cards slot
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
  onInvite,
}: TodayTabProps) {
  const brief = useBriefData(trip.id)
  const [rsvpOpen, setRsvpOpen] = useState(false)
  const [briefSettingsOpen, setBriefSettingsOpen] = useState(false)

  if (brief.isLoading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton variant="card" height={160} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  // Organizer helper cards shared by the pre-trip layouts.
  const organizerCards = isOrganizer && (
    <>
      <SetDatesFromWinnerCard trip={trip} />
      <StageSuggestionCard trip={trip} effectiveStage={effectiveStage} />
      {(effectiveStage === 'gathering_interest' || effectiveStage === 'confirming_participants' || effectiveStage === 'booking_details') && (
        <NextStepsCard
          tripId={trip.id}
          onInvite={onInvite}
          onSetBrief={() => setBriefSettingsOpen(true)}
          onStartAccommodationVote={() => onNavigate('plan')}
        />
      )}
      <BlockersStrip trip={trip} onOpenConsole={onOpenConsole} />
    </>
  )

  const announcements = <AnnouncementsSection trip={trip} isOrganizer={isOrganizer} />
  const activity = <RecentActivitySection tripId={trip.id} />

  let layout: React.ReactNode
  switch (effectiveStage) {
    case 'gathering_interest':
    case 'confirming_participants':
      // Invitee / pre-commit layout: the brief IS the home.
      layout = (
        <>
          <BriefCover trip={trip} statusOverride={effectiveStage} />
          {organizerCards}
          <OrganizerMessageCard message={trip.confirmation_message} />
          <CostBandCard costBand={brief.costBand} fullCostLink={trip.full_cost_link} />
          <RsvpCard
            trip={trip}
            participants={brief.participants}
            myParticipant={brief.myParticipant}
            confirmedCount={brief.confirmedCount}
            onOpenStatusModal={() => setRsvpOpen(true)}
          />
          <WhosInRow participants={brief.participants} />
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          <FaqCard entries={brief.faqEntries} />
          {announcements}
          {activity}
        </>
      )
      break

    case 'booking_details':
      // Planning layout: your turn first, then group signal.
      layout = (
        <>
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          {organizerCards}
          {announcements}
          <DecidedSoFarCard trip={trip} onNavigate={onNavigate} />
          <KeyBookingsCard tripId={trip.id} />
          {activity}
        </>
      )
      break

    case 'booked_awaiting_departure':
      layout = (
        <>
          <CountdownHero trip={trip} />
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          <TravelDetailsPromptCard tripId={trip.id} />
          {organizerCards}
          <KeyBookingsCard tripId={trip.id} />
          <ChecklistNudgeCard onNavigate={onNavigate} />
          {announcements}
          {activity}
        </>
      )
      break

    case 'trip_ongoing':
      layout = (
        <>
          <NowNextCard trip={trip} />
          <TodayItemsList trip={trip} />
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={onQuickCapture}>
              📷 Scan a receipt
            </Button>
          </div>
          <SettleStatusCard trip={trip} onNavigate={onNavigate} compact />
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          {isOrganizer && <BlockersStrip trip={trip} onOpenConsole={onOpenConsole} />}
          {isOrganizer && <StageSuggestionCard trip={trip} effectiveStage={effectiveStage} />}
          {announcements}
          {activity}
        </>
      )
      break

    case 'trip_completed':
      layout = (
        <>
          <SettleStatusCard trip={trip} onNavigate={onNavigate} />
          <RecapTeaserCard onOpenRecap={onOpenRecap} />
          {isOrganizer && <StageSuggestionCard trip={trip} effectiveStage={effectiveStage} />}
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          {announcements}
          {activity}
        </>
      )
      break

    default:
      layout = (
        <>
          <YourTurnStack tripId={trip.id} onNavigate={onNavigate} />
          {announcements}
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

      <ConfirmationSettingsSheet
        isOpen={briefSettingsOpen}
        onClose={() => setBriefSettingsOpen(false)}
        tripId={trip.id}
        isOrganizer={isOrganizer}
      />
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

function ChecklistNudgeCard({ onNavigate }: { onNavigate: (spaceId: string) => void }) {
  return (
    <button
      onClick={() => onNavigate('people')}
      className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
    >
      <span className="text-sm text-[var(--text-primary)]">🎒 Check the packing & bring-list</span>
      <span className="text-sm text-[var(--text-muted)]">People →</span>
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
