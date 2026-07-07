import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Spinner, EmptyState, Skeleton, Modal } from '../components/ui'
import { CreateTripModal, AddParticipantModal } from '../components'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { AppShell, StageRail, NeedsAttentionStrip } from '../components/layout'
import type { AppShellTabItem } from '../components/layout'
import { getTripAccentStyle } from '../components/layout/tripAccent'
import { useTrip, useParticipants, useCurrentUserRow } from '../lib/queries/useTrip'
import { useTripRealtime } from '../lib/queries/useTripRealtime'
import { useNeedsAttention } from '../lib/queries/useNeedsAttention'
import { useExpenses } from '../lib/queries/useExpenses'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../lib/queries/queryKeys'
import { getTripStatusLabel } from '../lib/tripStatus'
import { effectiveTripStage } from '../lib/tripStage'

import { todayTabConfig } from '../features/today'
import { planTabConfig, AddToPlanSheet } from '../features/plan'
import { peopleTabConfig, StatusModal, TravelDetailsSheet } from '../features/people'
import { OPEN_QUICK_CAPTURE_EVENT } from '../features/timeline'
import { OrganizerConsole } from '../features/organizer'
import { retroConfig } from '../features/retrospective'
import { chatEntryConfig, LazyChatSheet } from '../features/chat'
import { MoneySpace, QuickCaptureSheet } from '../features/expenses'

/**
 * v2.1 navigation (UX_REDESIGN.md): four spaces only — Today · Plan ·
 * Money · People — plus a context-aware FAB. The in-page tab strip is GONE;
 * the mobile bottom bar holds exactly the four spaces, the desktop sidebar
 * adds Console (organizers). Console, Recap and Chat are launched surfaces
 * (sheets), not tabs.
 */
type SpaceId = 'today' | 'plan' | 'money' | 'people'

const SPACE_IDS: SpaceId[] = ['today', 'plan', 'money', 'people']

const SPACE_META: Record<SpaceId, { label: string; icon: string }> = {
  today: { label: todayTabConfig.label, icon: todayTabConfig.icon },
  plan: { label: planTabConfig.label, icon: planTabConfig.icon },
  money: { label: 'Money', icon: '💰' },
  people: { label: peopleTabConfig.label, icon: peopleTabConfig.icon },
}

/** Legacy ?tab= ids (v2.0 links, claim links, old bookmarks) → v2.1 spaces. */
const LEGACY_TAB_TO_SPACE: Record<string, SpaceId> = {
  brief: 'today',
  home: 'today',
  today: 'today',
  notes: 'today',
  decisions: 'plan',
  timeline: 'plan',
  map: 'plan',
  plan: 'plan',
  money: 'money',
  expenses: 'money',
  'my-spending': 'money',
  'settle-up': 'money',
  people: 'people',
  checklist: 'people',
}

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const { data: trip = null, isLoading: tripLoading } = useTrip(tripId)
  const { data: participants = [], isLoading: participantsLoading } = useParticipants(tripId)
  const { data: currentUserRow } = useCurrentUserRow(user?.id)
  const { data: expensesData } = useExpenses(tripId)
  const loading = tripLoading || participantsLoading

  // One realtime subscription per trip — mounted exactly once, here.
  useTripRealtime(tripId)

  const [activeSpace, setActiveSpace] = useState<SpaceId>('today')
  // Legacy ?tab=my-spending / ?tab=settle-up deep links (and needs-attention
  // strip taps) still need to land on the right PUSHED SCREEN inside
  // MoneySpace, not just the Money space itself (UX_REDESIGN.md Part 4 #1
  // "Legacy ?tab= mappings for money sub-tabs should still land sensibly").
  // A counter (not just the screen id) forces MoneySpace to remount its
  // effect even when the same legacy link is opened twice in a row.
  const [moneyInitialScreen, setMoneyInitialScreen] = useState<{ screen: 'settle-up' | 'my-spending' | null; nonce: number }>({
    screen: null,
    nonce: 0,
  })
  const needsAttentionItems = useNeedsAttention(tripId, (spaceId) => {
    setActiveSpace(LEGACY_TAB_TO_SPACE[spaceId] ?? 'today')
  })

  const myParticipant = participants.find((p) => p.user_id === user?.id) || null
  const isSystemAdmin = currentUserRow?.role === 'admin'
  const isTripOrganizer = myParticipant?.role === 'organizer'
  const isOrganizer = isSystemAdmin || isTripOrganizer || trip?.created_by === user?.id

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [addParticipantModalOpen, setAddParticipantModalOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [recapOpen, setRecapOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [rsvpOpen, setRsvpOpen] = useState(false)
  const [travelDetailsOpen, setTravelDetailsOpen] = useState(false)
  const [addToPlanOpen, setAddToPlanOpen] = useState(false)
  const [quickCaptureOpenCount, setQuickCaptureOpenCount] = useState(0)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)

  const refetchTripData = () => {
    if (!tripId) return
    queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
  }

  // ?tab= deep links (legacy ids included) land on the right space; the
  // console/recap sheets are directly linkable too. Money's old sub-tab ids
  // ('my-spending', 'settle-up') additionally open the matching pushed
  // screen inside MoneySpace instead of just landing on the feed.
  useEffect(() => {
    const tabParam = searchParams.get('tab')
    if (!tabParam) return
    if (tabParam === 'organizer' || tabParam === 'console') setConsoleOpen(true)
    else if (tabParam === 'retro') setRecapOpen(true)
    else if (LEGACY_TAB_TO_SPACE[tabParam]) {
      setActiveSpace(LEGACY_TAB_TO_SPACE[tabParam])
      if (tabParam === 'my-spending' || tabParam === 'settle-up') {
        setMoneyInitialScreen((prev) => ({ screen: tabParam, nonce: prev.nonce + 1 }))
      }
    }
    searchParams.delete('tab')
    setSearchParams(searchParams, { replace: true })
  }, [searchParams, setSearchParams])

  // Any empty-state "paste a booking" CTA across the app can ask for
  // quick-capture without importing the expenses feature or the shell.
  useEffect(() => {
    const handler = () => setQuickCaptureOpen(true)
    window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
    return () => window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
  }, [])

  // Close the header overflow menu on outside click.
  useEffect(() => {
    if (!overflowOpen) return
    const onDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [overflowOpen])

  const effectiveStage = useMemo(() => (trip ? effectiveTripStage(trip) : 'gathering_interest'), [trip])

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="min-h-screen bg-[var(--surface-page)] flex items-center justify-center">
        <Card className="max-w-md">
          <Card.Content className="py-12">
            <EmptyState
              icon="❌"
              title="Trip not found"
              description="The trip you're looking for doesn't exist or you don't have access to it."
              action={
                <Button variant="primary" onClick={() => navigate('/dashboard')}>
                  Back to Dashboard
                </Button>
              }
            />
          </Card.Content>
        </Card>
      </div>
    )
  }

  const openQuickCapture = () => {
    setQuickCaptureOpenCount((c) => c + 1)
    setQuickCaptureOpen(true)
  }

  // -------------------------------------------------------------------------
  // Context-aware FAB (UX_REDESIGN "Navigation (final)"): each space gets ONE
  // primary action. Today's is stage-smart.
  // -------------------------------------------------------------------------
  const isPreCommit =
    (effectiveStage === 'gathering_interest' || effectiveStage === 'confirming_participants') &&
    myParticipant?.confirmation_status !== 'confirmed'

  const fabForSpace = (): { icon: string; label: string; onClick: () => void } => {
    switch (activeSpace) {
      case 'plan':
        return { icon: '➕', label: 'Add to plan', onClick: () => setAddToPlanOpen(true) }
      case 'money':
        return { icon: '📷', label: 'Scan receipt', onClick: openQuickCapture }
      case 'people':
        return isOrganizer
          ? { icon: '✉️', label: 'Add people', onClick: () => setAddParticipantModalOpen(true) }
          : { icon: '✈️', label: 'My travel details', onClick: () => setTravelDetailsOpen(true) }
      case 'today':
      default:
        if (isPreCommit && myParticipant && trip.confirmation_enabled) {
          return { icon: '📝', label: 'RSVP', onClick: () => setRsvpOpen(true) }
        }
        if (effectiveStage === 'trip_ongoing' || effectiveStage === 'trip_completed') {
          return { icon: '📷', label: 'Scan receipt', onClick: openQuickCapture }
        }
        return { icon: '➕', label: 'Add to plan', onClick: () => setAddToPlanOpen(true) }
    }
  }
  const fab = fabForSpace()

  const toShellTab = (id: SpaceId): AppShellTabItem => ({
    key: id,
    label: SPACE_META[id].label,
    icon: <span className="text-lg leading-none">{SPACE_META[id].icon}</span>,
    isActive: activeSpace === id,
    onClick: () => setActiveSpace(id),
  })

  const shellTabs: AppShellTabItem[] = SPACE_IDS.map(toShellTab)
  // Desktop sidebar: the four spaces + Console for organizers (a launched
  // sheet, not a space — isActive is never true for it).
  const sidebarTabs: AppShellTabItem[] = [
    ...shellTabs,
    ...(isOrganizer
      ? [
          {
            key: 'console',
            label: 'Console',
            icon: <span className="text-lg leading-none">🎛️</span>,
            isActive: false,
            onClick: () => setConsoleOpen(true),
          } satisfies AppShellTabItem,
        ]
      : []),
  ]

  const chatContext = activeSpace === 'money' ? (moneyInitialScreen.screen ?? 'expenses') : activeSpace

  return (
    <div data-trip-accent style={getTripAccentStyle(trip.id)} className="min-h-screen bg-[var(--surface-page)]">
      <AppShell
        tabs={shellTabs}
        sidebarTabs={sidebarTabs}
        onQuickAdd={fab.onClick}
        quickAddIcon={<span className="text-xl leading-none">{fab.icon}</span>}
        quickAddLabel={fab.label}
        sidebarHeader={
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Dashboard
          </button>
        }
      >
        {/* Header */}
        <div className="bg-[var(--surface-raised)]/90 backdrop-blur-sm border-b border-[var(--border-subtle)] sticky top-0 z-sticky">
          <div className="max-w-6xl mx-auto px-4 py-3">
            {/* Trip Title Row */}
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => navigate('/dashboard')}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0 md:hidden"
                  aria-label="Back to Dashboard"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-primary)] truncate">{trip.name}</h1>
              </div>
              <div className="flex gap-1 flex-shrink-0 items-center">
                {/* Ask AI — header entry point, all screens */}
                <button
                  onClick={() => setChatOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-accent-700 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950 rounded-[var(--radius-md)] transition-colors border border-accent-200 dark:border-accent-800"
                  title="Ask the trip assistant"
                >
                  <span aria-hidden="true">{chatEntryConfig.icon}</span>
                  <span className="hidden sm:inline">{chatEntryConfig.label}</span>
                </button>
                {isOrganizer && (
                  <div className="relative" ref={overflowRef}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setOverflowOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={overflowOpen}
                      aria-label="Trip actions"
                    >
                      •••
                    </Button>
                    {overflowOpen && (
                      <div
                        role="menu"
                        className="absolute right-0 mt-1 w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-lg py-1"
                      >
                        <button
                          role="menuitem"
                          className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                          onClick={() => {
                            setOverflowOpen(false)
                            setConsoleOpen(true)
                          }}
                        >
                          🎛️ Open console
                        </button>
                        <button
                          role="menuitem"
                          className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                          onClick={() => {
                            setOverflowOpen(false)
                            setEditModalOpen(true)
                          }}
                        >
                          ✏️ Edit trip
                        </button>
                        {trip.status === 'trip_completed' && (
                          <button
                            role="menuitem"
                            className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                            onClick={() => {
                              setOverflowOpen(false)
                              setRecapOpen(true)
                            }}
                          >
                            🎉 Recap
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Trip Details Row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)] mb-3">
              <span className="flex items-center gap-1">
                <span className="text-base">📍</span>
                {trip.location}
              </span>
              <span className="flex items-center gap-1">
                <span className="text-base">📅</span>
                {formatDateRange(trip.start_date, trip.end_date)}
              </span>
              <span className="flex items-center gap-1 text-accent-700 dark:text-accent-400 font-medium">
                {getCountdown(trip.start_date, trip.end_date)}
              </span>
            </div>

            {/* Stage rail — driven by the EFFECTIVE stage (date-upgraded). */}
            <div className="flex items-center gap-3">
              <StageRail status={effectiveStage} compact />
              <span className="text-xs font-medium text-[var(--text-muted)] whitespace-nowrap">
                {getTripStatusLabel(effectiveStage)}
              </span>
            </div>

            {/* Needs your attention — visible on every space ("your turn" principle) */}
            {needsAttentionItems.length > 0 && (
              <div className="mt-3">
                <NeedsAttentionStrip items={needsAttentionItems} />
              </div>
            )}
          </div>
        </div>

        {/* Space content — one error boundary per space. `position:relative`
            makes this the bounded content scroll container (UX_REDESIGN
            "Systemic layering" §2): in-content sticky elements cap at z-30,
            always under the z-sticky chrome above. */}
        <div className="relative max-w-6xl mx-auto px-4 py-6">
          {activeSpace === 'today' && (
            <ErrorBoundary label="Today">
              <todayTabConfig.Component
                trip={trip}
                effectiveStage={effectiveStage}
                isOrganizer={isOrganizer}
                onNavigate={(spaceId) => setActiveSpace(LEGACY_TAB_TO_SPACE[spaceId] ?? 'today')}
                onOpenConsole={() => setConsoleOpen(true)}
                onOpenRecap={() => setRecapOpen(true)}
                onQuickCapture={openQuickCapture}
                onInvite={() => setAddParticipantModalOpen(true)}
              />
            </ErrorBoundary>
          )}
          {activeSpace === 'plan' && (
            <ErrorBoundary label="Plan">
              <planTabConfig.Component trip={trip} onNavigate={(tabId) => setActiveSpace(LEGACY_TAB_TO_SPACE[tabId] ?? 'plan')} />
            </ErrorBoundary>
          )}
          {activeSpace === 'money' && (
            <ErrorBoundary label="Money">
              <MoneySpace key={moneyInitialScreen.nonce} trip={trip} initialScreen={moneyInitialScreen.screen} />
            </ErrorBoundary>
          )}
          {activeSpace === 'people' && (
            <ErrorBoundary label="People">
              <peopleTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
        </div>
      </AppShell>

      {/* Ask AI sheet — header button opens this; lazy-mounted on first open. */}
      {chatOpen && (
        <Suspense fallback={null}>
          <LazyChatSheet trip={trip} isOpen={chatOpen} onClose={() => setChatOpen(false)} context={chatContext} />
        </Suspense>
      )}

      {/* Organizer Console — a full-screen sheet now, launched from Today's
          blockers strip, the header overflow and the desktop sidebar. */}
      {isOrganizer && consoleOpen && (
        <Modal isOpen={consoleOpen} onClose={() => setConsoleOpen(false)} size="xl" title="Organizer console">
          <ErrorBoundary label="Console">
            <OrganizerConsole tripId={trip.id} />
          </ErrorBoundary>
        </Modal>
      )}

      {/* Recap — entry card lives on Today (completed); component stays reachable here. */}
      {recapOpen && (
        <Modal isOpen={recapOpen} onClose={() => setRecapOpen(false)} size="xl" title="Trip recap">
          <ErrorBoundary label="Recap">
            <Suspense fallback={<Skeleton variant="card" height={420} />}>
              <retroConfig.Component tripId={trip.id} />
            </Suspense>
          </ErrorBoundary>
        </Modal>
      )}

      {/* FAB targets */}
      <AddToPlanSheet isOpen={addToPlanOpen} onClose={() => setAddToPlanOpen(false)} trip={trip} />

      {myParticipant && (
        <StatusModal
          isOpen={rsvpOpen}
          onClose={() => setRsvpOpen(false)}
          tripId={trip.id}
          participant={myParticipant}
          participants={participants}
          capacityLimit={trip.capacity_limit}
          confirmedCount={participants.filter((p) => p.confirmation_status === 'confirmed').length}
        />
      )}

      <TravelDetailsSheet isOpen={travelDetailsOpen} onClose={() => setTravelDetailsOpen(false)} tripId={trip.id} />

      {/* Quick capture (scan receipt / add expense), remounted with a fresh
          key on every open per the feature's contract. */}
      {quickCaptureOpen && (
        <QuickCaptureSheet
          key={quickCaptureOpenCount}
          isOpen={quickCaptureOpen}
          onClose={() => setQuickCaptureOpen(false)}
          trip={trip}
          participants={participants}
          allExpenses={expensesData?.expenses ?? []}
        />
      )}

      {/* Admin/organizer modals */}
      <CreateTripModal isOpen={editModalOpen} onClose={() => setEditModalOpen(false)} onSuccess={refetchTripData} editTrip={trip} />
      <AddParticipantModal
        isOpen={addParticipantModalOpen}
        onClose={() => setAddParticipantModalOpen(false)}
        tripId={trip.id}
        existingParticipantIds={participants.map((p) => p.user_id)}
        onSuccess={refetchTripData}
      />
    </div>
  )
}

// Smart date formatting: only repeat month/year when they differ
function formatDateRange(startDate: string, endDate: string) {
  const start = new Date(startDate)
  const end = new Date(endDate)

  const startMonth = start.toLocaleDateString('en-US', { month: 'short' })
  const endMonth = end.toLocaleDateString('en-US', { month: 'short' })
  const startDay = start.getDate()
  const endDay = end.getDate()
  const startYear = start.getFullYear()
  const endYear = end.getFullYear()

  if (startMonth === endMonth && startYear === endYear) {
    return `${startMonth} ${startDay}-${endDay}, ${startYear}`
  }
  if (startYear === endYear) {
    return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${startYear}`
  }
  return `${startMonth} ${startDay}, ${startYear} - ${endMonth} ${endDay}, ${endYear}`
}

// Countdown to trip (date-aware: quiet once the trip is over)
function getCountdown(startDate: string, endDate: string) {
  const start = new Date(startDate)
  const now = new Date()
  const diffTime = start.getTime() - now.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  if (new Date(endDate).getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    return '🏁 Trip finished'
  } else if (diffDays < 0) {
    return '🎿 Trip in progress!'
  } else if (diffDays === 0) {
    return '🎿 Trip starts today!'
  } else if (diffDays === 1) {
    return '🎿 Trip starts tomorrow!'
  } else {
    return `${diffDays} days until trip`
  }
}
