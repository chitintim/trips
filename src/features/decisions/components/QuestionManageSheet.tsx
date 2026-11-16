import { useMemo, useState } from 'react'
import { Badge, Button, Modal, useToast } from '../../../components/ui'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useQuestionPasses, useSections, useVotes } from '../../../lib/queries/usePlanning'
import { isTripFinished } from '../../../lib/answers/answers'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { useBookings } from '../../../lib/queries/useBookings'
import { useActions } from '../../../lib/queries/useActions'
import { BookingEditorSheet } from '../../organizer/components/BookingEditorSheet'
import { NudgeDraftSheet } from '../../organizer/components/NudgeDraftSheet'
import type { Blocker } from '../../organizer/lib/blockers'
import { readFollowupActionId, resolveDecidedOptionId } from '../lib/closeDecision'
import { isIdeasBucket } from '../../../lib/ideasBucket'
import { planInitialChild, type ManageInitialChild } from '../lib/manageInitialChild'
import { getManageActions, type ManageAction } from '../lib/manageActions'
import { eventCategoryForSection, readOptionPlanDate } from '../lib/decideSheetModel'
import { useQuestionAnswers } from '../lib/useQuestionAnswers'
import { useDeleteQuestion } from '../lib/useDeleteQuestion'
import { CARD_CHIP } from '../lib/questionCardModel'
import { CLOSED_NO_DECISION } from '../lib/answerCopy'
import { participantName } from '../lib/everyonesAnswers'
import { DecideSheet } from './DecideSheet'
import { MarkBookedSheet } from './MarkBookedSheet'
import { PutOnPlanSheet } from './PutOnPlanSheet'
import { SectionEditorSheet } from './SectionEditorSheet'
import { OptionEditorSheet } from './OptionEditorSheet'
import { ReopenDecisionDialog } from './ReopenDecisionDialog'
import { AddTodoSheet } from './AddTodoSheet'
import { EveryonesAnswers } from './EveryonesAnswers'
import { getDecisionShape } from '../lib/decisionShapes'

export interface QuestionManageSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  sectionId: string
  /**
   * Open straight into a step (the "Decide: X" / "Book: X" to-dos and their links):
   * `decide` = Decide (or Close answers); `booking` = Mark booked for `initialOptionId`
   * (default: the decided option). When the step no longer makes sense the sheet
   * simply opens on its home view.
   */
  initialChild?: ManageInitialChild
  initialOptionId?: string | null
}

type Child = null | 'decide' | 'schedule' | 'mark_booked' | 'unmark_booked' | 'settings' | 'add_option' | 'reopen' | 'delete' | 'add_todo' | 'booking' | 'nudge_pick' | 'nudge_draft'
type View = 'home' | 'answers' | 'nudge'

/**
 * The ONE place an organiser (admins and trip creators included) manages a
 * question. Compact header (question, state, "N of M answered", deadline)
 * then the actions that make sense for its state (see manageActions.ts):
 *
 *   Open     Decide · See everyone's answers · Nudge · Question settings · Add option · Delete
 *   Decided  outcome · Put it on the plan · Add a to-do · Mark booked · Settings · Reopen · Delete
 *   Booked   read-only summary · See everyone's answers · Track booking · Not booked after all · Reopen
 *
 * Renders nothing for people who cannot manage the trip.
 */
export function QuestionManageSheet({ isOpen, onClose, tripId, sectionId, initialChild, initialOptionId }: QuestionManageSheetProps) {
  const { data: trip } = useTrip(tripId)
  const { data: sections } = useSections(tripId)
  const section = useMemo(() => (sections ?? []).find((s) => s.id === sectionId) ?? null, [sections, sectionId])
  if (!trip || !section) return null
  return <ManageBody isOpen={isOpen} onClose={onClose} tripId={tripId} section={section} trip={trip} initialChild={initialChild} initialOptionId={initialOptionId} />
}

function ManageBody({
  isOpen,
  onClose,
  tripId,
  section,
  trip,
  initialChild,
  initialOptionId,
}: {
  initialChild?: ManageInitialChild
  initialOptionId?: string | null
  isOpen: boolean
  onClose: () => void
  tripId: string
  section: NonNullable<ReturnType<typeof useSections>['data']>[number]
  trip: NonNullable<ReturnType<typeof useTrip>['data']>
}) {
  const { showToast } = useToast()
  const { canManageTrip } = useTripPermissions(trip)
  const { data: participantsData } = useParticipants(tripId)
  const participants = useMemo(() => participantsData ?? [], [participantsData])
  const { data: votesData } = useVotes(tripId)
  const votes = useMemo(() => votesData ?? [], [votesData])
  const { passes } = useQuestionPasses(tripId)
  const { data: events } = useTimeline(tripId)
  const { data: bookings } = useBookings(tripId)
  const { data: actions } = useActions(tripId)
  const deleteQuestion = useDeleteQuestion(tripId)

  const [view, setView] = useState<View>('home')
  const [child, setChild] = useState<Child>(null)
  const [bookOptionId, setBookOptionId] = useState<string | null>(null)
  const [initialApplied, setInitialApplied] = useState(false)
  const [nudgeTarget, setNudgeTarget] = useState<{ userId: string; name: string } | null>(null)

  const liveBookings = useMemo(() => (bookings ?? []).filter((b) => b.status !== 'cancelled'), [bookings])
  const bookedOptionIds = useMemo(() => new Set(liveBookings.map((b) => b.option_id).filter((x): x is string => !!x)), [liveBookings])
  const { card } = useQuestionAnswers(trip, section, { bookedOptionIds })

  const decidedOptionId = card.decided?.optionId ?? (section.status === 'completed' ? resolveDecidedOptionId(section, votes) : null)
  const decidedOption = decidedOptionId ? section.options.find((o) => o.id === decidedOptionId) ?? null : null
  const booking = decidedOptionId ? liveBookings.find((b) => b.option_id === decidedOptionId) ?? null : null
  const scheduledEvent = decidedOptionId ? (events ?? []).find((e) => e.source_option_id === decidedOptionId) ?? null : null
  const followupId = readFollowupActionId(section.metadata)
  const followup = followupId ? (actions ?? []).find((a) => a.id === followupId) ?? null : null
  const shape = card.shape
  const liveOptions = section.options.filter((o) => o.status !== 'cancelled')

  const available = getManageActions({
    canManage: canManageTrip,
    stage: card.stage,
    finished: isTripFinished(trip),
    shape,
    hasOptions: liveOptions.length > 0,
    waitingCount: Math.max(card.counts.total - card.counts.answered, 0),
    hasWinner: !!decidedOption,
    onThePlan: !!scheduledEvent,
    hasFollowupTodo: !!followup,
    hasBooking: !!booking,
    ideas: isIdeasBucket(section),
  })

  // Apply the requested first step once, as soon as we know the viewer can manage the trip.
  if (!initialApplied && canManageTrip) {
    setInitialApplied(true)
    const planned = planInitialChild({
      initialChild,
      initialOptionId,
      canManage: canManageTrip,
      finished: isTripFinished(trip),
      section: {
        status: section.status,
        options: section.options.map((o) => ({ id: o.id, status: o.status })),
        own: shape === 'own',
        decidedOptionId: decidedOption?.id ?? null,
      },
    })
    if (planned.child === 'decide') setChild('decide')
    else if (planned.child === 'mark_booked') {
      setBookOptionId(planned.optionId)
      setChild('mark_booked')
    }
  }

  if (!canManageTrip) return null

  const markBookedOption = (() => {
    const o = bookOptionId ? section.options.find((x) => x.id === bookOptionId) : null
    const target = o ?? decidedOption
    return target ? { id: target.id, title: target.title } : null
  })()

  const stageLabel = card.stage === 'booked' ? CARD_CHIP.booked : card.stage === 'decided' ? CARD_CHIP.decided : card.stage === 'closed' ? CLOSED_NO_DECISION : 'Open'
  const stageTone = card.stage === 'booked' || card.stage === 'decided' ? 'success' : card.stage === 'closed' ? 'neutral' : 'info'

  const closeChild = () => setChild(null)
  const finishAndClose = () => {
    setChild(null)
    setView('home')
    onClose()
  }

  const waitingPeople = (() => {
    const waitingIds = new Set(
      participants
        .filter((p) => p.active !== false && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled')
        .map((p) => p.user_id)
    )
    for (const id of [...waitingIds]) {
      const answered = votes.some((v) => v.user_id === id && section.options.some((o) => o.id === v.option_id))
      const selected = section.options.some((o) => o.selections.some((s) => s.user_id === id))
      const passed = passes.some((p) => p.section_id === section.id && p.user_id === id)
      if (answered || selected || passed) waitingIds.delete(id)
    }
    return participants.filter((p) => waitingIds.has(p.user_id)).map((p) => ({ userId: p.user_id, name: participantName(p) }))
  })()

  const nudgeBlocker: Blocker | null = nudgeTarget
    ? {
        kind: shape === 'own' ? 'unfilled_order' : 'unvoted_poll',
        userId: nudgeTarget.userId,
        label: `Answer: ${section.title}`,
        detail: `Answer: ${section.title}.`,
        entityId: section.id,
        deadline: section.vote_deadline,
        nudgeType: 'unvoted_poll',
      }
    : null

  const run = (a: ManageAction) => {
    switch (a.id) {
      case 'decide':
        return setChild('decide')
      case 'answers':
        return setView('answers')
      case 'nudge':
        return setView('nudge')
      case 'settings':
        return setChild('settings')
      case 'add_option':
        return setChild('add_option')
      case 'delete':
        return setChild('delete')
      case 'schedule':
        return setChild('schedule')
      case 'mark_booked':
        setBookOptionId(null)
        return setChild('mark_booked')
      case 'unmark_booked':
        return setChild('unmark_booked')
      case 'add_todo':
        return setChild('add_todo')
      case 'booking':
        return setChild('booking')
      case 'reopen':
        return setChild('reopen')
    }
  }

  const handleDelete = async () => {
    try {
      await deleteQuestion.mutateAsync(section.id)
      showToast({ type: 'success', message: 'Question deleted', description: section.title })
      finishAndClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete the question', description: (err as Error).message })
    }
  }

  const homeOpen = isOpen && child === null
  const title = view === 'answers' ? 'Everyone’s answers' : view === 'nudge' ? 'Nudge people' : 'Manage question'

  return (
    <>
      <Modal isOpen={homeOpen} onClose={onClose} size="md" title={title}>
        <div className="space-y-4">
          <header className="min-w-0 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 break-words text-base font-semibold text-[var(--text-primary)]">{section.title}</h3>
              <Badge variant={stageTone} size="sm">
                {stageLabel}
              </Badge>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {[card.counts.label, card.deadline?.label].filter(Boolean).join(' · ')}
            </p>
            {decidedOption && (
              <p className="min-w-0 break-words text-sm font-medium text-[var(--text-primary)]">
                <span aria-hidden="true">✅ </span>
                {decidedOption.title}
              </p>
            )}
            {card.stage !== 'open' && shape === 'own' && card.ownClosedLabel && <p className="text-sm font-medium text-[var(--text-primary)]">{card.ownClosedLabel}</p>}
          </header>

          {view !== 'home' && (
            <Button variant="ghost" size="sm" onClick={() => setView('home')}>
              <span aria-hidden="true">← </span>Back to Manage
            </Button>
          )}

          {view === 'home' && (
            <>
              {(scheduledEvent || followup || booking) && (
                <div className="flex flex-wrap items-center gap-1.5" aria-label="What has been done with this answer">
                  {scheduledEvent && (
                    <Badge variant="success" size="sm" wrap>
                      📅 On the plan ·{' '}
                      {new Date(`${scheduledEvent.event_date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Badge>
                  )}
                  {followup && (
                    <Badge variant={followup.completed_at ? 'success' : 'neutral'} size="sm" wrap>
                      {followup.completed_at ? '✅' : '☑️'} {followup.title}
                    </Badge>
                  )}
                  {booking && (
                    <Badge variant="success" size="sm" wrap>
                      🧾 Booked{booking.confirmation_ref ? ` · ref ${booking.confirmation_ref}` : ''}
                    </Badge>
                  )}
                </div>
              )}

              {available.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">Only organizers can manage a question.</p>
              ) : (
                <ul className="space-y-2" aria-label="Question actions">
                  {available.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => run(a)}
                        className={`flex w-full min-w-0 flex-col items-start rounded-[var(--radius-lg)] border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 ${
                          a.tone === 'primary'
                            ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/30'
                            : a.tone === 'danger'
                              ? 'border-[var(--border-default)] hover:border-error-400'
                              : 'border-[var(--border-default)] hover:border-accent-300'
                        }`}
                      >
                        <span className={`break-words text-sm font-medium ${a.tone === 'danger' ? 'text-error-600 dark:text-error-400' : 'text-[var(--text-primary)]'}`}>{a.label}</span>
                        <span className="break-words text-xs text-[var(--text-muted)]">{a.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {card.stage === 'booked' && <p className="text-xs text-[var(--text-muted)]">This question is booked, so it is read-only. Reopen it to change it.</p>}
            </>
          )}

          {view === 'answers' && (
            <EveryonesAnswers section={section} participants={participants} votes={votes} passes={passes} fallbackCurrency={trip.base_currency || 'GBP'} />
          )}

          {view === 'nudge' && (
            <div className="space-y-2">
              {waitingPeople.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">Everyone has answered.</p>
              ) : (
                <>
                  <p className="text-sm text-[var(--text-secondary)]">Pick someone to write a reminder for. You copy it and send it yourself.</p>
                  <ul className="space-y-2" aria-label="People who have not answered">
                    {waitingPeople.map((p) => (
                      <li key={p.userId} className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border-default)] p-2.5">
                        <span className="min-w-0 break-words text-sm text-[var(--text-primary)]">{p.name}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setNudgeTarget(p)
                            setChild('nudge_draft')
                          }}
                          aria-label={`Nudge ${p.name}`}
                        >
                          Nudge
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>

      <DecideSheet isOpen={isOpen && child === 'decide'} onClose={closeChild} trip={trip} section={section} />

      <PutOnPlanSheet
        isOpen={isOpen && child === 'schedule'}
        onClose={closeChild}
        trip={trip}
        target={
          decidedOption
            ? {
                optionId: decidedOption.id,
                title: decidedOption.title,
                description: decidedOption.description,
                placeId: decidedOption.place_id,
                category: eventCategoryForSection(section.section_type),
                date: readOptionPlanDate(decidedOption.metadata, section.metadata)?.date ?? null,
                startTime: readOptionPlanDate(decidedOption.metadata, section.metadata)?.startTime ?? null,
              }
            : null
        }
      />

      <MarkBookedSheet isOpen={isOpen && (child === 'mark_booked' || child === 'unmark_booked')} onClose={closeChild} trip={trip} option={markBookedOption} mode={child === 'unmark_booked' ? 'unmark' : 'mark'} />

      <SectionEditorSheet isOpen={isOpen && child === 'settings'} onClose={closeChild} tripId={tripId} section={section} />

      <OptionEditorSheet
        isOpen={isOpen && child === 'add_option'}
        onClose={closeChild}
        tripId={tripId}
        sectionId={section.id}
        option={null}
        decisionShape={getDecisionShape(section.metadata)}
      />

      <ReopenDecisionDialog isOpen={isOpen && child === 'reopen'} onClose={closeChild} tripId={tripId} section={section} decidedTitle={decidedOption?.title ?? null} />

      {decidedOption && (
        <AddTodoSheet isOpen={isOpen && child === 'add_todo'} onClose={closeChild} tripId={tripId} section={section} winnerTitle={decidedOption.title} participants={participants} />
      )}

      <BookingEditorSheet isOpen={isOpen && child === 'booking'} onClose={closeChild} trip={trip} booking={booking} initialOptionId={booking ? null : decidedOption?.id ?? null} />

      {nudgeBlocker && nudgeTarget && (
        <NudgeDraftSheet
          isOpen={isOpen && child === 'nudge_draft'}
          onClose={() => {
            setChild(null)
            setNudgeTarget(null)
          }}
          tripId={tripId}
          targetUserId={nudgeTarget.userId}
          targetName={nudgeTarget.name}
          blocker={nudgeBlocker}
        />
      )}

      <Modal isOpen={isOpen && child === 'delete'} onClose={closeChild} size="sm" title={`Delete "${section.title}"?`}>
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">
            <strong>This deletes:</strong> the question, its {liveOptions.length === 1 ? '1 option' : `${liveOptions.length} options`},{' '}
            {card.counts.answered === 0 ? 'any answers' : `everyone's answers (${card.counts.answered} of ${card.counts.total} ${card.counts.total === 1 ? 'person has' : 'people have'} answered)`}
            , and any to-do that only asks people to answer it. <strong>It cannot be undone.</strong>
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            <strong>This keeps:</strong> bookings, plan events and expenses made from its options (they stay, but are no longer linked to the question), and
            every other to-do.
          </p>
          {!deleteQuestion.deleteAvailable && (
            <p className="text-sm text-[var(--text-secondary)]">Deleting questions will be available shortly.</p>
          )}
          <div className="flex justify-end gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" onClick={closeChild} disabled={deleteQuestion.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={deleteQuestion.isPending} disabled={!deleteQuestion.deleteAvailable}>
              Delete question
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
