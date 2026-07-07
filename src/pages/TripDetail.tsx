import { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Spinner, EmptyState, Tabs, Skeleton } from '../components/ui'
import { CreateTripModal, AddParticipantModal } from '../components'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { AppShell, StageRail, NeedsAttentionStrip, QuickActionsSheet } from '../components/layout'
import type { AppShellTabItem, QuickAction } from '../components/layout'
import { getTripAccentStyle } from '../components/layout/tripAccent'
import { useTrip, useParticipants, useCurrentUserRow } from '../lib/queries/useTrip'
import { useTripRealtime } from '../lib/queries/useTripRealtime'
import { useNeedsAttention } from '../lib/queries/useNeedsAttention'
import { useExpenses } from '../lib/queries/useExpenses'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../lib/queries/queryKeys'
import { getTripStatusLabel } from '../lib/tripStatus'
import type { Trip, TripStatus } from '../types'

import { briefTabConfig } from '../features/brief'
import { peopleTabConfig } from '../features/people'
import { decisionsTabConfig } from '../features/decisions'
import { timelineTabConfig, OPEN_QUICK_CAPTURE_EVENT, EventEditorSheet } from '../features/timeline'
import { tripMapTabConfig } from '../features/places'
import { notesTabConfig } from '../features/notes'
import { checklistTabConfig } from '../features/checklists'
import { organizerTabConfig } from '../features/organizer'
import { retroConfig } from '../features/retrospective'
import { chatEntryConfig, LazyChatSheet } from '../features/chat'
import { EXPENSE_TAB_CONFIGS, QuickCaptureSheet } from '../features/expenses'

/**
 * Trip tab registry: one source of truth, assembled from each feature's
 * exported tab config (per UPGRADE_MASTER_PLAN §5/§6). "Money" is a hub
 * entry — its content renders the three EXPENSE_TAB_CONFIGS as inner tabs
 * rather than being one of them directly. Stage/role filtering happens in
 * `useTripTabs` below, not here.
 */
interface TabEntry {
  tabId: string
  label: string
  icon: string
  organizerOnly?: boolean
  /** Only present for stage-gated tabs (currently just Recap). */
  showWhen?: (trip: Pick<Trip, 'status'>) => boolean
}

const MONEY_TAB: TabEntry = { tabId: 'money', label: 'Money', icon: '💰' }

const BASE_TAB_ENTRIES: TabEntry[] = [
  { tabId: briefTabConfig.tabId, label: 'Home', icon: briefTabConfig.icon },
  { tabId: peopleTabConfig.tabId, label: peopleTabConfig.label, icon: peopleTabConfig.icon },
  { tabId: decisionsTabConfig.tabId, label: 'Plan', icon: decisionsTabConfig.icon },
  { tabId: timelineTabConfig.tabId, label: timelineTabConfig.label, icon: timelineTabConfig.icon },
  MONEY_TAB,
  { tabId: tripMapTabConfig.tabId, label: tripMapTabConfig.label, icon: tripMapTabConfig.icon },
  { tabId: notesTabConfig.tabId, label: notesTabConfig.label, icon: notesTabConfig.icon },
  { tabId: checklistTabConfig.tabId, label: checklistTabConfig.label, icon: checklistTabConfig.icon },
  { tabId: organizerTabConfig.tabId, label: organizerTabConfig.label, icon: organizerTabConfig.icon, organizerOnly: true },
  { tabId: retroConfig.tabId, label: retroConfig.label, icon: retroConfig.icon, showWhen: retroConfig.showWhen },
]

/** The 4 shell bottom-bar / sidebar-priority slots (plan §5: 4 tabs + FAB). */
const SHELL_SLOT_IDS = ['brief', 'decisions', 'timeline', 'money']

/**
 * Stage-aware default tab (ports the legacy auto-select intent from the v1
 * TripDetail). TripBrief is a pre-confirmation "gather interest" surface —
 * it does not adapt into a Today/live-balance screen during trip_ongoing,
 * so trip_ongoing defaults to Timeline instead of Home (see coordinator
 * task notes).
 */
function defaultTabForStage(status: TripStatus, isConfirmed: boolean): string {
  if (!isConfirmed) return 'people'
  switch (status) {
    case 'gathering_interest':
    case 'confirming_participants':
      return 'brief'
    case 'booking_details':
      return 'decisions'
    case 'booked_awaiting_departure':
      return 'timeline'
    case 'trip_ongoing':
      return 'timeline'
    case 'trip_completed':
      return 'money'
    default:
      return 'brief'
  }
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

  // One realtime subscription per trip, debounced, invalidating the
  // matching query-key branch on any relevant postgres_changes event.
  useTripRealtime(tripId)

  const [activeTab, setActiveTab] = useState<string>('brief')
  const [moneySubTab, setMoneySubTab] = useState<string>(EXPENSE_TAB_CONFIGS[0].tabId)
  const needsAttentionItems = useNeedsAttention(tripId, setActiveTab)

  const myParticipant = participants.find((p) => p.user_id === user?.id) || null
  const isSystemAdmin = currentUserRow?.role === 'admin'
  const isTripOrganizer = myParticipant?.role === 'organizer'
  const isOrganizer = isSystemAdmin || isTripOrganizer || trip?.created_by === user?.id

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [addParticipantModalOpen, setAddParticipantModalOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  const [quickCaptureOpenCount, setQuickCaptureOpenCount] = useState(0)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const [eventEditorOpen, setEventEditorOpen] = useState(false)
  const [hasSetInitialTab, setHasSetInitialTab] = useState(false)

  const refetchTripData = () => {
    if (!tripId) return
    queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
  }

  // Tab registry: stage- and role-filtered (plan §5/§6). Recap only once
  // the trip is completed; Console only for organizers.
  const tabEntries = useMemo(() => {
    if (!trip) return []
    return BASE_TAB_ENTRIES.filter((t) => {
      if (t.organizerOnly && !isOrganizer) return false
      if (t.showWhen && !t.showWhen(trip)) return false
      return true
    })
  }, [trip, isOrganizer])

  // Handle ?tab= query param (e.g. from a shared link or a "back to X" button).
  useEffect(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam && tabEntries.some((t) => t.tabId === tabParam)) {
      setActiveTab(tabParam)
      setHasSetInitialTab(true)
      searchParams.delete('tab')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams, tabEntries])

  // Stage-aware default tab, set once trip/participants have loaded.
  useEffect(() => {
    if (trip && participants.length > 0 && user && !hasSetInitialTab && !searchParams.get('tab')) {
      const isConfirmed = myParticipant?.confirmation_status === 'confirmed'
      setActiveTab(defaultTabForStage(trip.status, isConfirmed))
      setHasSetInitialTab(true)
    }
  }, [trip, participants, user, hasSetInitialTab, searchParams, myParticipant])

  // Any empty-state "paste a booking" CTA across the app can ask for
  // quick-capture without importing the expenses feature or the shell.
  useEffect(() => {
    const handler = () => setQuickCaptureOpen(true)
    window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
    return () => window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
  }, [])

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

  // Shell's 4 priority slots (Home/Plan/Timeline/Money), mapped to the same
  // active-tab state as the full in-page tab strip below — tapping either
  // one drives the same `activeTab`.
  const toShellTab = (entry: TabEntry): AppShellTabItem => ({
    key: entry.tabId,
    label: entry.label,
    icon: <span className="text-lg leading-none">{entry.icon}</span>,
    isActive: activeTab === entry.tabId,
    onClick: () => setActiveTab(entry.tabId),
  })

  const shellTabs: AppShellTabItem[] = SHELL_SLOT_IDS.filter((id) => tabEntries.some((t) => t.tabId === id)).map(
    (id) => toShellTab(tabEntries.find((t) => t.tabId === id)!)
  )
  // Desktop sidebar shows every tab, not just the mobile bottom bar's 4 slots.
  const sidebarTabs: AppShellTabItem[] = tabEntries.map(toShellTab)

  const openQuickCapture = () => {
    setQuickCaptureOpenCount((c) => c + 1)
    setQuickCaptureOpen(true)
  }

  const chatContextForTab = (tabId: string): string => (tabId === 'timeline' ? 'itinerary' : tabId === 'money' ? moneySubTab : tabId)

  const quickActions: QuickAction[] = [
    {
      key: 'scan-receipt',
      icon: <span>📷</span>,
      label: 'Scan receipt',
      description: 'Snap or upload a photo',
      onClick: openQuickCapture,
    },
    {
      key: 'add-expense',
      icon: <span>💰</span>,
      label: 'Add expense',
      description: 'Enter it manually',
      onClick: openQuickCapture,
    },
    {
      key: 'add-event',
      icon: <span>📅</span>,
      label: 'Add event',
      description: 'Add to the itinerary',
      onClick: () => {
        if (isOrganizer) {
          setEventEditorOpen(true)
        } else {
          setActiveTab('timeline')
        }
      },
    },
    {
      key: 'ask-ai',
      icon: <span>✨</span>,
      label: chatEntryConfig.label,
      description: 'Ask the trip assistant',
      onClick: () => setChatOpen(true),
    },
    ...(isOrganizer
      ? [
          {
            key: 'new-poll',
            icon: <span>🗳️</span>,
            label: 'New poll/option',
            description: 'Add something to decide',
            onClick: () => setActiveTab('decisions'),
          },
        ]
      : []),
  ]

  return (
    <div data-trip-accent style={getTripAccentStyle(trip.id)} className="min-h-screen bg-[var(--surface-page)]">
      <AppShell
        tabs={shellTabs}
        sidebarTabs={sidebarTabs}
        onQuickAdd={() => setQuickActionsOpen(true)}
        quickAddIcon={<span className="text-xl leading-none">+</span>}
        quickAddLabel="Quick actions"
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
                {/* Ask AI — header entry point, all screens (plan §13 "Accessible AI") */}
                <button
                  onClick={() => setChatOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-accent-700 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950 rounded-[var(--radius-md)] transition-colors border border-accent-200 dark:border-accent-800"
                  title="Ask the trip assistant"
                >
                  <span aria-hidden="true">{chatEntryConfig.icon}</span>
                  <span className="hidden sm:inline">{chatEntryConfig.label}</span>
                </button>
                {isOrganizer && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => setEditModalOpen(true)} className="hidden sm:inline-flex">
                      Edit
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditModalOpen(true)} className="sm:hidden">
                      •••
                    </Button>
                  </>
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
                {getCountdown(trip.start_date)}
              </span>
            </div>

            {/* Stage rail */}
            <div className="flex items-center gap-3 mb-3">
              <StageRail status={trip.status} compact />
              <span className="text-xs font-medium text-[var(--text-muted)] whitespace-nowrap">
                {getTripStatusLabel(trip.status)}
              </span>
            </div>

            {/* Needs your attention — the organizer-never-chases-manually strip */}
            {needsAttentionItems.length > 0 && (
              <div className="mb-3">
                <NeedsAttentionStrip items={needsAttentionItems} />
              </div>
            )}

            {/* In-page tab strip: EVERY tab (including the shell's 4 priority
                slots), so nothing is unreachable on mobile — the desktop
                sidebar also shows every tab in `tabEntries` via `shellTabs`'
                filter only picking 4 of them for the shell's own slots. */}
            <Tabs value={activeTab} onChange={setActiveTab}>
              <Tabs.List scrollable>
                {tabEntries.map((t) => (
                  <Tabs.Tab key={t.tabId} value={t.tabId}>
                    <span className="mr-1" aria-hidden="true">
                      {t.icon}
                    </span>
                    {t.label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs>
          </div>
        </div>

        {/* Tab Content — each tab gets its own error boundary (per
            UPGRADE_MASTER_PLAN §4/§16) so a bug in one tab can't take down
            navigation or the rest of the trip page. */}
        <div className="max-w-6xl mx-auto px-4 py-8">
          {activeTab === 'brief' && (
            <ErrorBoundary label="Home">
              <briefTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
          {activeTab === 'people' && (
            <ErrorBoundary label="People">
              <div className="space-y-3">
                {isOrganizer && (
                  <div className="max-w-2xl mx-auto flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setAddParticipantModalOpen(true)}>
                      + Add participant
                    </Button>
                  </div>
                )}
                <peopleTabConfig.Component tripId={trip.id} />
              </div>
            </ErrorBoundary>
          )}
          {activeTab === 'decisions' && (
            <ErrorBoundary label="Plan">
              <decisionsTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
          {activeTab === 'timeline' && (
            <ErrorBoundary label="Timeline">
              <timelineTabConfig.Component trip={trip} />
            </ErrorBoundary>
          )}
          {activeTab === 'money' && (
            <ErrorBoundary label="Money">
              <MoneyHub trip={trip} activeSubTab={moneySubTab} onSubTabChange={setMoneySubTab} />
            </ErrorBoundary>
          )}
          {activeTab === 'map' && (
            <ErrorBoundary label="Map">
              <Suspense fallback={<Skeleton variant="card" height={420} />}>
                <tripMapTabConfig.Component tripId={trip.id} tripStartDate={trip.start_date} />
              </Suspense>
            </ErrorBoundary>
          )}
          {activeTab === 'notes' && (
            <ErrorBoundary label="Notes">
              <notesTabConfig.Component trip={trip} />
            </ErrorBoundary>
          )}
          {activeTab === 'checklist' && (
            <ErrorBoundary label="Checklist">
              <checklistTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
          {activeTab === 'organizer' && isOrganizer && (
            <ErrorBoundary label="Console">
              <organizerTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
          {activeTab === 'retro' && (
            <ErrorBoundary label="Recap">
              <Suspense fallback={<Skeleton variant="card" height={420} />}>
                <retroConfig.Component tripId={trip.id} />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </AppShell>

      {/* Ask AI sheet — FAB's "Ask AI" action + header button both open this.
          Lazy-loaded (WSH perf pass): only mounted once the user opens chat
          at least once, keeping streaming/markdown/proposal-review JS out of
          the main chunk. `chatOpen` already gates its internal queries, so
          mounting on first-open (and keeping it mounted after, so state like
          the message list persists across close/reopen) matches prior
          behavior for anyone who has already opened chat. */}
      {chatOpen && (
        <Suspense fallback={null}>
          <LazyChatSheet trip={trip} isOpen={chatOpen} onClose={() => setChatOpen(false)} context={chatContextForTab(activeTab)} />
        </Suspense>
      )}

      {/* Quick actions sheet (FAB landing menu) */}
      <QuickActionsSheet isOpen={quickActionsOpen} onClose={() => setQuickActionsOpen(false)} actions={quickActions} />

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

      {/* Add event (organizer-only quick action) */}
      <EventEditorSheet isOpen={eventEditorOpen} onClose={() => setEventEditorOpen(false)} trip={trip} event={null} />

      {/* Admin Modals */}
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

// ---------------------------------------------------------------------------
// Money hub: one tab whose content renders inner Tabs for the three
// EXPENSE_TAB_CONFIGS (Expenses / Settle up / My spending) — plan §5's
// "Money is a hub" instruction.
// ---------------------------------------------------------------------------
function MoneyHub({
  trip,
  activeSubTab,
  onSubTabChange,
}: {
  trip: Trip
  activeSubTab: string
  onSubTabChange: (tabId: string) => void
}) {
  const active = EXPENSE_TAB_CONFIGS.find((c) => c.tabId === activeSubTab) ?? EXPENSE_TAB_CONFIGS[0]
  return (
    <div className="space-y-4">
      <Tabs value={active.tabId} onChange={onSubTabChange}>
        <Tabs.List>
          {EXPENSE_TAB_CONFIGS.map((c) => (
            <Tabs.Tab key={c.tabId} value={c.tabId}>
              <span className="mr-1" aria-hidden="true">
                {c.icon}
              </span>
              {c.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      <active.Component trip={trip} />
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

// Countdown to trip
function getCountdown(startDate: string) {
  const start = new Date(startDate)
  const now = new Date()
  const diffTime = start.getTime() - now.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  if (diffDays < 0) {
    return '🎿 Trip in progress!'
  } else if (diffDays === 0) {
    return '🎿 Trip starts today!'
  } else if (diffDays === 1) {
    return '🎿 Trip starts tomorrow!'
  } else {
    return `${diffDays} days until trip`
  }
}
