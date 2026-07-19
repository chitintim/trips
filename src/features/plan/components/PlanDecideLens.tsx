import { useMemo, useState } from 'react'
import { Badge, Button, Deadline, EmptyState, Skeleton } from '../../../components/ui'
import { NothingToDecide, ErrorState } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { useParticipants } from '../../../lib/queries/useTrip'
import { DecisionOutcomePanel } from '../../decisions/components/DecisionOutcomePanel'
import { getDecisionShape, sectionHasCatalogPricing } from '../../decisions/lib/decisionShapes'
import { votingInstruction, type VotingMethod } from '../../decisions/lib/voting'
import { computeQuestionState, formatEntryCardLabel, type QuestionState } from '../lib/responseState'
import { AnswerFlow } from './AnswerFlow'
import { OrderFormSheet } from './OrderFormSheet'
import { ConsolidatedOrdersSheet } from './ConsolidatedOrdersSheet'
import type { PlanItem } from '../lib/planItems'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { Trip } from '../../../types'

export interface PlanDecideLensProps {
  trip: Trip
  /** The composed plan items (from PlanTab's usePlanItems) — used to hand the winning option to ScheduleItSheet. */
  items: PlanItem[]
  isOrganizer: boolean
  /** Opens PlanTab's shared ScheduleItSheet ("put it on the plan"). */
  onScheduleIt: (item: PlanItem) => void
}

/**
 * Decide lens, rebuilt into the trip's decisions dashboard (it previously
 * rendered ONLY a "N things need you" entry card, so a user who had already
 * voted saw a bare "Nothing needs deciding" — the tab looked dead):
 *
 *  1. The focused answer flow entry card (unchanged) when anything needs
 *     the viewer.
 *  2. Every OPEN question: response state, "X of Y" progress, pick-one vs
 *     pick-multiple instruction, deadline — and the organizer's
 *     close-the-decision flow (DecisionOutcomePanel → CloseDecisionSheet).
 *  3. Every DECIDED question: the outcome banner with its consequences
 *     (scheduled event / "Schedule it" / linked follow-up action).
 */
export function PlanDecideLens({ trip, items, isOrganizer, onScheduleIt }: PlanDecideLensProps) {
  const { user } = useAuth()
  const sectionsQuery = useSections(trip.id)
  const votesQuery = useVotes(trip.id)
  const participantsQuery = useParticipants(trip.id)
  const { data: sections, isLoading: sectionsLoading, isError: sectionsError } = sectionsQuery
  const { data: votes, isLoading: votesLoading, isError: votesError } = votesQuery
  const { data: participants, isLoading: participantsLoading, isError: participantsError } = participantsQuery
  const { data: events } = useTimeline(trip.id)
  const [flowOpen, setFlowOpen] = useState(false)
  const [orderFormSectionId, setOrderFormSectionId] = useState<string | null>(null)
  const [consolidatedOrdersSectionId, setConsolidatedOrdersSectionId] = useState<string | null>(null)

  const confirmedCount = (participants || []).filter((p) => p.confirmation_status === 'confirmed').length

  const questionStates = useMemo(() => {
    const map = new Map<string, QuestionState>()
    for (const s of sections || []) {
      map.set(s.id, computeQuestionState(s, votes || [], (participants || []).length, user?.id ?? null, trip.base_currency))
    }
    return map
  }, [sections, votes, participants, user?.id, trip.base_currency])

  const withOptions = useMemo(
    () => (sections || []).filter((s) => s.options.some((o) => o.status !== 'cancelled')),
    [sections]
  )
  const openQuestions = useMemo(() => withOptions.filter((s) => s.status !== 'completed'), [withOptions])
  const decidedQuestions = useMemo(() => withOptions.filter((s) => s.status === 'completed'), [withOptions])

  const needsMe = useMemo(
    () => openQuestions.filter((s) => questionStates.get(s.id)?.state === 'needs_you'),
    [openQuestions, questionStates]
  )

  // Loading gate (UPGRADE_MASTER_PLAN.md audit item 3): without this, the
  // "nothing needs deciding" empty state briefly flashed while sections/
  // votes/participants were still in flight.
  if (sectionsLoading || votesLoading || participantsLoading) {
    return (
      <div className="space-y-3">
        <Skeleton variant="card" height={140} />
      </div>
    )
  }

  if (sectionsError || votesError || participantsError) {
    return (
      <EmptyState
        icon={<ErrorState className="w-24 h-24 text-danger-500" />}
        title="Couldn't load what needs deciding"
        description="Something went wrong. Check your connection and try again."
        action={
          <Button
            variant="primary"
            onClick={() => {
              sectionsQuery.refetch()
              votesQuery.refetch()
              participantsQuery.refetch()
            }}
          >
            Retry
          </Button>
        }
      />
    )
  }

  if (openQuestions.length === 0 && decidedQuestions.length === 0) {
    return (
      <EmptyState
        icon={<NothingToDecide className="w-32 h-24 text-[var(--text-muted)]" />}
        title="Nothing to decide yet"
        description="Open questions from the Plan (group votes and personal picks) show up here, along with what got decided."
      />
    )
  }

  const scheduleOption = (optionId: string) => {
    const target = items.find((i) => i.optionId === optionId)
    if (target) onScheduleIt(target)
  }

  return (
    <div className="space-y-5">
      {needsMe.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setFlowOpen(true)}
            className="w-full text-left rounded-[var(--radius-xl)] border border-accent-300 bg-accent-50 dark:bg-accent-950/30 p-5 hover:border-accent-400 transition-colors"
          >
            <p className="text-lg font-semibold text-[var(--text-primary)]">{formatEntryCardLabel(needsMe.length)}</p>
            <span className="inline-block mt-3 text-sm font-medium text-accent-700 dark:text-accent-400">Start →</span>
          </button>

          <AnswerFlow
            isOpen={flowOpen}
            onClose={() => setFlowOpen(false)}
            trip={trip}
            sections={needsMe}
            votes={votes || []}
            participants={participants || []}
            confirmedCount={confirmedCount}
          />
        </>
      )}

      {openQuestions.length > 0 && (
        <section aria-label={`Open questions (${openQuestions.length})`} className="space-y-2">
          {/* Explicit count ("two open questions" clarity ask) so N cards can
              never read as one undifferentiated block. */}
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">❔ Open questions ({openQuestions.length})</h3>
          {openQuestions.map((section) => (
            <QuestionCard
              key={section.id}
              trip={trip}
              section={section}
              state={questionStates.get(section.id)}
              isOrganizer={isOrganizer}
              votes={votesQuery.data || []}
              participants={participants || []}
              events={events || []}
              onScheduleOption={scheduleOption}
              onFillOrder={() => setOrderFormSectionId(section.id)}
              onViewOrders={() => setConsolidatedOrdersSectionId(section.id)}
            />
          ))}
        </section>
      )}

      {decidedQuestions.length > 0 && (
        <section aria-label="Decided" className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">🏁 Decided</h3>
          {openQuestions.length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">Every open question has been answered or closed. Nice work.</p>
          )}
          {decidedQuestions.map((section) => (
            <QuestionCard
              key={section.id}
              trip={trip}
              section={section}
              state={questionStates.get(section.id)}
              isOrganizer={isOrganizer}
              votes={votesQuery.data || []}
              participants={participants || []}
              events={events || []}
              onScheduleOption={scheduleOption}
              onFillOrder={() => setOrderFormSectionId(section.id)}
              onViewOrders={() => setConsolidatedOrdersSectionId(section.id)}
            />
          ))}
        </section>
      )}

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
    </div>
  )
}

interface QuestionCardProps {
  trip: Trip
  section: SectionWithOptions
  state: QuestionState | undefined
  isOrganizer: boolean
  votes: NonNullable<ReturnType<typeof useVotes>['data']>
  participants: NonNullable<ReturnType<typeof useParticipants>['data']>
  events: NonNullable<ReturnType<typeof useTimeline>['data']>
  onScheduleOption: (optionId: string) => void
  onFillOrder: () => void
  onViewOrders: () => void
}

function QuestionCard({
  trip,
  section,
  state,
  isOrganizer,
  votes,
  participants,
  events,
  onScheduleOption,
  onFillOrder,
  onViewOrders,
}: QuestionCardProps) {
  const isPersonal = getDecisionShape(section.metadata) === 'personal'
  const hasCatalogPricing = isPersonal ? sectionHasCatalogPricing(section.options) : false
  const isClosed = section.status === 'completed'
  const method = (section.voting_method as VotingMethod) || 'single'
  const activeOptionCount = section.options.filter((o) => o.status !== 'cancelled').length

  return (
    <div className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h4 className="min-w-0 break-words text-sm font-medium text-[var(--text-primary)]">{section.title}</h4>
            {!isClosed && state && (
              <Badge variant={state.state === 'done' ? 'success' : 'warning'} size="sm">
                {state.label}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
            <p className="text-xs text-[var(--text-muted)]">
              {isPersonal
                ? `${state?.respondedCount ?? 0} of ${state?.totalParticipants ?? 0} ${hasCatalogPricing ? 'ordered' : 'have picked'}`
                : isClosed
                  ? `${activeOptionCount} option${activeOptionCount === 1 ? '' : 's'}`
                  : `${activeOptionCount} option${activeOptionCount === 1 ? '' : 's'} · ${votingInstruction(method)} · ${
                      state?.respondedCount ?? 0
                    } of ${state?.totalParticipants ?? 0} voted`}
            </p>
            {!isClosed && section.vote_deadline && <Deadline date={section.vote_deadline} kind="vote" compact size="sm" />}
          </div>
        </div>
      </div>

      {isPersonal ? (
        !isClosed && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="secondary" size="sm" onClick={onFillOrder}>
              {state?.state === 'done' ? 'Edit your order' : 'Fill in your order'}
            </Button>
            {isOrganizer && (
              <Button variant="outline" size="sm" onClick={onViewOrders}>
                View orders
              </Button>
            )}
          </div>
        )
      ) : (
        <DecisionOutcomePanel
          tripId={trip.id}
          section={section}
          votes={votes}
          participants={participants}
          isOrganizer={isOrganizer}
          events={events}
          onScheduleOption={onScheduleOption}
        />
      )}
    </div>
  )
}
