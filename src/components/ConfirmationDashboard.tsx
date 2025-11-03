import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import {
  Card,
  Button,
  Spinner,
  EmptyState,
  ConfirmationStatusBadge,
  CapacityProgressBar,
  ConditionalDependencyDisplay,
} from './ui'
import { UpdateConfirmationModal } from './UpdateConfirmationModal'
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

interface ConfirmationDashboardProps {
  tripId: string
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const STATUS_SECTIONS = {
  confirmed: {
    title: 'Confirmed',
    icon: '✓',
    description: 'Locked in and committed',
  },
  conditional: {
    title: 'Conditional',
    icon: '⏳',
    description: 'Will confirm under certain conditions',
  },
  waitlist: {
    title: 'Waitlist',
    icon: '📋',
    description: 'Want to join if space opens up',
  },
  pending: {
    title: 'Pending',
    icon: '❓',
    description: 'Invited, no response yet',
  },
  declined: {
    title: 'Declined',
    icon: '✗',
    description: 'Not able to join',
  },
  cancelled: {
    title: 'Declined',
    icon: '✗',
    description: 'Not able to join',
  },
  interested: {
    title: 'Interested',
    icon: '👍',
    description: 'Thinking about it',
  },
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Recursively calculate the effective deadline for a conditional participant.
 * If they depend on other users who also have date conditions, we need to find
 * the latest date in the dependency chain.
 */
function getEffectiveDeadline(
  participant: Participant,
  allParticipants: Participant[],
  visited: Set<string> = new Set()
): Date | null {
  // Prevent infinite recursion
  if (visited.has(participant.user_id)) {
    return null
  }
  visited.add(participant.user_id)

  // Not conditional, no deadline
  if (participant.conditional_type === 'none') {
    return null
  }

  const dates: Date[] = []

  // Add direct date condition
  if (participant.conditional_date) {
    dates.push(new Date(participant.conditional_date))
  }

  // Add user dependency dates (recursive)
  if (participant.conditional_user_ids && participant.conditional_user_ids.length > 0) {
    for (const userId of participant.conditional_user_ids) {
      const depParticipant = allParticipants.find((p) => p.user_id === userId)
      if (depParticipant) {
        const depDeadline = getEffectiveDeadline(depParticipant, allParticipants, new Set(visited))
        if (depDeadline) {
          dates.push(depDeadline)
        }
      }
    }
  }

  // Return latest date in chain (most pessimistic deadline)
  if (dates.length === 0) return null
  return new Date(Math.max(...dates.map((d) => d.getTime())))
}

/**
 * Check if a conditional participant's conditions are met
 */
function areConditionsMet(participant: Participant, allParticipants: Participant[]): boolean {
  if (participant.conditional_type === 'none') return false

  let dateMet = true
  let usersMet = true

  // Check date condition
  if (participant.conditional_date) {
    const condDate = new Date(participant.conditional_date)
    const now = new Date()
    dateMet = now >= condDate
  }

  // Check user conditions
  if (participant.conditional_user_ids && participant.conditional_user_ids.length > 0) {
    // All users must be confirmed (OR logic means ALL must be true to proceed)
    usersMet = participant.conditional_user_ids.every((userId) => {
      const depParticipant = allParticipants.find((p) => p.user_id === userId)
      return depParticipant?.confirmation_status === 'confirmed'
    })
  }

  // For 'both', both date AND users must be met
  if (participant.conditional_type === 'both') {
    return dateMet && usersMet
  } else if (participant.conditional_type === 'date') {
    return dateMet
  } else if (participant.conditional_type === 'users') {
    return usersMet
  }

  return false
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ConfirmationDashboard({ tripId }: ConfirmationDashboardProps) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [trip, setTrip] = useState<any>(null)
  const [expandedSections, setExpandedSections] = useState<Set<ConfirmationStatus>>(new Set())

  // Update Confirmation Modal State
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false)
  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null)

  useEffect(() => {
    fetchData()
  }, [tripId])

  const fetchData = async () => {
    setLoading(true)

    // Fetch trip details
    const { data: tripData } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single()

    // Fetch participants with user details
    const { data: participantsData } = await supabase
      .from('trip_participants')
      .select(`
        *,
        user:user_id (*)
      `)
      .eq('trip_id', tripId)

    setTrip(tripData)
    const allParticipants = (participantsData as any[]) || []
    setParticipants(allParticipants)

    // Smart default expansion: expanded when gathering confirmations, collapsed when full
    const confirmedCount = allParticipants.filter((p) => p.confirmation_status === 'confirmed').length
    const capacityLimit = tripData?.capacity_limit
    const isFull = capacityLimit && confirmedCount >= capacityLimit

    // If full: collapse all sections (compact mode)
    // If not full: expand key sections to encourage participation
    if (!isFull) {
      setExpandedSections(new Set(['confirmed', 'conditional']))
    }
    // If full, leave all collapsed (empty Set)

    setLoading(false)
  }

  const handleOpenUpdateModal = (participant: Participant) => {
    setSelectedParticipant(participant)
    setIsUpdateModalOpen(true)
  }

  const handleCloseUpdateModal = () => {
    setIsUpdateModalOpen(false)
    setSelectedParticipant(null)
  }

  const handleUpdateSuccess = () => {
    // Refresh data to show updated status
    fetchData()
  }

  // Group participants by status
  const groupedParticipants: Record<ConfirmationStatus, Participant[]> = {
    pending: [],
    confirmed: [],
    interested: [],
    conditional: [],
    waitlist: [],
    declined: [],
    cancelled: [],
  }

  participants.forEach((p) => {
    let status = p.confirmation_status || 'pending'
    // Merge cancelled into declined
    if (status === 'cancelled') {
      status = 'declined'
    }
    groupedParticipants[status].push(p)
  })

  // ============================================================================
  // SMART ORDERING
  // ============================================================================

  // Sort confirmed by confirmed_at (first-come-first-served)
  groupedParticipants.confirmed.sort((a, b) => {
    if (!a.confirmed_at) return 1
    if (!b.confirmed_at) return -1
    return new Date(a.confirmed_at).getTime() - new Date(b.confirmed_at).getTime()
  })

  // Sort conditional by effective deadline (closest → furthest → no deadline)
  groupedParticipants.conditional.sort((a, b) => {
    const deadlineA = getEffectiveDeadline(a, participants)
    const deadlineB = getEffectiveDeadline(b, participants)

    // Both have deadlines: sort by date
    if (deadlineA && deadlineB) {
      return deadlineA.getTime() - deadlineB.getTime()
    }

    // Only A has deadline: A comes first
    if (deadlineA && !deadlineB) return -1

    // Only B has deadline: B comes first
    if (!deadlineA && deadlineB) return 1

    // Neither has deadline: alphabetical by name
    const nameA = a.user?.full_name || a.user?.email || ''
    const nameB = b.user?.full_name || b.user?.email || ''
    return nameA.localeCompare(nameB)
  })

  // Sort waitlist by updated_at (FIFO - who got waitlisted first)
  groupedParticipants.waitlist.sort((a, b) => {
    if (!a.updated_at) return 1
    if (!b.updated_at) return -1
    return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
  })

  // Calculate capacity stats
  const confirmedCount = groupedParticipants.confirmed.length
  const conditionalCount = groupedParticipants.conditional.length
  const waitlistCount = groupedParticipants.waitlist.length
  const capacityLimit = trip?.capacity_limit || null
  const isFull = capacityLimit && confirmedCount >= capacityLimit

  // Check if current user's conditions are met
  const currentUserParticipant = participants.find((p) => p.user_id === user?.id)
  const currentUserConditionsMet =
    currentUserParticipant && currentUserParticipant.confirmation_status === 'conditional'
      ? areConditionsMet(currentUserParticipant, participants)
      : false

  // Calculate days until deadline
  let daysUntilDeadline: number | null = null
  if (trip?.confirmation_deadline) {
    const deadline = new Date(trip.confirmation_deadline)
    const now = new Date()
    const diffTime = deadline.getTime() - now.getTime()
    daysUntilDeadline = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  }

  const toggleSection = (status: ConfirmationStatus) => {
    const newExpanded = new Set(expandedSections)
    if (newExpanded.has(status)) {
      newExpanded.delete(status)
    } else {
      newExpanded.add(status)
    }
    setExpandedSections(newExpanded)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!trip?.confirmation_enabled) {
    return (
      <Card>
        <Card.Content className="py-12">
          <EmptyState
            icon="🔒"
            title="Confirmations not enabled"
            description="The trip organizer hasn't enabled the confirmation system for this trip yet."
          />
        </Card.Content>
      </Card>
    )
  }

  // Status order for display (with red cutoff line after confirmed if at capacity)
  const statusOrder: ConfirmationStatus[] = [
    'confirmed',
    'conditional',
    'waitlist',
    'pending',
    'declined',
  ]

  return (
    <div className="space-y-6">
      {/* ====================================================================== */}
      {/* SINGLE CONSOLIDATED CARD */}
      {/* ====================================================================== */}
      <Card>
        <Card.Content className="!pt-4">
          <div className="space-y-6">
            {/* Card Header */}
            <div className="pb-6 border-b border-gray-200">
              <h2 className="text-2xl font-bold text-gray-900">Trip Confirmations</h2>
            </div>

            {/* Important Information (if exists) */}
            {trip.confirmation_message && (
              <div className="pb-6 border-b border-gray-200">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">📢</div>
                  <div className="flex-1 space-y-2">
                    <h3 className="font-semibold text-gray-900">Important Information</h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">
                      {trip.confirmation_message}
                    </p>
                    {trip.estimated_accommodation_cost && (
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-gray-600">
                          Estimated accommodation cost to commit:{' '}
                          <span className="font-semibold text-gray-900">
                            {trip.accommodation_cost_currency} {trip.estimated_accommodation_cost.toFixed(2)}
                          </span>
                        </span>
                        {trip.full_cost_link && (
                          <a
                            href={trip.full_cost_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-600 hover:text-primary-700 underline"
                          >
                            View full costs →
                          </a>
                        )}
                      </div>
                    )}
                    {trip.confirmation_deadline && (
                      <div className="text-sm text-primary-700 font-medium">
                        Aiming to finalize booking by:{' '}
                        {new Date(trip.confirmation_deadline).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                        {daysUntilDeadline !== null && (
                          <span className="ml-2">
                            ({daysUntilDeadline > 0 ? `${daysUntilDeadline} days left` : 'Date passed'})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Ready to Confirm! Banner (if conditions met) */}
            {currentUserConditionsMet && (
              <div className="pb-6 border-b border-gray-200">
                <div className="bg-success-50 border-2 border-success-500 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <div className="text-2xl">✅</div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-success-900 mb-1">Ready to Confirm!</h3>
                      <p className="text-sm text-success-800 mb-3">
                        Your conditions have been met! You can now update your status to "Confirmed" to
                        secure your spot.
                      </p>
                      <Button
                        size="sm"
                        onClick={() => currentUserParticipant && handleOpenUpdateModal(currentUserParticipant)}
                      >
                        Confirm Now
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* YOUR STATUS */}
            {currentUserParticipant && (
              <div className="pb-6 border-b border-gray-200">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Your Status</h3>
                    <div className="flex items-center gap-3 mb-2">
                      <ConfirmationStatusBadge
                        status={currentUserParticipant.confirmation_status}
                        size="lg"
                      />
                      {currentUserParticipant.confirmation_status === 'confirmed' &&
                        currentUserParticipant.confirmed_at && (
                          <span className="text-sm text-gray-600">
                            Confirmed{' '}
                            {new Date(currentUserParticipant.confirmed_at).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                        )}
                    </div>
                    {/* Status explanation */}
                    <p className="text-sm text-gray-600 mb-2">
                      {currentUserParticipant.confirmation_status === 'confirmed' &&
                        'You\'re locked in! Others are counting on you. You cannot change your status.'}
                      {currentUserParticipant.confirmation_status === 'conditional' &&
                        'You\'ll confirm once certain conditions are met.'}
                      {currentUserParticipant.confirmation_status === 'waitlist' &&
                        'You\'re on the waitlist. You\'ll get a spot if someone cancels.'}
                      {currentUserParticipant.confirmation_status === 'pending' &&
                        'Please update your status so the organizer knows your plans.'}
                      {(currentUserParticipant.confirmation_status === 'declined' || currentUserParticipant.confirmation_status === 'cancelled') &&
                        'You\'ve declined this trip.'}
                    </p>
                    {currentUserParticipant.confirmation_note && (
                      <p className="text-sm text-gray-600 italic mt-2">
                        "{currentUserParticipant.confirmation_note}"
                      </p>
                    )}
                    {currentUserParticipant.confirmation_status === 'conditional' &&
                      currentUserParticipant.conditional_type !== 'none' && (
                        <div className="mt-2">
                          <ConditionalDependencyDisplay
                            conditionalType={currentUserParticipant.conditional_type}
                            conditionalDate={currentUserParticipant.conditional_date}
                            conditionalUserIds={currentUserParticipant.conditional_user_ids}
                            participants={participants}
                            size="sm"
                          />
                        </div>
                      )}
                  </div>
                  <Button variant="outline" onClick={() => handleOpenUpdateModal(currentUserParticipant)}>
                    Update Status
                  </Button>
                </div>
              </div>
            )}

            {/* TRIP CAPACITY */}
            <div className="pb-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Trip Capacity</h3>
              <CapacityProgressBar
                confirmedCount={confirmedCount}
                capacityLimit={capacityLimit}
                conditionalCount={conditionalCount}
                waitlistCount={waitlistCount}
              />
            </div>

            {/* WHO'S COMING? */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Who's Coming?</h3>

              {/* Participant Groups */}
              <div className="space-y-2.5">
                {statusOrder.map((status) => {
                  const statusParticipants = groupedParticipants[status]
                  if (statusParticipants.length === 0) return null

                  const section = STATUS_SECTIONS[status]
                  const isExpanded = expandedSections.has(status)

                  // Show red cutoff line after confirmed section if at capacity
                  const showRedCutoff = status === 'confirmed' && isFull

                  return (
                    <div key={status}>
                      {/* Section Header */}
                      <button
                        onClick={() => toggleSection(status)}
                        className="w-full text-left px-4 py-2.5 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-xl">{section.icon}</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="font-medium text-gray-900">{section.title}</h4>
                                <ConfirmationStatusBadge
                                  status={status}
                                  count={statusParticipants.length}
                                  size="sm"
                                />
                              </div>
                              <p className="text-xs text-gray-600">{section.description}</p>
                            </div>
                          </div>
                          <svg
                            className={`w-5 h-5 text-gray-400 transition-transform ${
                              isExpanded ? 'transform rotate-180' : ''
                            }`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </div>
                      </button>

                      {/* Section Content */}
                      {isExpanded && (
                        <div className="mt-2 space-y-2 pl-4">
                          {statusParticipants.map((participant, index) => {
                            const conditionsMet = areConditionsMet(participant, participants)
                            const effectiveDeadline =
                              status === 'conditional'
                                ? getEffectiveDeadline(participant, participants)
                                : null

                            return (
                              <div
                                key={participant.user_id}
                                className="flex items-start gap-3 px-3 py-2 bg-white border border-gray-200 rounded-lg"
                              >
                                {/* Avatar */}
                                <div
                                  className="w-10 h-10 rounded-full flex flex-col items-center justify-center flex-shrink-0"
                                  style={{
                                    backgroundColor:
                                      (participant.user?.avatar_data as any)?.bgColor || '#0ea5e9',
                                  }}
                                >
                                  {(participant.user?.avatar_data as any)?.accessory && (
                                    <span className="text-xs -mb-1">
                                      {(participant.user?.avatar_data as any)?.accessory}
                                    </span>
                                  )}
                                  <span className="text-base">
                                    {(participant.user?.avatar_data as any)?.emoji || '😊'}
                                  </span>
                                </div>

                                {/* Details */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <h5 className="font-medium text-gray-900 text-sm">
                                      {participant.user?.full_name || participant.user?.email}
                                    </h5>
                                    {participant.role === 'organizer' && (
                                      <span className="text-xs px-1.5 py-0.5 bg-primary-100 text-primary-700 rounded">
                                        Organizer
                                      </span>
                                    )}
                                    {participant.user_id === user?.id && (
                                      <span className="text-xs px-1.5 py-0.5 bg-secondary-100 text-secondary-700 rounded">
                                        You
                                      </span>
                                    )}
                                    {conditionsMet && status === 'conditional' && (
                                      <span className="text-xs px-1.5 py-0.5 bg-success-100 text-success-700 rounded flex items-center gap-1">
                                        ✓ Conditions met
                                      </span>
                                    )}
                                  </div>

                                  {/* Confirmed timestamp */}
                                  {status === 'confirmed' && participant.confirmed_at && (
                                    <div className="text-xs text-gray-500 mt-0.5">
                                      Confirmed{' '}
                                      {new Date(participant.confirmed_at).toLocaleDateString('en-GB', {
                                        day: 'numeric',
                                        month: 'short',
                                        year: 'numeric',
                                      })}
                                      {index === 0 && (
                                        <span className="ml-1 text-success-600 font-medium">(First!)</span>
                                      )}
                                    </div>
                                  )}

                                  {/* Effective deadline for conditional */}
                                  {status === 'conditional' && effectiveDeadline && (
                                    <div className="text-xs text-gray-500 mt-0.5">
                                      Effective deadline:{' '}
                                      {effectiveDeadline.toLocaleDateString('en-GB', {
                                        day: 'numeric',
                                        month: 'short',
                                        year: 'numeric',
                                      })}
                                    </div>
                                  )}

                                  {/* Confirmation note */}
                                  {participant.confirmation_note && (
                                    <p className="text-xs text-gray-600 mt-1">
                                      {participant.confirmation_note}
                                    </p>
                                  )}

                                  {/* Conditional dependencies */}
                                  {status === 'conditional' && participant.conditional_type !== 'none' && (
                                    <div className="mt-1">
                                      <ConditionalDependencyDisplay
                                        conditionalType={participant.conditional_type}
                                        conditionalDate={participant.conditional_date}
                                        conditionalUserIds={participant.conditional_user_ids}
                                        participants={participants}
                                        size="sm"
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Red Cutoff Line (after confirmed section if at capacity) */}
                      {showRedCutoff && (
                        <div className="mt-4 mb-4">
                          <div className="relative">
                            <div className="absolute inset-0 flex items-center" aria-hidden="true">
                              <div className="w-full border-t-2 border-red-500"></div>
                            </div>
                            <div className="relative flex justify-center">
                              <span className="px-3 bg-white text-xs font-medium text-red-700 uppercase tracking-wide">
                                Trip is Full
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </Card.Content>
      </Card>

      {/* Update Confirmation Modal */}
      <UpdateConfirmationModal
        isOpen={isUpdateModalOpen}
        onClose={handleCloseUpdateModal}
        tripId={tripId}
        participant={selectedParticipant}
        participants={participants}
        capacityLimit={capacityLimit}
        confirmedCount={confirmedCount}
        onSuccess={handleUpdateSuccess}
      />
    </div>
  )
}
