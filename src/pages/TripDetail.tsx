import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { useScrollDirection } from '../hooks/useScrollDirection'
import { Button, Card, Badge, Spinner, EmptyState } from '../components/ui'
import { CreateTripModal, AddParticipantModal, TripNotesSection, ExpensesTab, ConfirmationDashboard, ConfirmationSettingsPanel } from '../components'
import { PlanningTabV2 } from '../components/planning/PlanningTabV2'
import { Trip, User, TripParticipant } from '../types'
import { getTripStatusBadgeVariant, getTripStatusLabel } from '../lib/tripStatus'

type TripTab = 'overview' | 'planning' | 'expenses' | 'notes'

interface ParticipantWithUser extends TripParticipant {
  user: User
}

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const scrollDirection = useScrollDirection()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [participants, setParticipants] = useState<ParticipantWithUser[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TripTab>('overview')
  const [isAdmin, setIsAdmin] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [addParticipantModalOpen, setAddParticipantModalOpen] = useState(false)
  const [hasSetInitialTab, setHasSetInitialTab] = useState(false)

  // Handle tab query parameter (e.g., from "Back to Expenses" button)
  useEffect(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam && ['overview', 'planning', 'expenses', 'notes'].includes(tabParam)) {
      setActiveTab(tabParam as TripTab)
      setHasSetInitialTab(true)
      // Clear the query param after setting tab
      searchParams.delete('tab')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Set default tab based on user's confirmation status and trip status (only on initial load)
  useEffect(() => {
    if (trip && participants.length > 0 && user && !hasSetInitialTab && !searchParams.get('tab')) {
      let defaultTab: TripTab = 'overview'

      // Find current user's participant record
      const currentUserParticipant = participants.find(p => p.user_id === user.id)
      const isConfirmed = currentUserParticipant?.confirmation_status === 'confirmed'

      // If user hasn't confirmed, always show People tab so they can take action
      if (!isConfirmed) {
        defaultTab = 'overview'
      } else {
        // User is confirmed - use trip status to determine tab
        switch (trip.status) {
          case 'gathering_interest':
          case 'confirming_participants':
            defaultTab = 'overview' // People tab
            break
          case 'booking_details':
          case 'booked_awaiting_departure':
            defaultTab = 'planning' // Planning tab
            break
          case 'trip_ongoing':
          case 'trip_completed':
            defaultTab = 'expenses' // Expenses tab
            break
          default:
            defaultTab = 'overview'
        }
      }

      setActiveTab(defaultTab)
      setHasSetInitialTab(true)
    }
  }, [trip, participants, user, hasSetInitialTab, searchParams])

  useEffect(() => {
    if (!tripId) {
      setLoading(false)
      return
    }
    fetchTripData()
  }, [tripId])

  useEffect(() => {
    checkAdminStatus()
  }, [user])

  const checkAdminStatus = async () => {
    if (!user) return
    const { data } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (data) {
      setIsAdmin(data.role === 'admin')
    }
  }

  const fetchTripData = async () => {
    if (!tripId) {
      setLoading(false)
      return
    }

    setLoading(true)

    // Fetch trip details
    const { data: tripData, error: tripError } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single()

    if (tripError || !tripData) {
      console.error('Error fetching trip:', tripError)
      setLoading(false)
      return
    }

    // Fetch participants with user details (only active ones)
    const { data: participantsData } = await supabase
      .from('trip_participants')
      .select(`
        *,
        user:user_id (*)
      `)
      .eq('trip_id', tripId)
      .eq('active', true)

    setTrip(tripData)
    setParticipants((participantsData as any[]) || [])
    setLoading(false)
  }

  const handleEditTrip = () => {
    setEditModalOpen(true)
  }

  const handleAddParticipant = () => {
    setAddParticipantModalOpen(true)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
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

  // Smart date formatting: only repeat month/year when they differ
  const formatDateRange = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)

    const startMonth = start.toLocaleDateString('en-US', { month: 'short' })
    const endMonth = end.toLocaleDateString('en-US', { month: 'short' })
    const startDay = start.getDate()
    const endDay = end.getDate()
    const startYear = start.getFullYear()
    const endYear = end.getFullYear()

    // Same month and year: "Jan 20-27, 2025"
    if (startMonth === endMonth && startYear === endYear) {
      return `${startMonth} ${startDay}-${endDay}, ${startYear}`
    }

    // Same year, different months: "Jan 20 - Feb 5, 2025"
    if (startYear === endYear) {
      return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${startYear}`
    }

    // Different years: "Dec 28, 2024 - Jan 3, 2025"
    return `${startMonth} ${startDay}, ${startYear} - ${endMonth} ${endDay}, ${endYear}`
  }

  // Countdown to trip
  const getCountdown = (startDate: string) => {
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div
        className={`bg-white border-b border-gray-200 sticky top-0 z-sticky transition-transform duration-300 ease-in-out ${
          scrollDirection === 'down' ? '-translate-y-full' : 'translate-y-0'
        }`}
      >
        <div className="max-w-6xl mx-auto px-4 py-3">
          {/* Trip Title Row */}
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                onClick={() => navigate('/dashboard')}
                className="text-gray-500 hover:text-gray-700 transition-colors flex-shrink-0"
                aria-label="Back to Dashboard"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">{trip.name}</h1>
              <Badge
                variant={getTripStatusBadgeVariant(trip.status)}
                className="flex-shrink-0"
              >
                {getTripStatusLabel(trip.status)}
              </Badge>
            </div>
            {isAdmin && (
              <div className="flex gap-1 flex-shrink-0">
                <Button variant="outline" size="sm" onClick={handleEditTrip} className="hidden sm:inline-flex">
                  Edit
                </Button>
                {/* Mobile: Compact menu button */}
                <Button variant="outline" size="sm" onClick={handleEditTrip} className="sm:hidden">
                  •••
                </Button>
              </div>
            )}
          </div>

          {/* Trip Details Row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 mb-3">
            <span className="flex items-center gap-1">
              <span className="text-base">📍</span>
              {trip.location}
            </span>
            <span className="flex items-center gap-1">
              <span className="text-base">📅</span>
              {formatDateRange(trip.start_date, trip.end_date)}
            </span>
            <span className="flex items-center gap-1 text-sky-600 font-medium">
              {getCountdown(trip.start_date)}
            </span>
          </div>

          {/* Tab Navigation */}
          <nav className="flex gap-1 border-b border-gray-200 -mb-px">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'overview'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              👥 People
            </button>
            <button
              onClick={() => setActiveTab('planning')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'planning'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              🗓️ Planning
            </button>
            <button
              onClick={() => setActiveTab('expenses')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'expenses'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              💰 Expenses
            </button>
            <button
              onClick={() => setActiveTab('notes')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'notes'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              📝 Notes
            </button>
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        {activeTab === 'overview' && <TripOverviewTab trip={trip} participants={participants} onAddParticipant={handleAddParticipant} />}
        {activeTab === 'planning' && <PlanningTabV2 trip={trip} participants={participants} />}
        {activeTab === 'expenses' && <ExpensesTab tripId={trip.id} participants={participants} />}
        {activeTab === 'notes' && <NotesTab trip={trip} />}
      </div>

      {/* Admin Modals */}
      {trip && (
        <>
          <CreateTripModal
            isOpen={editModalOpen}
            onClose={() => setEditModalOpen(false)}
            onSuccess={fetchTripData}
            editTrip={trip}
          />
          <AddParticipantModal
            isOpen={addParticipantModalOpen}
            onClose={() => setAddParticipantModalOpen(false)}
            tripId={trip.id}
            existingParticipantIds={participants.map((p) => p.user_id)}
            onSuccess={fetchTripData}
          />
        </>
      )}
    </div>
  )
}

// Overview Tab Component
function TripOverviewTab({
  trip,
  participants,
  onAddParticipant,
}: {
  trip: Trip
  participants: ParticipantWithUser[]
  onAddParticipant: () => void
}) {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [isOrganizer, setIsOrganizer] = useState(false)

  useEffect(() => {
    checkAdminStatus()
    checkOrganizerStatus()
  }, [user])

  const checkAdminStatus = async () => {
    if (!user) return
    const { data } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (data) {
      setIsAdmin(data.role === 'admin')
    }
  }

  const checkOrganizerStatus = async () => {
    if (!user) return

    // Check if user is system admin, trip creator, or trip organizer
    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const isSystemAdmin = userData?.role === 'admin'

    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id

    setIsOrganizer(isSystemAdmin || isTripCreator || isTripOrganizer)
  }

  const handleRemoveParticipant = async (participant: ParticipantWithUser) => {
    // Check if participant has expenses
    const { data: paidExpenses } = await supabase
      .from('expenses')
      .select('id')
      .eq('trip_id', trip.id)
      .eq('paid_by', participant.user_id)
      .limit(1)

    const { data: expenseSplits } = await supabase
      .from('expense_splits')
      .select('expense_id')
      .eq('user_id', participant.user_id)
      .limit(1)

    const hasExpenses = (paidExpenses && paidExpenses.length > 0) || (expenseSplits && expenseSplits.length > 0)

    let confirmMessage = `Remove ${participant.user.full_name || participant.user.email} from this trip?`
    if (hasExpenses) {
      confirmMessage += '\n\n⚠️ This user has expense records. They will be marked as inactive but their expenses will be preserved.'
    } else {
      confirmMessage += '\n\nThey will be marked as inactive and can be re-added later if needed.'
    }

    if (!window.confirm(confirmMessage)) {
      return
    }

    // Mark as inactive instead of deleting
    // NOTE: Requires 'active' field on trip_participants (default true)
    const { error } = await supabase
      .from('trip_participants')
      .update({
        active: false,
        updated_at: new Date().toISOString()
      })
      .eq('trip_id', trip.id)
      .eq('user_id', participant.user_id)

    if (error) {
      alert(`Error removing participant: ${error.message}\n\nNote: If you see a column error, the 'active' field needs to be added to the database.`)
      return
    }

    // Refresh the page to show updated participants
    window.location.reload()
  }

  const handleChangeParticipantRole = async (participant: ParticipantWithUser, newRole: 'organizer' | 'participant') => {
    const action = newRole === 'organizer' ? 'promote' : 'demote'
    const confirmMessage = newRole === 'organizer'
      ? `Promote ${participant.user.full_name || participant.user.email} to organizer? They will be able to edit this trip and manage participants.`
      : `Demote ${participant.user.full_name || participant.user.email} to participant? They will lose edit rights for this trip.`

    if (!window.confirm(confirmMessage)) {
      return
    }

    const { error } = await supabase
      .from('trip_participants')
      .update({ role: newRole })
      .eq('trip_id', trip.id)
      .eq('user_id', participant.user_id)

    if (error) {
      alert(`Error ${action}ing user: ${error.message}`)
      return
    }

    // Refresh the page to show updated role
    window.location.reload()
  }

  const [isParticipantsExpanded, setIsParticipantsExpanded] = useState(false)
  const [isConfirmationSettingsExpanded, setIsConfirmationSettingsExpanded] = useState(false)

  // Check if current user needs to confirm
  const currentUserParticipant = participants.find(p => p.user_id === user?.id)
  const needsToConfirm = currentUserParticipant && currentUserParticipant.confirmation_status !== 'confirmed'
  const confirmationStatus = currentUserParticipant?.confirmation_status

  return (
    <div className="space-y-4">
      {/* Action needed banner for unconfirmed users */}
      {needsToConfirm && (
        <Card className="!p-4 border-amber-300 bg-amber-50">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <h3 className="font-semibold text-amber-800">Action needed</h3>
              <p className="text-sm text-amber-700 mt-1">
                {confirmationStatus === 'pending' && "You haven't confirmed if you're joining this trip yet. Please update your status below!"}
                {confirmationStatus === 'interested' && "You've shown interest but haven't confirmed. Ready to commit? Update your status below!"}
                {confirmationStatus === 'conditional' && "Your spot is conditional. Check the details below and confirm when ready!"}
                {confirmationStatus === 'waitlist' && "You're on the waitlist. We'll let you know if a spot opens up!"}
                {confirmationStatus === 'declined' && "You've declined this trip. Changed your mind? You can update your status below."}
                {confirmationStatus === 'cancelled' && "Your spot was cancelled. Contact the organizer if you'd like to rejoin."}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Participants Card (Organizers/Admins only) */}
      {(isOrganizer || isAdmin) && (
        <Card className="!p-4">
        <Card.Header>
          <div
            className="cursor-pointer select-none"
            onClick={() => setIsParticipantsExpanded(!isParticipantsExpanded)}
          >
            <div className="flex items-start gap-3">
              {/* Chevron icon */}
              <button
                className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsParticipantsExpanded(!isParticipantsExpanded)
                }}
              >
                <svg
                  className={`w-5 h-5 transition-transform duration-200 ${isParticipantsExpanded ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {/* Title and description */}
              <div className="flex-1 min-w-0">
                <Card.Title className="!mb-0">Participants</Card.Title>
                <Card.Description className="mt-1 !mb-0">
                  {participants.length} {participants.length === 1 ? 'person' : 'people'} on this trip
                </Card.Description>
              </div>

              {/* Add button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddParticipant()
                }}
                className="flex-shrink-0"
              >
                + Add
              </Button>
            </div>
          </div>
        </Card.Header>

        {/* Content - only visible when expanded */}
        {isParticipantsExpanded && (
          <Card.Content>
            <div className="space-y-2">
              {participants.map((participant) => (
                <div
                  key={participant.user_id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-full flex flex-col items-center justify-center text-xl"
                      style={{
                        backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                      }}
                    >
                      {(participant.user.avatar_data as any)?.accessory && (
                        <span className="text-xs -mb-1">
                          {(participant.user.avatar_data as any)?.accessory}
                        </span>
                      )}
                      <span>
                        {(participant.user.avatar_data as any)?.emoji || '😊'}
                      </span>
                    </div>
                    <div>
                      <div className="font-medium text-gray-900">
                        {participant.user.full_name || 'Unknown'}
                      </div>
                      {(isAdmin || isOrganizer) && (
                        <div className="text-sm text-gray-500">{participant.user.email}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={participant.role === 'organizer' ? 'primary' : 'neutral'}>
                      {participant.role}
                    </Badge>
                    {/* Only show role management for admin/organizer, not on yourself */}
                    {(isAdmin || isOrganizer) && participant.user_id !== user?.id && (
                      <>
                        {participant.role === 'participant' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleChangeParticipantRole(participant, 'organizer')}
                            className="text-sky-600 hover:text-sky-700 hover:bg-sky-50"
                          >
                            Make Organizer
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleChangeParticipantRole(participant, 'participant')}
                            className="text-gray-600 hover:text-gray-700 hover:bg-gray-100"
                          >
                            Demote
                          </Button>
                        )}
                      </>
                    )}
                    {isAdmin && participant.user_id !== user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveParticipant(participant)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card.Content>
        )}
      </Card>
      )}

      {/* Confirmation Settings (Organizer Only) */}
      {isOrganizer && (
        <Card className="!p-4">
          <Card.Header>
            <div
              className="cursor-pointer select-none"
              onClick={() => setIsConfirmationSettingsExpanded(!isConfirmationSettingsExpanded)}
            >
              <div className="flex items-start gap-3">
                {/* Chevron icon */}
                <button
                  className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5 flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsConfirmationSettingsExpanded(!isConfirmationSettingsExpanded)
                  }}
                >
                  <svg
                    className={`w-5 h-5 transition-transform duration-200 ${isConfirmationSettingsExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                {/* Title and description */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Card.Title className="!mb-0">Confirmation Settings</Card.Title>
                    <Badge variant="secondary" size="sm">Organizer</Badge>
                  </div>
                  <Card.Description className="mt-1 !mb-0">
                    Configure the confirmation system for participants
                  </Card.Description>
                </div>
              </div>
            </div>
          </Card.Header>

          {/* Content - only visible when expanded */}
          {isConfirmationSettingsExpanded && (
            <Card.Content className="pt-4">
              <ConfirmationSettingsPanel
                tripId={trip.id}
                isOrganizer={isOrganizer}
                onUpdate={() => window.location.reload()}
              />
            </Card.Content>
          )}
        </Card>
      )}

      {/* Confirmations */}
      <ConfirmationDashboard tripId={trip.id} />
    </div>
  )
}

// Notes Tab Component
function NotesTab({ trip }: { trip: Trip }) {
  const { user } = useAuth()
  const [isOrganizer, setIsOrganizer] = useState(false)

  useEffect(() => {
    checkOrganizerStatus()
  }, [user])

  const checkOrganizerStatus = async () => {
    if (!user) return

    // Check if user is system admin, trip creator, or trip organizer
    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const isSystemAdmin = userData?.role === 'admin'

    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id

    setIsOrganizer(isSystemAdmin || isTripCreator || isTripOrganizer)
  }

  return (
    <div className="space-y-6">
      <TripNotesSection tripId={trip.id} isOrganizer={isOrganizer} />
    </div>
  )
}
