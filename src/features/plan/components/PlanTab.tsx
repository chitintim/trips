import { Suspense, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, SegmentedControl, Skeleton } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { inScopeHeadcount } from '../../people/lib/inScopePeople'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useCreateSection } from '../../../lib/queries/usePlanning'
import { lazyWithRetry } from '../../../lib/lazyWithRetry'
import { usePlanItems } from '../lib/usePlanItems'
import type { PlanItem } from '../lib/planItems'
import { PlanBoard } from './PlanBoard'
import { QuestionsView } from './QuestionsView'
import { useQuestionList } from '../lib/useQuestionList'
import { daysBannerText, defaultLens, type PlanLens } from '../lib/questionsModel'
import { PlanItemSheet } from './PlanItemSheet'
import { AddToPlanSheet } from './AddToPlanSheet'
import { ScheduleItSheet } from './ScheduleItSheet'
import { OrganizeSheet } from './OrganizeSheet'
import type { Trip } from '../../../types'

/**
 * Starter questions offered to organizers on a completely empty plan
 * (section machinery stays hidden: users see the questions).
 */
const STARTER_QUESTIONS: Array<{
  title: string
  section_type: 'accommodation' | 'transport' | 'activities'
}> = [
  { title: 'Where are we staying?', section_type: 'accommodation' },
  { title: 'How are we getting there?', section_type: 'transport' },
  { title: 'What do we want to do?', section_type: 'activities' },
]

// The Map lens pulls in react-leaflet/leaflet (~2.7MB). Now that the Plan
// space is wired eagerly into TripDetail (v2.1 four-space nav), the lens is
// lazy-loaded so leaflet stays out of the main chunk until a user actually
// switches to Map — same treatment TripMapTab always had.
const LazyPlanMapLens = lazyWithRetry(() => import('./PlanMapLens').then((m) => ({ default: m.PlanMapLens })))

/** A deep-link hand-off from the shell: open an item's sheet, or scroll to / highlight a question's card. `nonce` re-fires the same target. */
export interface PlanFocus {
  kind: 'item' | 'question'
  id: string
  nonce: number
}

export interface PlanTabProps {
  trip: Trip
  /** `?open=item:<id>` / `?open=question:<id>` (decided question) target. */
  focus?: PlanFocus | null
  /** Cross-space links, e.g. tapping a linked-expense chip to jump to Money. */
  onNavigate?: (tabId: string, params?: { expenseId?: string }) => void
}

/**
 * The unified Plan surface: Questions · Days · Map via a sticky segmented
 * control, with one detail sheet and one creation sheet shared across them.
 * Questions is the opening lens while the viewer owes an answer, otherwise
 * Days (chosen once per mount, so answering the last question does not yank
 * the viewer off the list).
 */
export function PlanTab({ trip, focus = null, onNavigate }: PlanTabProps) {
  const { data: participants } = useParticipants(trip.id)
  const { items, isLoading, isError, refetch } = usePlanItems(trip.id)

  const questionList = useQuestionList(trip)
  const createSection = useCreateSection(trip.id)
  const [creatingStarters, setCreatingStarters] = useState(false)
  const [lensChoice, setLensChoice] = useState<PlanLens | null>(null)
  const questionsReady = !questionList.isLoading
  // First settled data picks the opening lens; after that only the viewer (or a deep link) changes it.
  const lens: PlanLens = lensChoice ?? (questionsReady ? defaultLens(questionList.groups) : 'days')
  useEffect(() => {
    if (lensChoice === null && questionsReady) setLensChoice(defaultLens(questionList.groups))
  }, [lensChoice, questionsReady, questionList.groups])
  const setLens = setLensChoice
  const [selectedItem, setSelectedItem] = useState<PlanItem | null>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [addSheetDefaultIsVote, setAddSheetDefaultIsVote] = useState(false)
  const [scheduleItem, setScheduleItem] = useState<PlanItem | null>(null)
  const [organizeOpen, setOrganizeOpen] = useState(false)

  // Deep link -> item: open its sheet once the plan has loaded. A question
  // target needs the Questions lens, where its card lives (QuestionsView highlights it).
  const [handledNonce, setHandledNonce] = useState(0)
  useEffect(() => {
    if (!focus || isLoading || focus.nonce === handledNonce) return
    setHandledNonce(focus.nonce)
    if (focus.kind === 'question') {
      setLens('questions')
      return
    }
    const match = items.find((i) => i.id === focus.id || i.optionId === focus.id || i.eventId === focus.id)
    if (match) setSelectedItem(match)
  }, [focus, isLoading, items, handledNonce, setLens])

  const openAddSheet = (defaultIsVote = false) => {
    setAddSheetDefaultIsVote(defaultIsVote)
    setAddSheetOpen(true)
  }

  const { canManageTrip: isOrganizer } = useTripPermissions(trip)
  const headcount = useMemo(() => inScopeHeadcount(participants || [], isConfirmationEnabled(trip)), [participants, trip])

  const handleCreateStarterQuestions = async () => {
    setCreatingStarters(true)
    try {
      for (const [i, q] of STARTER_QUESTIONS.entries()) {
        await createSection.mutateAsync({
          title: q.title,
          section_type: q.section_type,
          status: 'in_progress',
          order_index: i,
        })
      }
    } finally {
      setCreatingStarters(false)
    }
  }

  // "Put it on the plan" from a question's Manage sheet: find the decided option's plan item and open the scheduler.
  const handleScheduleOption = (_sectionId: string, optionId: string) => {
    const match = items.find((i) => i.optionId === optionId)
    if (!match) return
    setSelectedItem(null)
    setScheduleItem(match)
  }

  const handleNavigateToExpense = (expenseId: string) => {
    setSelectedItem(null)
    onNavigate?.('money', { expenseId })
  }

  if (isLoading || (lensChoice === null && !questionsReady)) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<ErrorState className="w-24 h-24 text-danger-500" />}
          title="Couldn't load the plan"
          description="Something went wrong fetching this trip's plan. Check your connection and try again."
          action={
            <Button variant="primary" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    )
  }

  const needsAnswer = questionList.groups.needsAnswerCount
  const banner = daysBannerText(needsAnswer)

  return (
    <div className="relative space-y-4 p-4 max-w-3xl mx-auto">
      <div className="sticky top-0 z-30 -mx-4 px-4 pb-2 bg-[var(--surface-page)]/95 backdrop-blur-sm flex items-center justify-between gap-3">
        <SegmentedControl
          value={lens}
          onChange={(v) => setLens(v)}
          options={[
            { value: 'questions', label: 'Questions', badge: needsAnswer },
            { value: 'days', label: 'Days' },
            { value: 'map', label: 'Map' },
          ]}
        />
        {isOrganizer && (
          <Button size="sm" variant="secondary" onClick={() => setOrganizeOpen(true)}>
            ✨ Organize
          </Button>
        )}
      </div>

      {lens === 'questions' && (
        <QuestionsView
          trip={trip}
          list={questionList}
          canManage={isOrganizer}
          onSchedule={handleScheduleOption}
          highlight={focus?.kind === 'question' ? { id: focus.id, nonce: focus.nonce } : null}
          onAsk={() => openAddSheet(true)}
          onCreateStarters={handleCreateStarterQuestions}
          creatingStarters={creatingStarters}
          starterTitles={STARTER_QUESTIONS.map((q) => q.title)}
        />
      )}
      {lens === 'days' && (
        <>
          {banner && (
            <button
              type="button"
              onClick={() => setLens('questions')}
              className="w-full text-left rounded-[var(--radius-lg)] border border-accent-300 bg-accent-50 dark:bg-accent-950/30 px-3 py-2 text-sm font-medium text-accent-700 dark:text-accent-400"
            >
              {banner}
            </button>
          )}
          <PlanBoard trip={trip} items={items} isOrganizer={isOrganizer} onOpenItem={setSelectedItem} />
        </>
      )}
      {lens === 'map' && (
        <Suspense fallback={<Skeleton variant="card" height={420} />}>
          <LazyPlanMapLens trip={trip} items={items} onOpenItem={setSelectedItem} />
        </Suspense>
      )}

      <PlanItemSheet
        isOpen={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        trip={trip}
        item={selectedItem}
        isOrganizer={isOrganizer}
        headcount={headcount}
        onNavigateToExpense={onNavigate ? handleNavigateToExpense : undefined}
        onScheduleOption={handleScheduleOption}
        onScheduleIt={(item) => {
          setSelectedItem(null)
          setScheduleItem(item)
        }}
      />

      {isOrganizer && <AddToPlanSheet isOpen={addSheetOpen} onClose={() => setAddSheetOpen(false)} trip={trip} defaultIsVote={addSheetDefaultIsVote} />}

      <ScheduleItSheet isOpen={!!scheduleItem} onClose={() => setScheduleItem(null)} trip={trip} item={scheduleItem} />

      {isOrganizer && <OrganizeSheet isOpen={organizeOpen} onClose={() => setOrganizeOpen(false)} trip={trip} />}
    </div>
  )
}
