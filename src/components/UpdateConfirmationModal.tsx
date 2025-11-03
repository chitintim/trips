import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Modal, Button, TextArea, Badge } from './ui'
import { ConfirmationStatusBadge, ConditionalDependencyDisplay } from './ui'
import { Database } from '../types/database.types'

// ============================================================================
// TYPES
// ============================================================================

type ConfirmationStatus = Database['public']['Enums']['confirmation_status']
type ConditionalType = Database['public']['Enums']['conditional_type']

interface Participant {
  user_id: string
  trip_id: string
  role: string
  confirmation_status: ConfirmationStatus
  confirmed_at: string | null
  confirmation_note: string | null
  conditional_type: ConditionalType
  conditional_date: string | null
  conditional_user_ids: string[] | null
  updated_at: string | null
  user?: {
    id: string
    full_name?: string
    email?: string
    avatar_data?: any
  }
}

interface UpdateConfirmationModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  participant: Participant | null
  participants: Participant[]
  capacityLimit: number | null
  confirmedCount: number
  onSuccess: () => void
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const STATUS_OPTIONS = [
  {
    value: 'confirmed',
    label: 'Confirmed',
    description: 'I\'m 100% committed and ready to book. I understand others are counting on me. (Note: Once confirmed, you cannot change your status.)'
  },
  {
    value: 'conditional',
    label: 'Conditional',
    description: 'I\'ll confirm under certain conditions (e.g., my friend confirms, I get annual leave approval by a certain date).'
  },
  {
    value: 'waitlist',
    label: 'Waitlist',
    description: 'I really can\'t confirm until the last minute, but I\'ll take the chance and fill any available spaces if they open up.'
  },
  {
    value: 'declined',
    label: 'Declined',
    description: 'I can\'t make this trip. Thanks for inviting me!'
  },
]

const CONDITIONAL_TYPE_OPTIONS = [
  { value: 'date', label: 'By a specific date', description: 'I\'ll confirm by a certain date' },
  { value: 'users', label: 'When others confirm', description: 'I\'ll confirm when specific people confirm' },
  { value: 'both', label: 'Either condition', description: 'I\'ll confirm when either the date arrives OR others confirm' },
]

// ============================================================================
// COMPONENT
// ============================================================================

export function UpdateConfirmationModal({
  isOpen,
  onClose,
  tripId,
  participant,
  participants,
  capacityLimit,
  confirmedCount,
  onSuccess,
}: UpdateConfirmationModalProps) {
  const { user } = useAuth()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [trip, setTrip] = useState<any>(null)

  // Step 1: Confirmation Status
  const [status, setStatus] = useState<ConfirmationStatus>('pending')

  // Step 2: Conditional Type & Dependencies (only if status === 'conditional')
  const [conditionalType, setConditionalType] = useState<ConditionalType>('none')
  const [conditionalDate, setConditionalDate] = useState('')
  const [conditionalUserIds, setConditionalUserIds] = useState<string[]>([])

  // Step 3: Note
  const [note, setNote] = useState('')

  // Commitment agreement (for confirmed status)
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  // Warnings
  const [capacityWarning, setCapacityWarning] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen && participant) {
      // Reset form with current participant data
      setStep(1)
      setStatus(participant.confirmation_status || 'pending')
      setConditionalType(participant.conditional_type || 'none')
      setConditionalDate(participant.conditional_date || '')
      setConditionalUserIds(participant.conditional_user_ids || [])
      setNote(participant.confirmation_note || '')
      setAgreedToTerms(false)
      setCapacityWarning(null)

      // Fetch trip data for commitment terms
      fetchTripData()
    }
  }, [isOpen, participant])

  const fetchTripData = async () => {
    const { data } = await supabase
      .from('trips')
      .select('estimated_accommodation_cost, accommodation_cost_currency')
      .eq('id', tripId)
      .single()

    if (data) {
      setTrip(data)
    }
  }

  const handleNext = () => {
    // Step 1: Status selection
    if (step === 1) {
      // Check capacity if trying to confirm
      if (status === 'confirmed' && capacityLimit && confirmedCount >= capacityLimit) {
        setCapacityWarning(
          `This trip is at full capacity (${confirmedCount}/${capacityLimit}). ` +
          `If you confirm, you'll be automatically moved to the waitlist.`
        )
      } else {
        setCapacityWarning(null)
      }

      // If not conditional, skip to note step
      if (status !== 'conditional') {
        setStep(3)
      } else {
        setStep(2)
      }
      return
    }

    // Step 2: Conditional type & dependencies
    if (step === 2) {
      if (conditionalType === 'none') {
        alert('Please select a condition type')
        return
      }

      if ((conditionalType === 'date' || conditionalType === 'both') && !conditionalDate) {
        alert('Please select a date')
        return
      }

      if ((conditionalType === 'users' || conditionalType === 'both') && conditionalUserIds.length === 0) {
        alert('Please select at least one person')
        return
      }

      setStep(3)
      return
    }
  }

  const handleBack = () => {
    if (step === 3) {
      // If coming from note step, check if we need to go back to conditional or status
      if (status === 'conditional') {
        setStep(2)
      } else {
        setStep(1)
      }
    } else if (step === 2) {
      setStep(1)
    }
  }

  const handleSubmit = async () => {
    if (!participant || !user) return

    // Validate commitment agreement for confirmed status
    if (status === 'confirmed' && !agreedToTerms) {
      alert('Please read and agree to the commitment terms before confirming')
      return
    }

    setLoading(true)

    try {
      // Build update object
      const update: any = {
        confirmation_status: status,
        confirmation_note: note.trim() || null,
        updated_at: new Date().toISOString(),
      }

      // Clear conditional fields if not conditional
      if (status !== 'conditional') {
        update.conditional_type = 'none'
        update.conditional_date = null
        update.conditional_user_ids = null
      } else {
        update.conditional_type = conditionalType
        update.conditional_date = conditionalDate || null
        update.conditional_user_ids = conditionalUserIds.length > 0 ? conditionalUserIds : null
      }

      // Update database
      const { error } = await supabase
        .from('trip_participants')
        .update(update)
        .eq('trip_id', tripId)
        .eq('user_id', user.id)

      if (error) throw error

      // Success - call parent callback
      onSuccess()
      onClose()
    } catch (error: any) {
      console.error('Error updating confirmation:', error)
      alert(error.message || 'Failed to update confirmation status')
    } finally {
      setLoading(false)
    }
  }

  const toggleUserSelection = (userId: string) => {
    setConditionalUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    )
  }

  // Check if selecting this user would create a circular dependency
  const isCircularDependency = (userId: string): boolean => {
    if (!participant) return false

    const targetParticipant = participants.find((p) => p.user_id === userId)
    if (!targetParticipant) return false

    // Check if the target user is conditional on us
    if (
      targetParticipant.confirmation_status === 'conditional' &&
      targetParticipant.conditional_user_ids &&
      targetParticipant.conditional_user_ids.includes(participant.user_id)
    ) {
      return true
    }

    return false
  }

  // Filter out current user and already confirmed users for conditional selection
  // const selectableParticipants = participants.filter(
  //   (p) => p.user_id !== user?.id && p.confirmation_status !== 'confirmed' && p.user_id !== participant?.user_id
  // )

  const confirmedParticipants = participants.filter(
    (p) => p.confirmation_status === 'confirmed' && p.user_id !== participant?.user_id
  )

  // Show all participants except current user for conditional selection
  const conditionalSelectableParticipants = participants.filter(
    (p) => p.user_id !== user?.id && p.user_id !== participant?.user_id
  )

  const getStepTitle = () => {
    if (step === 1) return 'Update your status'
    if (step === 2) return 'Set your conditions'
    if (step === 3) return 'Review & confirm'
    return ''
  }

  const getStepDescription = () => {
    if (step === 1) return 'Let everyone know your current status for this trip'
    if (step === 2) return 'What needs to happen for you to confirm?'
    if (step === 3) return 'Review your status and add an optional note'
    return ''
  }

  if (!participant) return null

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <div className="space-y-6">
        {/* Title and Description */}
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{getStepTitle()}</h2>
          <p className="text-sm text-gray-600 mt-1">{getStepDescription()}</p>
        </div>

        {/* Content */}
        <div className="space-y-6">
          {/* Progress Indicator */}
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((s) => {
              // Determine if this step should be shown (skip step 2 if not conditional)
              const showStep2 = status === 'conditional'
              const isStepSkipped = s === 2 && !showStep2

              if (isStepSkipped) return null

              return (
                <div
                  key={s}
                  className={`flex-1 h-2 rounded-full transition-colors ${
                    s < step ? 'bg-success-500' : s === step ? 'bg-primary-500' : 'bg-gray-200'
                  }`}
                />
              )
            })}
          </div>

          {/* Capacity Warning */}
          {capacityWarning && (
            <div className="bg-warning-50 border border-warning-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-warning-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <p className="text-sm text-warning-800 font-medium">Capacity Reached</p>
                  <p className="text-sm text-warning-700 mt-1">{capacityWarning}</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Status Selection */}
          {step === 1 && (
            <div className="space-y-3">
              {/* Warning if already confirmed */}
              {participant.confirmation_status === 'confirmed' && (
                <div className="bg-primary-50 border-2 border-primary-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-primary-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="flex-1">
                      <p className="text-sm text-primary-900 font-medium mb-1">You're Already Confirmed!</p>
                      <p className="text-sm text-primary-800">
                        Once confirmed, your status is locked. Others are counting on you! If you absolutely need to change your status, please contact the trip organizer directly.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {STATUS_OPTIONS.map((option) => {
                // Don't show pending option
                if (option.value === 'pending') return null

                // If user is confirmed, disable all other options
                const isLocked = participant.confirmation_status === 'confirmed' && option.value !== 'confirmed'
                const isSelected = status === option.value

                return (
                  <button
                    key={option.value}
                    onClick={() => !isLocked && setStatus(option.value as ConfirmationStatus)}
                    disabled={isLocked}
                    className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                      isLocked
                        ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                        : isSelected
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold text-gray-900">{option.label}</h4>
                          <ConfirmationStatusBadge status={option.value as ConfirmationStatus} size="sm" />
                        </div>
                        <p className="text-sm text-gray-600">{option.description}</p>
                      </div>
                      {isSelected && (
                        <svg className="w-5 h-5 text-primary-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* Step 2: Conditional Type & Dependencies */}
          {step === 2 && status === 'conditional' && (
            <div className="space-y-6">
              {/* Conditional Type Selection */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">
                  When will you be ready to confirm?
                </label>
                {CONDITIONAL_TYPE_OPTIONS.map((option) => {
                  const isSelected = conditionalType === option.value

                  return (
                    <button
                      key={option.value}
                      onClick={() => setConditionalType(option.value as ConditionalType)}
                      className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                        isSelected
                          ? 'border-primary-500 bg-primary-50'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1">
                          <h4 className="font-medium text-gray-900 mb-0.5">{option.label}</h4>
                          <p className="text-sm text-gray-600">{option.description}</p>
                        </div>
                        {isSelected && (
                          <svg className="w-5 h-5 text-primary-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* Date Picker (if date or both) */}
              {(conditionalType === 'date' || conditionalType === 'both') && (
                <div>
                  <label htmlFor="conditional-date" className="block text-sm font-medium text-gray-700 mb-2">
                    I'll confirm by this date
                  </label>
                  <input
                    id="conditional-date"
                    type="date"
                    value={conditionalDate}
                    onChange={(e) => setConditionalDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    The date by which you'll make your final decision
                  </p>
                </div>
              )}

              {/* User Selector (if users or both) */}
              {(conditionalType === 'users' || conditionalType === 'both') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    I'll confirm when these people confirm
                  </label>

                  {/* Show confirmed participants */}
                  {confirmedParticipants.length > 0 && (
                    <div className="mb-3 p-3 bg-success-50 border border-success-200 rounded-lg">
                      <p className="text-xs font-medium text-success-800 mb-2">Already confirmed:</p>
                      <div className="space-y-2">
                        {confirmedParticipants.map((p) => (
                          <div key={p.user_id} className="flex items-center gap-2">
                            <div
                              className="w-8 h-8 rounded-full flex flex-col items-center justify-center flex-shrink-0"
                              style={{
                                backgroundColor: (p.user?.avatar_data as any)?.bgColor || '#0ea5e9',
                              }}
                            >
                              {(p.user?.avatar_data as any)?.accessory && (
                                <span className="text-xs -mb-0.5">{(p.user?.avatar_data as any)?.accessory}</span>
                              )}
                              <span className="text-sm">{(p.user?.avatar_data as any)?.emoji || '😊'}</span>
                            </div>
                            <span className="text-sm text-gray-700">
                              {p.user?.full_name || p.user?.email}
                            </span>
                            <Badge variant="success" size="sm">Confirmed</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Select from remaining participants */}
                  <div className="space-y-2 max-h-64 overflow-y-auto border border-gray-200 rounded-lg p-3">
                    {conditionalSelectableParticipants.length === 0 ? (
                      <p className="text-sm text-gray-500 text-center py-4">
                        No other participants to select from
                      </p>
                    ) : (
                      conditionalSelectableParticipants.map((p) => {
                        const isSelected = conditionalUserIds.includes(p.user_id)
                        const isConfirmed = p.confirmation_status === 'confirmed'
                        const hasCircularDep = isCircularDependency(p.user_id)

                        return (
                          <div key={p.user_id}>
                            <button
                              onClick={() => !isConfirmed && toggleUserSelection(p.user_id)}
                              disabled={isConfirmed}
                              className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors ${
                                isConfirmed
                                  ? 'cursor-not-allowed opacity-50'
                                  : isSelected
                                  ? 'bg-primary-50 border border-primary-200'
                                  : 'hover:bg-gray-50'
                              }`}
                            >
                              <div
                                className="w-10 h-10 rounded-full flex flex-col items-center justify-center flex-shrink-0"
                                style={{
                                  backgroundColor: (p.user?.avatar_data as any)?.bgColor || '#0ea5e9',
                                }}
                              >
                                {(p.user?.avatar_data as any)?.accessory && (
                                  <span className="text-xs -mb-0.5">{(p.user?.avatar_data as any)?.accessory}</span>
                                )}
                                <span className="text-base">{(p.user?.avatar_data as any)?.emoji || '😊'}</span>
                              </div>
                              <div className="flex-1 text-left">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-gray-900">
                                    {p.user?.full_name || p.user?.email}
                                  </div>
                                  {hasCircularDep && (
                                    <span className="text-xs px-1.5 py-0.5 bg-warning-100 text-warning-700 rounded">
                                      ⚠ Circular
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500">
                                  <ConfirmationStatusBadge status={p.confirmation_status} size="sm" />
                                </div>
                              </div>
                              {isSelected && !isConfirmed && (
                                <svg className="w-5 h-5 text-primary-500" fill="currentColor" viewBox="0 0 20 20">
                                  <path
                                    fillRule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              )}
                            </button>

                            {/* Circular dependency warning */}
                            {hasCircularDep && isSelected && (
                              <div className="mt-1 ml-12 p-2 bg-warning-50 border border-warning-200 rounded text-xs text-warning-800">
                                <div className="flex items-start gap-1.5">
                                  <svg className="w-4 h-4 text-warning-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                  <span>
                                    <strong>Circular dependency:</strong> {p.user?.full_name || p.user?.email} is also waiting for you. Neither of you will be able to confirm until one decides independently.
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Select all the people who need to confirm before you're ready to commit
                  </p>
                </div>
              )}

              {/* OR explanation for 'both' */}
              {conditionalType === 'both' && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <div className="flex-1">
                      <p className="text-sm text-blue-900 font-medium">How "Either" works</p>
                      <p className="text-sm text-blue-800 mt-1">
                        You'll be notified when <strong>either</strong> the date arrives <strong>OR</strong> when all selected people confirm - whichever happens first.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Note & Review */}
          {step === 3 && (
            <div className="space-y-6">
              {/* Commitment Agreement (for confirmed status) */}
              {status === 'confirmed' && (
                <div className="bg-warning-50 border-2 border-warning-300 rounded-lg p-5">
                  <div className="flex items-start gap-3 mb-4">
                    <svg className="w-6 h-6 text-warning-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-warning-900 mb-2">Commitment Terms</h3>
                      <p className="text-sm text-warning-800 mb-3">
                        By confirming, you agree to the following terms:
                      </p>
                      <div className="space-y-2 text-sm text-warning-900">
                        {trip?.estimated_accommodation_cost && (
                          <div className="flex items-start gap-2">
                            <span className="text-warning-600 font-bold mt-0.5">•</span>
                            <p>
                              <strong>Financial Commitment:</strong> You agree to pay the committed accommodation cost of{' '}
                              <strong className="text-warning-900">
                                {trip.accommodation_cost_currency} {trip.estimated_accommodation_cost.toFixed(2)}
                              </strong>
                            </p>
                          </div>
                        )}
                        <div className="flex items-start gap-2">
                          <span className="text-warning-600 font-bold mt-0.5">•</span>
                          <p>
                            <strong>Cancellation Liability:</strong> If you cannot join after confirming, you will be liable to pay your share of the accommodation cost.
                          </p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-warning-600 font-bold mt-0.5">•</span>
                          <p>
                            <strong>Insurance:</strong> Certain cancellations may be covered by travel insurance. We normally provide guidance and help with choosing the right insurance.
                          </p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-warning-600 font-bold mt-0.5">•</span>
                          <p>
                            <strong>Space Transfer:</strong> You may transfer your space to someone else if needed.
                          </p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-warning-600 font-bold mt-0.5">•</span>
                          <p>
                            <strong>Substitute Finder:</strong> The group can (but is not obligated to) help find a substitute at a discounted price if you need to cancel.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Agreement Checkbox */}
                  <div className="mt-4 pt-4 border-t border-warning-300">
                    <label className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => setAgreedToTerms(e.target.checked)}
                        className="mt-1 w-5 h-5 text-warning-600 border-warning-400 rounded focus:ring-warning-500 focus:ring-2"
                      />
                      <span className="text-sm font-medium text-warning-900 group-hover:text-warning-700">
                        I have read and agree to these commitment terms. I understand that others are counting on me and this confirmation cannot be changed.
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {/* Review Status */}
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <div>
                  <label className="text-sm font-medium text-gray-700">Your status:</label>
                  <div className="mt-1">
                    <ConfirmationStatusBadge status={status} size="md" />
                  </div>
                </div>

                {/* Show conditional details if applicable */}
                {status === 'conditional' && conditionalType !== 'none' && (
                  <div>
                    <label className="text-sm font-medium text-gray-700 mb-2 block">Your conditions:</label>
                    <ConditionalDependencyDisplay
                      conditionalType={conditionalType}
                      conditionalDate={conditionalDate}
                      conditionalUserIds={conditionalUserIds}
                      participants={participants}
                      size="sm"
                    />
                  </div>
                )}
              </div>

              {/* Optional Note */}
              <div>
                <label htmlFor="confirmation-note" className="block text-sm font-medium text-gray-700 mb-2">
                  Add a note (optional)
                </label>
                <TextArea
                  id="confirmation-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Let everyone know why you made this choice, or any other details..."
                  rows={3}
                  maxLength={500}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {note.length}/500 characters
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 justify-between w-full pt-4 border-t border-gray-200">
          <div>
            {step > 1 && (
              <Button variant="outline" onClick={handleBack} disabled={loading}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            {step < 3 ? (
              <Button onClick={handleNext} disabled={loading}>
                Next
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={loading || (status === 'confirmed' && !agreedToTerms)}
              >
                {loading ? 'Updating...' : status === 'confirmed' ? 'Confirm My Spot' : 'Update Status'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
