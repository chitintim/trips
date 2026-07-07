import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  TextArea,
  Badge,
  ConfirmationStatusBadge,
  ConditionalDependencyDisplay,
  useToast,
  Stepper,
  ConfirmDiscardSheet,
} from '../../../components/ui'
import { useTrip } from '../../../lib/queries/useTrip'
import { useUpdateConfirmationStatus, ConfirmationStatus, ConditionalType } from '../../../lib/queries/useConfirmations'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import {
  resolveImIn,
  resolveCantSayYet,
  resolveImOut,
  answerFromStatus,
  waitingOnFromStatus,
  type RsvpAnswer,
  type WaitingOnAnswer,
} from '../lib/rsvpAnswers'

// ============================================================================
// CONFIG
// ============================================================================

/**
 * RSVP: three human answers over seven statuses (UX_REDESIGN.md Part 4).
 * The participant-facing choice is ALWAYS one of these three big answers —
 * waitlist/pending are system states and never appear as choices here (see
 * ../lib/rsvpAnswers.ts for the full status mapping + rationale). Organizer
 * views (ParticipantList/DependencyGraph/WaitlistPanel) are untouched and
 * keep full 7-status fidelity — this is presentation-layer only, same
 * table, same enum.
 */
const RSVP_ANSWER_OPTIONS: Array<{ value: RsvpAnswer; emoji: string; label: string; description: string }> = [
  {
    value: 'in',
    emoji: '✅',
    label: "I'm in",
    description:
      "I'm 100% committed and ready to book. I understand others are counting on me. (Once confirmed, you cannot change your status yourself — contact the organizer.)",
  },
  {
    value: 'cant-say-yet',
    emoji: '🤔',
    label: "Can't say yet",
    description: "I need a bit more time — waiting on a date, someone else, or just thinking it over.",
  },
  {
    value: 'out',
    emoji: '❌',
    label: "I'm out",
    description: "I can't join this trip. Thanks for the invite!",
  },
]

const WAITING_ON_OPTIONS: Array<{ value: WaitingOnAnswer; label: string; description: string }> = [
  { value: 'date', label: 'A specific date', description: "I'll know by a certain date" },
  { value: 'someone', label: 'Someone else', description: "I'll confirm once specific people confirm" },
  { value: 'both', label: 'Both', description: 'A date AND specific people' },
  { value: 'just-thinking', label: 'Just thinking it over', description: "No specific blocker — I'm just not ready to commit" },
]

const COMMITMENT_TERMS = [
  'Cancellation Liability: if you cannot join after confirming, you will be liable to pay your share of the accommodation cost.',
  'Insurance: certain cancellations may be covered by travel insurance — ask the organizer for guidance.',
  'Space Transfer: you may transfer your space to someone else if needed.',
  'Substitute Finder: the group can (but is not obligated to) help find a substitute at a discounted price if you need to cancel.',
]

// ============================================================================
// COMPONENT
// ============================================================================

interface StatusModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  /** The current user's own participant row. */
  participant: ParticipantWithUser | null
  /** All participants, for the conditional-on-users picker + circular-dependency warning. */
  participants: ParticipantWithUser[]
  capacityLimit: number | null
  confirmedCount: number
}

/**
 * RSVP status picker (UX_REDESIGN.md Part 4 "RSVP: three human answers over
 * seven statuses"): step 1 is three big human choices — "I'm in" / "Can't
 * say yet" / "I'm out" — rather than the raw 7-status list. "Can't say yet"
 * branches into a follow-up ("What are you waiting on?") that resolves to
 * the existing conditional/interested machinery; "I'm out" resolves to
 * declined (or a self-service cancellation, replacing the old
 * organizer-contact dead-end, when the participant was previously
 * confirmed — same warning copy as before). Same enum/table throughout —
 * presentation only. Keeps the Form & Flow Standard (draft handling here is
 * deliberately disabled, see below) and the note/review step.
 *
 * IMPORTANT server-authoritative behavior: a BEFORE UPDATE trigger
 * (enforce_capacity_limit) on trip_participants can silently rewrite a
 * requested 'confirmed' status to 'waitlist' (with an auto-note) if the
 * trip is at capacity, and sets/clears confirmed_at itself — the client
 * must never assume the requested status stuck. After the mutation
 * settles we always refetch (React Query invalidation already does this)
 * and compare the *server's* resulting status against what was requested,
 * surfacing a reconciliation message if they differ instead of just
 * closing on the optimistic value.
 */
interface StatusFormValues {
  /** The step-1 human answer. Null until the participant picks one (or one is inferred from an existing record on open). */
  answer: RsvpAnswer | null
  /** The "Can't say yet" follow-up choice. */
  waitingOn: WaitingOnAnswer | null
  conditionalDate: string
  conditionalUserIds: string[]
  note: string
  agreedToTerms: boolean
}

function seedFromParticipant(participant: ParticipantWithUser | null): StatusFormValues {
  const status = (participant?.confirmation_status as ConfirmationStatus) || 'pending'
  const conditionalType = (participant?.conditional_type as ConditionalType) || 'none'
  return {
    answer: answerFromStatus(status),
    waitingOn: waitingOnFromStatus(status, conditionalType),
    conditionalDate: participant?.conditional_date || '',
    conditionalUserIds: participant?.conditional_user_ids || [],
    note: participant?.confirmation_note || '',
    agreedToTerms: false,
  }
}

/** Resolves the form's current answer/waitingOn selection into the actual status + conditionalType to write. */
function resolveStatus(values: StatusFormValues, wasConfirmed: boolean): { status: ConfirmationStatus; conditionalType: ConditionalType } {
  if (values.answer === 'in') return resolveImIn()
  if (values.answer === 'out') return resolveImOut(wasConfirmed)
  if (values.answer === 'cant-say-yet' && values.waitingOn) return resolveCantSayYet(values.waitingOn)
  return { status: 'pending', conditionalType: 'none' }
}

type Step = 'answer' | 'waiting-on' | 'condition-detail' | 'review'

export function StatusModal({
  isOpen,
  onClose,
  tripId,
  participant,
  participants,
  capacityLimit,
  confirmedCount,
}: StatusModalProps) {
  const { data: trip } = useTrip(tripId)
  const updateStatus = useUpdateConfirmationStatus(tripId)
  const { showToast } = useToast()

  const [step, setStep] = useState<Step>('answer')
  const [validationError, setValidationError] = useState<string | null>(null)

  // This modal always edits the current user's own participant record (no
  // create mode) -- draft persistence is disabled so a stale autosave from
  // an earlier abandoned edit (e.g. a different candidate status/note left
  // over from a prior open) can never leak in ahead of the live record
  // (Form & Flow Standard §5.2). Keyed per trip+user purely for clarity;
  // with persistence disabled the key is otherwise inert.
  const draftKey = participant ? `status-modal:${tripId}:${participant.user_id}` : 'status-modal:inactive'
  const { values, setValues, updateField, clearDraft } = useFormDraft<StatusFormValues>(
    draftKey,
    seedFromParticipant(participant),
    { enabled: false }
  )
  const { answer, waitingOn, conditionalDate, conditionalUserIds, note, agreedToTerms } = values

  const setAnswer = (v: RsvpAnswer) => updateField('answer', v)
  const setWaitingOn = (v: WaitingOnAnswer) => updateField('waitingOn', v)
  const setConditionalDate = (v: string) => updateField('conditionalDate', v)
  const setConditionalUserIds = (updater: (prev: string[]) => string[]) =>
    setValues((prev) => ({ ...prev, conditionalUserIds: updater(prev.conditionalUserIds) }))
  const setNote = (v: string) => updateField('note', v)
  const setAgreedToTerms = (v: boolean) => updateField('agreedToTerms', v)

  const wasConfirmed = participant?.confirmation_status === 'confirmed'
  const { status, conditionalType } = resolveStatus(values, wasConfirmed)

  // Fresh-state guarantee: every time the modal is (re)opened for a given
  // participant, re-seed from the current record — an edit-modal always
  // reflects the server's latest truth rather than a possibly-stale draft
  // from a much older session (useFormDraft's own 24h TTL is the second
  // line of defense for the "same session, app-switched" case).
  useEffect(() => {
    if (isOpen && participant) {
      setStep('answer')
      setValidationError(null)
      setValues(seedFromParticipant(participant))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, participant?.user_id])

  const isDirty = participant
    ? JSON.stringify(values) !== JSON.stringify(seedFromParticipant(participant))
    : false
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)

  const handleClose = () => confirmClose(onClose)

  // "Confirmed user chose to enter the cancellation flow from the read-only
  // recap" -- reset on every open/participant change so a stale flag from a
  // previous session can never skip the recap. Declared unconditionally
  // (before the `if (!participant) return null` below) per the rules of
  // hooks -- every hook in this component must run on every render.
  const [showCancelFlow, setShowCancelFlow] = useState(false)
  useEffect(() => {
    if (isOpen) setShowCancelFlow(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, participant?.user_id])

  if (!participant) return null

  const capacityWillWaitlist = answer === 'in' && !!capacityLimit && confirmedCount >= capacityLimit

  // Already-confirmed users get a read-only recap EXCEPT for the "I'm out"
  // path -- self-service cancellation now replaces the old dead-end (plan
  // §4 #3: "I'm out ... or cancelled if previously confirmed, with the
  // existing warning"). Reopening while confirmed still defaults to this
  // recap; picking "I'm out" from here drops straight to the cancellation
  // confirmation with the same warning copy the recap used to show.
  if (wasConfirmed && !showCancelFlow) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="lg" title="You're confirmed" data-status-modal-readonly>
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)]">
            You confirmed on{' '}
            {participant.confirmed_at
              ? new Date(participant.confirmed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
              : 'an earlier date'}
            .
          </p>
          {participant.confirmation_note && (
            <div className="bg-[var(--surface-sunken)] rounded-[var(--radius-md)] p-4">
              <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Your note</p>
              <p className="text-sm text-[var(--text-primary)] italic">"{participant.confirmation_note}"</p>
            </div>
          )}
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-4">
            <p className="text-sm font-semibold text-warn-900 mb-2">Need to back out?</p>
            <p className="text-sm text-warn-800 mb-3">
              You can cancel your spot yourself below — others are counting on you, so please only do this if you're
              sure. The organizer is notified either way.
            </p>
            <Button variant="danger" size="sm" onClick={() => setShowCancelFlow(true)}>
              I'm out — cancel my spot
            </Button>
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const confirmedParticipants = participants.filter((p) => p.confirmation_status === 'confirmed' && p.user_id !== participant.user_id)
  const selectableParticipants = participants.filter((p) => p.user_id !== participant.user_id)

  const isCircularDependency = (userId: string): boolean => {
    const target = participants.find((p) => p.user_id === userId)
    return !!(
      target?.confirmation_status === 'conditional' &&
      target.conditional_user_ids?.includes(participant.user_id)
    )
  }

  const toggleUser = (userId: string) => {
    setConditionalUserIds((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]))
  }

  const needsConditionDetail = answer === 'cant-say-yet' && (waitingOn === 'date' || waitingOn === 'someone' || waitingOn === 'both')

  const handleNext = () => {
    setValidationError(null)
    if (step === 'answer') {
      if (!answer) {
        setValidationError('Please choose one of the three options')
        return
      }
      if (answer === 'cant-say-yet') {
        setStep('waiting-on')
        return
      }
      setStep('review')
      return
    }
    if (step === 'waiting-on') {
      if (!waitingOn) {
        setValidationError('Please choose what you need to wait on')
        return
      }
      setStep(needsConditionDetail ? 'condition-detail' : 'review')
      return
    }
    if (step === 'condition-detail') {
      if ((waitingOn === 'date' || waitingOn === 'both') && !conditionalDate) {
        setValidationError('Please select a date')
        return
      }
      if ((waitingOn === 'someone' || waitingOn === 'both') && conditionalUserIds.length === 0) {
        setValidationError('Please select at least one person')
        return
      }
      setStep('review')
    }
  }

  const handleBack = () => {
    setValidationError(null)
    if (step === 'review') {
      if (answer === 'cant-say-yet') setStep(needsConditionDetail ? 'condition-detail' : 'waiting-on')
      else setStep('answer')
    } else if (step === 'condition-detail') {
      setStep('waiting-on')
    } else if (step === 'waiting-on') {
      setStep('answer')
    }
  }

  const handleSubmit = async () => {
    if (status === 'confirmed' && !agreedToTerms) {
      setValidationError('Please read and agree to the commitment terms before confirming')
      return
    }

    try {
      await updateStatus.mutateAsync({
        tripId,
        userId: participant.user_id,
        status,
        note: note.trim() || null,
        conditionalType: status === 'conditional' ? conditionalType : 'none',
        conditionalDate: status === 'conditional' ? conditionalDate || null : null,
        conditionalUserIds: status === 'conditional' ? (conditionalUserIds.length ? conditionalUserIds : null) : null,
      })

      // Reconciliation: the server may have rewritten 'confirmed' ->
      // 'waitlist' via the capacity trigger. useUpdateConfirmationStatus
      // invalidates the participants query on settle, but the optimistic
      // cache write already showed the requested status — so tell the
      // user explicitly if we expected a waitlist bump, since the
      // invalidated refetch will correct the badge a moment later anyway.
      if (status === 'confirmed' && capacityWillWaitlist) {
        showToast({
          type: 'info',
          message: "You're on the waitlist",
          description: 'The trip was at capacity, so you were automatically added to the waitlist instead of confirmed.',
        })
      } else {
        showToast({ type: 'success', message: 'Status updated' })
      }
      clearDraft()
      setShowCancelFlow(false)
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not update your status', description: (err as Error).message })
    }
  }

  const stepTitles: Record<Step, string> = {
    answer: 'Are you in?',
    'waiting-on': "What are you waiting on?",
    'condition-detail': 'A few more details',
    review: 'Review & confirm',
  }

  const stepperSteps =
    answer === 'cant-say-yet'
      ? needsConditionDetail
        ? [
            { key: 'answer', label: 'Answer' },
            { key: 'waiting-on', label: 'Waiting on' },
            { key: 'condition-detail', label: 'Details' },
            { key: 'review', label: 'Review' },
          ]
        : [
            { key: 'answer', label: 'Answer' },
            { key: 'waiting-on', label: 'Waiting on' },
            { key: 'review', label: 'Review' },
          ]
      : [
          { key: 'answer', label: 'Answer' },
          { key: 'review', label: 'Review' },
        ]

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={stepTitles[step]}>
      <div className="space-y-5">
        <Stepper steps={stepperSteps} current={step} size="sm" />

        {validationError && (
          <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
            {validationError}
          </div>
        )}

        {wasConfirmed && step !== 'review' && (
          <div className="bg-warn-50 border-2 border-warn-300 rounded-[var(--radius-md)] p-3 text-sm text-warn-900">
            You're currently confirmed — continuing will cancel your spot. Others are counting on you, so please only
            do this if you're sure.
          </div>
        )}

        {capacityWillWaitlist && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
            This trip is at capacity ({confirmedCount}/{capacityLimit}). If you confirm, you'll automatically be
            moved to the waitlist.
          </div>
        )}

        {/* Step: the three big answers */}
        {step === 'answer' && (
          <div className="space-y-2.5">
            {RSVP_ANSWER_OPTIONS.map((option) => {
              const isSelected = answer === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAnswer(option.value)}
                  className={`w-full text-left p-4 rounded-[var(--radius-md)] border-2 transition-all press-scale ${
                    isSelected ? 'border-accent-500 bg-accent-50' : 'border-[var(--border-default)] hover:border-[var(--border-subtle)] bg-[var(--surface-raised)]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xl" aria-hidden="true">
                      {option.emoji}
                    </span>
                    <h4 className="font-semibold text-[var(--text-primary)]">{option.label}</h4>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">{option.description}</p>
                </button>
              )
            })}
          </div>
        )}

        {/* Step: "Can't say yet" follow-up */}
        {step === 'waiting-on' && (
          <div className="space-y-2.5">
            <p className="text-sm text-[var(--text-secondary)]">No pressure — just tell us what's holding things up.</p>
            {WAITING_ON_OPTIONS.map((option) => {
              const isSelected = waitingOn === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setWaitingOn(option.value)}
                  className={`w-full text-left p-3 rounded-[var(--radius-md)] border-2 transition-all press-scale ${
                    isSelected ? 'border-accent-500 bg-accent-50' : 'border-[var(--border-default)] hover:border-[var(--border-subtle)] bg-[var(--surface-raised)]'
                  }`}
                >
                  <h4 className="font-medium text-[var(--text-primary)] mb-0.5">{option.label}</h4>
                  <p className="text-sm text-[var(--text-secondary)]">{option.description}</p>
                </button>
              )
            })}
          </div>
        )}

        {/* Step: condition detail (date / people pickers) */}
        {step === 'condition-detail' && (
          <div className="space-y-5">
            {(waitingOn === 'date' || waitingOn === 'both') && (
              <div>
                <label htmlFor="conditional-date" className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                  I'll confirm by this date
                </label>
                <input
                  id="conditional-date"
                  type="date"
                  value={conditionalDate}
                  onChange={(e) => setConditionalDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-3 py-2 border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--surface-raised)] focus:ring-2 focus:ring-accent-500 focus:border-transparent"
                />
              </div>
            )}

            {(waitingOn === 'someone' || waitingOn === 'both') && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                  I'll confirm when these people confirm
                </label>
                {confirmedParticipants.length > 0 && (
                  <div className="mb-3 p-3 bg-success-50 border border-success-200 rounded-[var(--radius-md)]">
                    <p className="text-xs font-medium text-success-800 mb-2">Already confirmed:</p>
                    <div className="flex flex-wrap gap-2">
                      {confirmedParticipants.map((p) => (
                        <Badge key={p.user_id} variant="success" size="sm">
                          {p.user?.full_name || p.user?.email}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-2 max-h-56 overflow-y-auto border border-[var(--border-default)] rounded-[var(--radius-md)] p-2">
                  {selectableParticipants.map((p) => {
                    const isSelected = conditionalUserIds.includes(p.user_id)
                    const isConfirmed = p.confirmation_status === 'confirmed'
                    const circular = isCircularDependency(p.user_id)
                    return (
                      <div key={p.user_id}>
                        <button
                          type="button"
                          onClick={() => !isConfirmed && toggleUser(p.user_id)}
                          disabled={isConfirmed}
                          className={`w-full flex items-center gap-3 p-2 rounded-[var(--radius-md)] transition-colors ${
                            isConfirmed ? 'opacity-50 cursor-not-allowed' : isSelected ? 'bg-accent-50 border border-accent-200' : 'hover:bg-[var(--surface-sunken)]'
                          }`}
                        >
                          <div className="flex-1 text-left">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[var(--text-primary)]">{p.user?.full_name || p.user?.email}</span>
                              {circular && (
                                <Badge variant="warning" size="sm">
                                  Circular
                                </Badge>
                              )}
                            </div>
                            <ConfirmationStatusBadge status={p.confirmation_status || 'pending'} size="sm" />
                          </div>
                          {isSelected && <span className="text-accent-600 font-bold">✓</span>}
                        </button>
                        {circular && isSelected && (
                          <p className="mt-1 ml-3 text-xs text-warn-700">
                            {p.user?.full_name || p.user?.email} is also waiting on you — neither of you will confirm
                            until one decides independently.
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step: review */}
        {step === 'review' && (
          <div className="space-y-5">
            {status === 'confirmed' && (
              <div className="bg-warn-50 border-2 border-warn-300 rounded-[var(--radius-md)] p-4">
                <h3 className="text-sm font-semibold text-warn-900 mb-2">Commitment terms</h3>
                <ul className="space-y-1.5 text-sm text-warn-900">
                  {trip?.estimated_accommodation_cost && (
                    <li>
                      <strong>Financial commitment:</strong> you agree to pay the committed accommodation cost of{' '}
                      <strong>
                        {trip.accommodation_cost_currency} {trip.estimated_accommodation_cost.toFixed(2)}
                      </strong>
                      .
                    </li>
                  )}
                  {COMMITMENT_TERMS.map((term) => (
                    <li key={term}>{term}</li>
                  ))}
                </ul>
                <label className="flex items-start gap-3 mt-4 pt-4 border-t border-warn-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreedToTerms}
                    onChange={(e) => setAgreedToTerms(e.target.checked)}
                    className="mt-1 w-5 h-5 accent-warn-600"
                  />
                  <span className="text-sm font-medium text-warn-900">
                    I have read and agree to these commitment terms.
                  </span>
                </label>
              </div>
            )}

            {status === 'cancelled' && (
              <div className="bg-danger-50 border-2 border-danger-200 rounded-[var(--radius-md)] p-4">
                <h3 className="text-sm font-semibold text-danger-800 mb-1">You're cancelling your confirmed spot</h3>
                <p className="text-sm text-danger-800">
                  Cancellation Liability: you may still be liable to pay your share of the accommodation cost,
                  depending on the group's arrangement — check with the organizer. This cannot be undone from here.
                </p>
              </div>
            )}

            <div className="bg-[var(--surface-sunken)] rounded-[var(--radius-md)] p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)] mb-1">Your status</p>
                <ConfirmationStatusBadge status={status} size="md" />
              </div>
              {status === 'conditional' && conditionalType !== 'none' && (
                <ConditionalDependencyDisplay
                  conditionalType={conditionalType}
                  conditionalDate={conditionalDate}
                  conditionalUserIds={conditionalUserIds}
                  participants={participants.map((p) => ({
                    user_id: p.user_id,
                    confirmation_status: p.confirmation_status ?? undefined,
                    user: p.user ? { id: p.user.id, full_name: p.user.full_name ?? undefined, email: p.user.email ?? undefined, avatar_data: p.user.avatar_data } : undefined,
                  }))}
                  size="sm"
                />
              )}
            </div>

            <TextArea
              label="Add a note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Let everyone know why, or any other details..."
              rows={3}
              maxLength={500}
              showCount
            />
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 justify-between w-full pt-4 border-t border-[var(--border-subtle)]">
          <div>
            {step !== 'answer' && (
              <Button variant="outline" onClick={handleBack} disabled={updateStatus.isPending}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setShowCancelFlow(false)
                handleClose()
              }}
              disabled={updateStatus.isPending}
            >
              Cancel
            </Button>
            {step !== 'review' ? (
              <Button onClick={handleNext}>Next</Button>
            ) : (
              <Button onClick={handleSubmit} isLoading={updateStatus.isPending} variant={status === 'cancelled' ? 'danger' : 'primary'}>
                {status === 'confirmed' ? 'Confirm my spot' : status === 'cancelled' ? 'Cancel my spot' : 'Update status'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
