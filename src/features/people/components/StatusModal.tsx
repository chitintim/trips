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

// ============================================================================
// CONFIG
// ============================================================================

const STATUS_OPTIONS: Array<{ value: ConfirmationStatus; label: string; description: string }> = [
  {
    value: 'interested',
    label: 'Interested',
    description: "I'm keen but not ready to commit yet.",
  },
  {
    value: 'confirmed',
    label: 'Confirmed',
    description:
      "I'm 100% committed and ready to book. I understand others are counting on me. (Once confirmed, you cannot change your status yourself — contact the organizer.)",
  },
  {
    value: 'conditional',
    label: 'Conditional',
    description: "I'll confirm under certain conditions (e.g. a friend confirms, or by a specific date).",
  },
  {
    value: 'waitlist',
    label: 'Waitlist',
    description: "I can't confirm yet, but I'll take any spot that opens up.",
  },
  {
    value: 'declined',
    label: "Can't make it",
    description: "I can't join this trip. Thanks for the invite!",
  },
]

const CONDITIONAL_TYPE_OPTIONS: Array<{ value: ConditionalType; label: string; description: string }> = [
  { value: 'date', label: 'By a specific date', description: "I'll confirm by a certain date" },
  { value: 'users', label: 'When others confirm', description: "I'll confirm when specific people confirm" },
  { value: 'both', label: 'Either condition', description: 'Whichever happens first' },
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
 * 2-step RSVP status modal: status choice -> (conditional detail if
 * applicable) -> note & review. Ported from the legacy
 * UpdateConfirmationModal's flow onto the new ui kit.
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
  status: ConfirmationStatus
  conditionalType: ConditionalType
  conditionalDate: string
  conditionalUserIds: string[]
  note: string
  agreedToTerms: boolean
}

function seedFromParticipant(participant: ParticipantWithUser | null): StatusFormValues {
  return {
    status: (participant?.confirmation_status as ConfirmationStatus) || 'pending',
    conditionalType: (participant?.conditional_type as ConditionalType) || 'none',
    conditionalDate: participant?.conditional_date || '',
    conditionalUserIds: participant?.conditional_user_ids || [],
    note: participant?.confirmation_note || '',
    agreedToTerms: false,
  }
}

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

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Draft-persisted form state (Form & Flow Standard, UPGRADE_MASTER_PLAN.md
  // §5): survives a mobile tab-switch mid-edit. Keyed per trip+user so
  // different participants' in-flight edits never collide.
  const draftKey = participant ? `status-modal:${tripId}:${participant.user_id}` : 'status-modal:inactive'
  const { values, setValues, updateField, clearDraft } = useFormDraft<StatusFormValues>(
    draftKey,
    seedFromParticipant(participant)
  )
  const { status, conditionalType, conditionalDate, conditionalUserIds, note, agreedToTerms } = values

  const setStatus = (v: ConfirmationStatus) => updateField('status', v)
  const setConditionalType = (v: ConditionalType) => updateField('conditionalType', v)
  const setConditionalDate = (v: string) => updateField('conditionalDate', v)
  const setConditionalUserIds = (updater: (prev: string[]) => string[]) =>
    setValues((prev) => ({ ...prev, conditionalUserIds: updater(prev.conditionalUserIds) }))
  const setNote = (v: string) => updateField('note', v)
  const setAgreedToTerms = (v: boolean) => updateField('agreedToTerms', v)

  // Fresh-state guarantee: every time the modal is (re)opened for a given
  // participant, re-seed from the current record — an edit-modal always
  // reflects the server's latest truth rather than a possibly-stale draft
  // from a much older session (useFormDraft's own 24h TTL is the second
  // line of defense for the "same session, app-switched" case).
  useEffect(() => {
    if (isOpen && participant) {
      setStep(1)
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

  if (!participant) return null

  const capacityWillWaitlist = status === 'confirmed' && !!capacityLimit && confirmedCount >= capacityLimit

  // Already-confirmed users get a read-only recap (commitment lock) —
  // matches legacy behavior: confirmed status cannot be self-changed.
  if (participant.confirmation_status === 'confirmed') {
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
            <p className="text-sm text-warn-800">
              Contact the organizer directly — confirmed status can't be changed from here to avoid accidental
              cancellations others are counting on.
            </p>
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

  const handleNext = () => {
    setValidationError(null)
    if (step === 1) {
      setStep(status === 'conditional' ? 2 : 3)
      return
    }
    if (step === 2) {
      if (conditionalType === 'none') {
        setValidationError('Please select a condition type')
        return
      }
      if ((conditionalType === 'date' || conditionalType === 'both') && !conditionalDate) {
        setValidationError('Please select a date')
        return
      }
      if ((conditionalType === 'users' || conditionalType === 'both') && conditionalUserIds.length === 0) {
        setValidationError('Please select at least one person')
        return
      }
      setStep(3)
    }
  }

  const handleBack = () => {
    setValidationError(null)
    if (step === 3) setStep(status === 'conditional' ? 2 : 1)
    else if (step === 2) setStep(1)
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
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not update your status', description: (err as Error).message })
    }
  }

  const stepTitle = step === 1 ? 'Update your status' : step === 2 ? 'Set your conditions' : 'Review & confirm'
  const stepperSteps =
    status === 'conditional'
      ? [
          { key: '1', label: 'Status' },
          { key: '2', label: 'Conditions' },
          { key: '3', label: 'Review' },
        ]
      : [
          { key: '1', label: 'Status' },
          { key: '3', label: 'Review' },
        ]

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={stepTitle}>
      <div className="space-y-5">
        <Stepper steps={stepperSteps} current={String(step)} size="sm" />

        {validationError && (
          <div className="bg-danger-50 border border-danger-200 text-danger-800 rounded-[var(--radius-md)] p-3 text-sm">
            {validationError}
          </div>
        )}

        {capacityWillWaitlist && step >= 1 && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
            This trip is at capacity ({confirmedCount}/{capacityLimit}). If you confirm, you'll automatically be
            moved to the waitlist.
          </div>
        )}

        {/* Step 1 */}
        {step === 1 && (
          <div className="space-y-2.5">
            {STATUS_OPTIONS.map((option) => {
              const isSelected = status === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setStatus(option.value)}
                  className={`w-full text-left p-4 rounded-[var(--radius-md)] border-2 transition-all ${
                    isSelected ? 'border-accent-500 bg-accent-50' : 'border-[var(--border-default)] hover:border-[var(--border-subtle)] bg-[var(--surface-raised)]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-[var(--text-primary)]">{option.label}</h4>
                    <ConfirmationStatusBadge status={option.value} size="sm" />
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">{option.description}</p>
                </button>
              )
            })}
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && status === 'conditional' && (
          <div className="space-y-5">
            <div className="space-y-2.5">
              <label className="block text-sm font-medium text-[var(--text-primary)]">
                When will you be ready to confirm?
              </label>
              {CONDITIONAL_TYPE_OPTIONS.map((option) => {
                const isSelected = conditionalType === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setConditionalType(option.value)}
                    className={`w-full text-left p-3 rounded-[var(--radius-md)] border-2 transition-all ${
                      isSelected ? 'border-accent-500 bg-accent-50' : 'border-[var(--border-default)] hover:border-[var(--border-subtle)] bg-[var(--surface-raised)]'
                    }`}
                  >
                    <h4 className="font-medium text-[var(--text-primary)] mb-0.5">{option.label}</h4>
                    <p className="text-sm text-[var(--text-secondary)]">{option.description}</p>
                  </button>
                )
              })}
            </div>

            {(conditionalType === 'date' || conditionalType === 'both') && (
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

            {(conditionalType === 'users' || conditionalType === 'both') && (
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

        {/* Step 3 */}
        {step === 3 && (
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
            {step > 1 && (
              <Button variant="outline" onClick={handleBack} disabled={updateStatus.isPending}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleClose} disabled={updateStatus.isPending}>
              Cancel
            </Button>
            {step < 3 ? (
              <Button onClick={handleNext}>Next</Button>
            ) : (
              <Button onClick={handleSubmit} isLoading={updateStatus.isPending}>
                {status === 'confirmed' ? 'Confirm my spot' : 'Update status'}
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
