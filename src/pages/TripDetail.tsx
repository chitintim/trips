import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTripPermissions } from '../hooks/useTripPermissions'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Button, Card, Spinner, EmptyState, Skeleton, Modal, useToast } from '../components/ui'
import { AddParticipantModal } from '../components'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { AppShell, StageRail, TodoPill } from '../components/layout'
import type { AppShellTabItem } from '../components/layout'
import { getTripAccentStyle } from '../components/layout/tripAccent'
import { useTrip, useParticipants, type ParticipantWithUser } from '../lib/queries/useTrip'
import { CreateTripWizard } from '../features/dashboard'
import { useTripRealtime } from '../lib/queries/useTripRealtime'
import { useTodos } from '../lib/queries/useTodos'
import { useSections } from '../lib/queries/usePlanning'
import { useTimeline } from '../lib/queries/useTimeline'
import { answerTodoList } from '../lib/todos/computeTodos'
import { isTripFinished, isOwnChoice } from '../lib/answers/answers'
import { useExpenses } from '../lib/queries/useExpenses'
import { useSettlements } from '../lib/queries/useSettlements'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../lib/queries/queryKeys'
import { getTripStatusLabel } from '../lib/tripStatus'
import { effectiveTripStage } from '../lib/tripStage'
import { daysUntil } from '../lib/dates'
import {
  planDeepLink,
  fallbackDeepLinkPlan,
  resolveOpenParam,
  stripDeepLinkParams,
  type DeepLinkContext,
  type DeepLinkPlan,
  type OpenTarget,
  type SpaceId,
} from './tripDeepLinks'

import { todayTabConfig } from '../features/today'
import { planTabConfig, AddToPlanSheet, AnswerFlow } from '../features/plan'
import { useCanSuggestIdea } from '../features/plan/lib/useCanSuggestIdea'
import type { PlanFocus } from '../features/plan'
import { QuestionManageSheet } from '../features/decisions'
import { peopleTabConfig, StatusModal, TravelDetailsSheet } from '../features/people'
import { OPEN_QUICK_CAPTURE_EVENT } from '../features/timeline'
import { OrganizerConsole } from '../features/organizer'
import { ActionsSheet } from '../features/actions'
import { retroConfig } from '../features/retrospective'
import { chatEntryConfig, LazyChatSheet } from '../features/chat'
import { MoneySpace, QuickCaptureSheet } from '../features/expenses'
import { ADD_EXPENSE_LABEL, ADD_EXPENSE_NAV_ICON } from '../features/expenses/quick-capture/addExpenseEntry'
import { MarkPaidSheet } from '../features/expenses/settle-up/MarkPaidSheet'

/**
 * v2.1 navigation (UX_REDESIGN.md): four spaces only — Today · Plan ·
 * Money · People — plus a context-aware FAB. The in-page tab strip is GONE;
 * the mobile bottom bar holds exactly the four spaces, the desktop sidebar
 * adds Console (organizers). Console, Recap and Chat are launched surfaces
 * (sheets), not tabs.
 */
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
  // The standalone Checklist sub-tab is gone (v2.2: it's now the "Bring
  // list" segment of the Actions sheet) — old links land on Today rather
  // than a People tab strip position that no longer exists.
  checklist: 'today',
}

/** DOM id Today puts on its "Your to-dos" card (read by the todos deep link and the Today button). */
const YOUR_TODOS_ANCHOR_ID = 'your-todos'

/** How long a pending ?open= waits for the trip's data before giving up with a toast. */
const DEEP_LINK_DATA_TIMEOUT_MS = 8000

const DEEP_LINK_UNKNOWN_TOAST = "That link didn't open anything."

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const { data: trip = null, isLoading: tripLoading } = useTrip(tripId)
  useDocumentTitle(trip?.name)
  const { data: participants = [], isLoading: participantsLoading } = useParticipants(tripId)
  const { data: expensesData } = useExpenses(tripId)
  // Same cache the to-dos snapshot reads, so a just-created settlement is found.
  const { data: settlementsData } = useSettlements(tripId)
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
  // One to-do engine for the whole screen: the header pill, the FAB and the
  // ?open= router all read this, so they can never disagree with Today.
  const { todos, count: todoCount, hasOverdue: todosOverdue, isLoading: todosLoading, isError: todosError, snapshot } = useTodos(tripId)
  const { showToast } = useToast()
  const { data: sectionsData } = useSections(tripId)
  const { data: timelineData } = useTimeline(tripId)
  // ?open= target parsed from the URL, waiting for the trip's data to load
  // before it is routed (a stale-id check against half-loaded data would
  // wrongly fail soft).
  const [pendingOpen, setPendingOpen] = useState<OpenTarget | null>(null)
  const [answerSectionIds, setAnswerSectionIds] = useState<string[] | null>(null)
  const [markPaidSettlementId, setMarkPaidSettlementId] = useState<string | null>(null)
  const [todosScrollNonce, setTodosScrollNonce] = useState(0)
  // ?open=decide:<sectionId> / book:<optionId> -> that question's Manage sheet, opened into Decide / Mark booked.
  const [manageRequest, setManageRequest] = useState<{ sectionId: string; mode: 'decide' | 'book'; optionId?: string } | null>(null)
  // Hand-offs for deep links that target something a space owns: the Plan
  // opens an item / highlights a question, Money scrolls to a payment, the
  // To-dos sheet flashes a row. `nonce` re-fires the same link twice in a row.
  const [planFocus, setPlanFocus] = useState<PlanFocus | null>(null)
  const [moneyConfirm, setMoneyConfirm] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 })
  const [actionsHighlightId, setActionsHighlightId] = useState<string | undefined>(undefined)

  const myParticipant = participants.find((p) => p.user_id === user?.id) || null
  const { canManageTrip: isOrganizer } = useTripPermissions(trip)
  // Participants who are coming get the Add entry with exactly one intent ("An idea").
  const canSuggestIdea = useCanSuggestIdea(trip)
  const canAdd = isOrganizer || canSuggestIdea

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [addParticipantModalOpen, setAddParticipantModalOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [recapOpen, setRecapOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [actionsInitialSegment, setActionsInitialSegment] = useState<'actions' | 'bring'>('actions')
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [rsvpOpen, setRsvpOpen] = useState(false)
  const [travelDetailsOpen, setTravelDetailsOpen] = useState(false)
  const [addToPlanOpen, setAddToPlanOpen] = useState(false)
  // Organiser setup "Ask the group your first question" opens the sheet in vote mode.
  const [addToPlanAsQuestion, setAddToPlanAsQuestion] = useState(false)
  const [quickCaptureOpenCount, setQuickCaptureOpenCount] = useState(0)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  const overflowTriggerRef = useRef<HTMLButtonElement>(null)
  const overflowMenuRef = useRef<HTMLDivElement>(null)

  const refetchTripData = () => {
    if (!tripId) return
    queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.participants(tripId) })
  }

  // ?tab= deep links (legacy ids included) land on the right space; the
  // console/recap sheets are directly linkable too. Money's old sub-tab ids
  // ('my-spending', 'settle-up') additionally open the matching pushed
  // screen inside MoneySpace instead of just landing on the feed.
  //
  // ?open= is a sibling for links that need to land on a specific SHEET
  // rather than just a space (e.g. an action note's "fill in your flights"
  // link opening travel details directly) — see tripDeepLinks.ts.
  useEffect(() => {
    const tabParam = searchParams.get('tab')
    const openParam = searchParams.get('open')
    if (!tabParam && !openParam) return

    if (tabParam === 'organizer' || tabParam === 'console') setConsoleOpen(true)
    else if (tabParam === 'retro') setRecapOpen(true)
    else if (tabParam && LEGACY_TAB_TO_SPACE[tabParam]) {
      setActiveSpace(LEGACY_TAB_TO_SPACE[tabParam])
      if (tabParam === 'my-spending' || tabParam === 'settle-up') {
        setMoneyInitialScreen((prev) => ({ screen: tabParam, nonce: prev.nonce + 1 }))
      }
    }

    if (openParam) {
      const target = resolveOpenParam(openParam)
      if (target) setPendingOpen(target)
      else showToast({ type: 'info', message: DEEP_LINK_UNKNOWN_TOAST })
    }

    // One-shot: drop the params so a refresh (or back) doesn't reopen the sheet.
    const rest = stripDeepLinkParams(searchParams.toString())
    setSearchParams(rest ? new URLSearchParams(rest) : new URLSearchParams(), { replace: true })
  }, [searchParams, setSearchParams, showToast])

  // -------------------------------------------------------------------------
  // ?open= routing. The pure table lives in tripDeepLinks.ts (planDeepLink);
  // here we only build its read-only view of the data and apply the result to
  // the sheet state this component already owns.
  // -------------------------------------------------------------------------
  const deepLinkContext = useMemo<DeepLinkContext | null>(() => {
    if (!trip || !snapshot) return null
    const sections = snapshot.sections.map((s) => ({
      id: s.id,
      status: s.status,
      hasLiveOptions: s.options.some((o) => o.status !== 'cancelled'),
    }))
    const liveBookingOptionIds = new Set((snapshot.bookings ?? []).filter((b) => b.option_id && b.status !== 'cancelled').map((b) => b.option_id as string))
    const options = snapshot.sections.flatMap((s) => s.options.map((o) => ({ id: o.id, sectionId: s.id, booked: o.status === 'booked' || liveBookingOptionIds.has(o.id) })))
    const ownChoiceSectionIds = new Set(snapshot.sections.filter((s) => isOwnChoice(s)).map((s) => s.id))
    const itemIds = new Set<string>()
    for (const e of timelineData ?? []) itemIds.add(e.id)
    for (const s of snapshot.sections) for (const o of s.options) itemIds.add(o.id)
    return {
      userId: user?.id ?? null,
      isOrganizer,
      isParticipant: !!myParticipant,
      tripFinished: isTripFinished(trip),
      participantCount: participants.length,
      sections,
      answerSectionIds: answerTodoList(todos).map((t) => t.entityId),
      actionIds: new Set(snapshot.actions.map((a) => a.id)),
      checklistIds: new Set(snapshot.checklists.map((c) => c.id)),
      settlements: snapshot.settlements,
      expenses: (expensesData?.expenses ?? []).map((e) => ({ id: e.id, claimCode: e.allocation_link?.code ?? null, paidBy: e.paid_by })),
      itemIds,
      options,
      ownChoiceSectionIds,
    }
  }, [trip, snapshot, timelineData, user?.id, isOrganizer, myParticipant, participants.length, todos, expensesData])

  const applyDeepLinkPlan = (plan: DeepLinkPlan) => {
    setActiveSpace(plan.space)
    if (plan.toast) showToast({ type: 'info', message: plan.toast })
    const sheet = plan.open
    if (!sheet) return
    switch (sheet.sheet) {
      case 'rsvp':
        setRsvpOpen(true)
        break
      case 'answer':
        setAnswerSectionIds(sheet.sectionIds)
        break
      case 'actions':
        setActionsHighlightId(sheet.highlightId)
        setActionsInitialSegment(sheet.segment)
        setActionsOpen(true)
        break
      case 'travel-details':
        setTravelDetailsOpen(true)
        break
      case 'settle-up':
        setMoneyInitialScreen((prev) => ({ screen: 'settle-up', nonce: prev.nonce + 1 }))
        break
      case 'confirm-payment':
        setMoneyConfirm((prev) => ({ id: sheet.settlementId, nonce: prev.nonce + 1 }))
        setMoneyInitialScreen((prev) => ({ screen: 'settle-up', nonce: prev.nonce + 1 }))
        break
      case 'plan-item':
        setPlanFocus((prev) => ({ kind: 'item', id: sheet.id, nonce: (prev?.nonce ?? 0) + 1 }))
        break
      case 'plan-question':
        setPlanFocus((prev) => ({ kind: 'question', id: sheet.id, nonce: (prev?.nonce ?? 0) + 1 }))
        break
      case 'manage-question':
        // Organiser to-dos (Decide / Tie / Book): the question's Manage sheet, straight into the step.
        setManageRequest({ sectionId: sheet.id, mode: sheet.mode, optionId: sheet.optionId })
        break
      case 'mark-paid':
        setMarkPaidSettlementId(sheet.settlementId)
        break
      case 'claim':
        navigate(`/claim/${encodeURIComponent(sheet.code)}${sheet.assign ? '?assign=1' : ''}`)
        break
      case 'add-participant':
        setAddParticipantModalOpen(true)
        break
      case 'add-to-plan':
        // Participants cannot save to the plan, so the link opens nothing for them.
        if (!isOrganizer) break
        setAddToPlanAsQuestion(sheet.asQuestion === true)
        setAddToPlanOpen(true)
        break
      case 'scroll-todos':
        setTodosScrollNonce((n) => n + 1)
        break
    }
  }

  useEffect(() => {
    if (!pendingOpen || !deepLinkContext || todosLoading) return
    setPendingOpen(null)
    applyDeepLinkPlan(planDeepLink(pendingOpen, deepLinkContext))
    // applyDeepLinkPlan only calls state setters, navigate and showToast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, deepLinkContext, todosLoading])

  // The link must never fail silently: if the data errors or never finishes
  // loading (the router above waits for ALL of it), land on Today with a toast.
  useEffect(() => {
    if (!pendingOpen) return
    const fallback = () => {
      setPendingOpen(null)
      applyDeepLinkPlan(fallbackDeepLinkPlan(pendingOpen))
    }
    if (todosError) {
      fallback()
      return
    }
    const timer = setTimeout(fallback, DEEP_LINK_DATA_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, todosError])

  // "Your to-dos": scroll Today's card into view. Today renders it under
  // id="your-todos" (hook-up for slice 1C); until that anchor exists on the
  // page, fall back to the to-dos sheet so the pill always opens something.
  useEffect(() => {
    if (todosScrollNonce === 0) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      const el = document.getElementById(YOUR_TODOS_ANCHOR_ID)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // Brief highlight so the link gives feedback even when already in view or empty.
        const prev = {
          shadow: el.style.boxShadow,
          transition: el.style.transition,
        }
        el.style.transition = 'box-shadow 300ms ease'
        el.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.55)'
        setTimeout(() => {
          el.style.boxShadow = prev.shadow
          setTimeout(() => (el.style.transition = prev.transition), 350)
        }, 1500)
        return
      }
      // Today shows a skeleton until its data loads, so allow a few seconds.
      if (++tries > 60) {
        setActionsHighlightId(undefined)
        setActionsInitialSegment('actions')
        setActionsOpen(true)
        return
      }
      timer = setTimeout(attempt, 60)
    }
    attempt()
    return () => clearTimeout(timer)
  }, [todosScrollNonce])

  // Any empty-state "paste a booking" CTA across the app can ask for
  // quick-capture without importing the expenses feature or the shell.
  useEffect(() => {
    const handler = () => setQuickCaptureOpen(true)
    window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
    return () => window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, handler)
  }, [])

  // Header overflow menu: close on outside click or Escape, move focus into
  // the menu on open, restore it to the ••• trigger on close.
  useEffect(() => {
    if (!overflowOpen) return
    const onDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOverflowOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    overflowMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const trigger = overflowTriggerRef.current
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
  }, [overflowOpen])

  const countdown = trip ? getCountdown(trip.start_date, trip.end_date) : null
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
  // The contextual sixth nav slot (UX redesign 5.1). One rule, one action per
  // space: "Add" on Plan, "＋ Add expense" on Money, "Invite" on People
  // (organisers only), "Your to-dos" on Today when there are any. Otherwise
  // the slot is simply absent.
  // -------------------------------------------------------------------------
  const goToTodos = () => {
    setActiveSpace('today')
    setTodosScrollNonce((n) => n + 1)
  }

  const fabForSpace = (): { icon: string; label: string; onClick: () => void } | null => {
    switch (activeSpace) {
      case 'plan':
        // Organizers add anything; participants only suggest ideas (server-checked RPC); everyone else gets no Add entry.
        return !canAdd
          ? null
          : {
              icon: '➕',
              label: 'Add',
              onClick: () => {
                setAddToPlanAsQuestion(false)
                setAddToPlanOpen(true)
              },
            }
      case 'money':
        return { icon: ADD_EXPENSE_NAV_ICON, label: ADD_EXPENSE_LABEL, onClick: openQuickCapture }
      case 'people':
        return isOrganizer ? { icon: '✉️', label: 'Invite', onClick: () => setAddParticipantModalOpen(true) } : null
      case 'today':
      default:
        return todoCount !== undefined && todoCount > 0 ? { icon: '✅', label: 'Your to-dos', onClick: goToTodos } : null
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
        onQuickAdd={fab?.onClick}
        quickAddIcon={fab ? <span className="text-xl leading-none">{fab.icon}</span> : undefined}
        quickAddLabel={fab?.label}
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
                {/* One to-do count on every space; hidden at 0, red if overdue. */}
                {todoCount !== undefined && todoCount > 0 && (
                  <TodoPill count={todoCount} hasOverdue={todosOverdue} onClick={goToTodos} />
                )}
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
                      ref={overflowTriggerRef}
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
                        ref={overflowMenuRef}
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
              {countdown && (
                <span className="flex items-center gap-1 text-accent-700 dark:text-accent-400 font-medium">{countdown}</span>
              )}
            </div>

            {/* Stage rail — driven by the EFFECTIVE stage (date-upgraded). */}
            <div className="flex items-center gap-3">
              <StageRail status={effectiveStage} compact />
              <span className="text-xs font-medium text-[var(--text-muted)] whitespace-nowrap">
                {getTripStatusLabel(effectiveStage)}
              </span>
            </div>
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
                onOpenActions={(segment) => {
                  setActionsHighlightId(undefined)
                  setActionsInitialSegment(segment ?? 'actions')
                  setActionsOpen(true)
                }}
              />
            </ErrorBoundary>
          )}
          {activeSpace === 'plan' && (
            <ErrorBoundary label="Plan">
              <planTabConfig.Component trip={trip} focus={planFocus} onNavigate={(tabId) => setActiveSpace(LEGACY_TAB_TO_SPACE[tabId] ?? 'plan')} />
            </ErrorBoundary>
          )}
          {activeSpace === 'money' && (
            <ErrorBoundary label="Money">
              <MoneySpace
                key={moneyInitialScreen.nonce}
                trip={trip}
                initialScreen={moneyInitialScreen.screen}
                initialConfirmId={moneyConfirm.id}
              />
            </ErrorBoundary>
          )}
          {activeSpace === 'people' && (
            <ErrorBoundary label="People">
              <peopleTabConfig.Component tripId={trip.id} />
            </ErrorBoundary>
          )}
        </div>
      </AppShell>

      {/* Ask AI sheet — header button opens this; lazy-mounted on first open.
          Matches the recap panel's Skeleton fallback below rather than a
          blank flash. (LazyChatSheet also wraps its lazy chunk in its own
          inner Suspense — see features/chat/index.tsx — so this outer one is
          a belt-and-suspenders fallback for the boundary closest to the
          mount site.) */}
      {chatOpen && (
        <Suspense fallback={<Skeleton variant="card" height={420} />}>
          <LazyChatSheet trip={trip} isOpen={chatOpen} onClose={() => setChatOpen(false)} context={chatContext} />
        </Suspense>
      )}

      {/* Organizer Console — a full-screen sheet now, launched from Today's
          blockers strip, the header overflow and the desktop sidebar. */}
      {isOrganizer && consoleOpen && (
        <Modal isOpen={consoleOpen} onClose={() => setConsoleOpen(false)} size="xl" title="Organizer console">
          <ErrorBoundary label="Console">
            <OrganizerConsole tripId={trip.id} initialView="waiting" />
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

      {/* Actions sheet — trip to-dos + the packing/bring list, launched from
          Today's Your to-dos card. */}
      {actionsOpen && (
        <ActionsSheet isOpen={actionsOpen} onClose={() => setActionsOpen(false)} tripId={trip.id} isOrganizer={isOrganizer} initialSegment={actionsInitialSegment} highlightId={actionsHighlightId} />
      )}

      {/* ?open=question:<id> / answer-all: the focused answer flow, mounted here so
          a to-do link lands on the exact question without going through the
          Plan lens first. Unmounts on close so it restarts at question 1. */}
      {answerSectionIds && (
        <AnswerFlow
          isOpen
          onClose={() => setAnswerSectionIds(null)}
          trip={trip}
          sections={(sectionsData ?? []).filter((sec) => answerSectionIds.includes(sec.id))}
        />
      )}

      {/* ?open=decide:<id> / book:<optionId>: the Manage sheet for that question, opened
          straight into the Decide / Mark booked step (home view if the step no longer applies). */}
      {manageRequest && isOrganizer && (
        <QuestionManageSheet
          isOpen
          onClose={() => setManageRequest(null)}
          tripId={trip.id}
          sectionId={manageRequest.sectionId}
          initialChild={manageRequest.mode === 'decide' ? 'decide' : 'booking'}
          initialOptionId={manageRequest.optionId}
        />
      )}

      {/* ?open=payment:<id> for a payment the viewer still has to make. */}
      {markPaidSettlementId && (
        <MarkPaidSheet
          isOpen
          onClose={() => setMarkPaidSettlementId(null)}
          settlement={settlementsData?.find((st) => st.id === markPaidSettlementId) ?? null}
          tripId={trip.id}
          toName={nameOf(participants, settlementsData?.find((st) => st.id === markPaidSettlementId)?.to_user_id)}
        />
      )}

      {/* FAB targets */}
      {canAdd && <AddToPlanSheet isOpen={addToPlanOpen} onClose={() => setAddToPlanOpen(false)} trip={trip} defaultIsVote={addToPlanAsQuestion} />}

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

      {/* Add expense sheet (scan a receipt or enter it yourself), remounted with a fresh
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
      <CreateTripWizard isOpen={editModalOpen} onClose={() => setEditModalOpen(false)} onSuccess={refetchTripData} editTrip={trip} />
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

function nameOf(participants: ParticipantWithUser[], userId: string | undefined): string {
  const p = participants.find((x) => x.user_id === userId)
  return p?.user.full_name?.split(' ')[0] || 'them'
}

// Smart date formatting: only repeat month/year when they differ
function formatDateRange(startDate: string, endDate: string) {
  const start = new Date(startDate)
  const end = new Date(endDate)

  const startMonth = start.toLocaleDateString('en-GB', { month: 'short' })
  const endMonth = end.toLocaleDateString('en-GB', { month: 'short' })
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
function getCountdown(startDate: string, endDate: string): string | null {
  const now = new Date()
  const diffDays = daysUntil(startDate, now)

  if (new Date(endDate).getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    return null // the stage label next to the rail already says "Finished"
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
