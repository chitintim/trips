import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Badge, Spinner, EmptyState } from '../components/ui'
import { CreateTripModal, AddParticipantModal } from '../components'
import { CreatePlanningSectionModal } from '../components/CreatePlanningSectionModal'
import { CreateOptionModal } from '../components/CreateOptionModal'
import { Trip, User, TripParticipant } from '../types'

type TripTab = 'overview' | 'planning' | 'expenses' | 'chat'

interface ParticipantWithUser extends TripParticipant {
  user: User
}

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [participants, setParticipants] = useState<ParticipantWithUser[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TripTab>('overview')
  const [isAdmin, setIsAdmin] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [addParticipantModalOpen, setAddParticipantModalOpen] = useState(false)

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

    // Fetch participants with user details
    const { data: participantsData } = await supabase
      .from('trip_participants')
      .select(`
        *,
        user:user_id (*)
      `)
      .eq('trip_id', tripId)

    setTrip(tripData)
    setParticipants((participantsData as any[]) || [])
    setLoading(false)
  }

  const handleEditTrip = () => {
    setEditModalOpen(true)
  }

  const handleDeleteTrip = async () => {
    if (!trip) return

    const confirmMessage = `⚠️ Delete "${trip.name}"?\n\nThis will permanently delete the trip and all associated data including:\n- Planning sections\n- Options and selections\n- Comments\n- Expense records\n\nThis action CANNOT be undone!\n\nAre you absolutely sure?`

    if (!window.confirm(confirmMessage)) {
      return
    }

    const { error } = await supabase
      .from('trips')
      .delete()
      .eq('id', trip.id)

    if (error) {
      alert(`Error deleting trip: ${error.message}`)
      return
    }

    // Navigate back to dashboard
    navigate('/dashboard')
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

  const formatDateRange = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }

    return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`
  }

  const getDuration = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/dashboard')}
            >
              ← Back to Dashboard
            </Button>
            {isAdmin && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleEditTrip}>
                  Edit Trip
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDeleteTrip}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  Delete Trip
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-start justify-between mb-4">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-3xl font-bold text-gray-900">{trip.name}</h1>
                <Badge
                  variant={
                    trip.status === 'booked'
                      ? 'success'
                      : trip.status === 'booking'
                      ? 'info'
                      : 'warning'
                  }
                >
                  {trip.status}
                </Badge>
              </div>
              <div className="flex items-center gap-4 text-gray-600">
                <span>📍 {trip.location}</span>
                <span>📅 {formatDateRange(trip.start_date, trip.end_date)}</span>
                <span>⏱️ {getDuration(trip.start_date, trip.end_date)}</span>
              </div>
            </div>
          </div>

          {/* Participants */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-700">Participants ({participants.length})</h3>
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={handleAddParticipant}>
                  + Add Participant
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {participants.map((participant) => (
                <div
                  key={participant.user_id}
                  className="flex items-center gap-2 bg-gray-100 rounded-full px-3 py-1"
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-lg"
                    style={{
                      backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                  >
                    {(participant.user.avatar_data as any)?.emoji || '😊'}
                  </div>
                  <span className="text-sm font-medium text-gray-900">
                    {participant.user.full_name || participant.user.email}
                  </span>
                  {participant.role === 'organizer' && (
                    <Badge variant="secondary" className="text-xs">
                      Organizer
                    </Badge>
                  )}
                </div>
              ))}
            </div>
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
              📋 Overview
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
              onClick={() => setActiveTab('chat')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'chat'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              💬 Chat
            </button>
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        {activeTab === 'overview' && <TripOverviewTab trip={trip} participants={participants} />}
        {activeTab === 'planning' && <PlanningTab trip={trip} participants={participants} />}
        {activeTab === 'expenses' && <ComingSoonTab title="Expenses" description="Expense tracking, receipt uploads, and splits will be available here." />}
        {activeTab === 'chat' && <ComingSoonTab title="Chat" description="Trip chat and comments will be available here." />}
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
}: {
  trip: Trip
  participants: ParticipantWithUser[]
}) {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)

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

  const handleRemoveParticipant = async (participant: ParticipantWithUser) => {
    if (!window.confirm(`Remove ${participant.user.full_name || participant.user.email} from this trip?`)) {
      return
    }

    const { error } = await supabase
      .from('trip_participants')
      .delete()
      .eq('trip_id', trip.id)
      .eq('user_id', participant.user_id)

    if (error) {
      alert(`Error removing participant: ${error.message}`)
      return
    }

    // Refresh the page to show updated participants
    window.location.reload()
  }
  return (
    <div className="space-y-6">
      {/* Trip Details Card */}
      <Card>
        <Card.Header>
          <Card.Title>Trip Details</Card.Title>
          <Card.Description>Basic information about this trip</Card.Description>
        </Card.Header>
        <Card.Content>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">Trip Name</dt>
              <dd className="text-base text-gray-900">{trip.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">Location</dt>
              <dd className="text-base text-gray-900">{trip.location}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">Start Date</dt>
              <dd className="text-base text-gray-900">
                {new Date(trip.start_date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">End Date</dt>
              <dd className="text-base text-gray-900">
                {new Date(trip.end_date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">Status</dt>
              <dd className="text-base text-gray-900">
                <Badge
                  variant={
                    trip.status === 'booked'
                      ? 'success'
                      : trip.status === 'booking'
                      ? 'info'
                      : 'warning'
                  }
                >
                  {trip.status}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-1">Participants</dt>
              <dd className="text-base text-gray-900">{participants.length} people</dd>
            </div>
          </dl>
        </Card.Content>
      </Card>

      {/* Participants Card */}
      <Card>
        <Card.Header>
          <Card.Title>Participants</Card.Title>
          <Card.Description>People joining this trip</Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="space-y-3">
            {participants.map((participant) => (
              <div
                key={participant.user_id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-xl"
                    style={{
                      backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                  >
                    {(participant.user.avatar_data as any)?.emoji || '😊'}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">
                      {participant.user.full_name || 'Unknown'}
                    </div>
                    <div className="text-sm text-gray-500">{participant.user.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={participant.role === 'organizer' ? 'primary' : 'neutral'}>
                    {participant.role}
                  </Badge>
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
      </Card>
    </div>
  )
}

// Planning Tab Component
function PlanningTab({
  trip,
  participants,
}: {
  trip: Trip
  participants: ParticipantWithUser[]
}) {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [sections, setSections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createSectionModalOpen, setCreateSectionModalOpen] = useState(false)
  const [createOptionModalOpen, setCreateOptionModalOpen] = useState(false)
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)

  useEffect(() => {
    checkAdminStatus()
    fetchPlanningSections()
  }, [trip.id])

  const checkAdminStatus = async () => {
    if (!user) return

    // Check if user is system admin
    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const isSystemAdmin = userData?.role === 'admin'

    // Check if user is trip organizer or trip creator
    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id

    // User can manage planning if they're system admin, trip creator, or trip organizer
    const canManage = isSystemAdmin || isTripCreator || isTripOrganizer
    console.log('Planning admin check:', {
      isSystemAdmin,
      isTripCreator,
      isTripOrganizer,
      canManage,
      userId: user.id,
      tripCreatedBy: trip.created_by
    })
    setIsAdmin(canManage)
  }

  const fetchPlanningSections = async () => {
    setLoading(true)

    // Fetch sections with their options and selections
    const { data: sectionsData, error } = await supabase
      .from('planning_sections')
      .select(`
        *,
        options (
          *,
          selections (
            *,
            user:user_id (*)
          )
        )
      `)
      .eq('trip_id', trip.id)
      .order('order_index', { ascending: true })

    if (!error && sectionsData) {
      setSections(sectionsData)
    }

    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <>
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="📋"
              title="No planning sections yet"
              description={isAdmin ? "Start by creating planning sections like Accommodation, Flights, or Transport." : "The trip organizer will add planning sections soon."}
              action={
                isAdmin ? (
                  <Button
                    variant="primary"
                    onClick={() => setCreateSectionModalOpen(true)}
                  >
                    + Create Section
                  </Button>
                ) : undefined
              }
            />
          </Card.Content>
        </Card>

        {/* Create Section Modal */}
        <CreatePlanningSectionModal
          isOpen={createSectionModalOpen}
          onClose={() => setCreateSectionModalOpen(false)}
          tripId={trip.id}
          onSuccess={fetchPlanningSections}
        />
      </>
    )
  }

  const handleCreateOption = (sectionId: string) => {
    setSelectedSectionId(sectionId)
    setCreateOptionModalOpen(true)
  }

  return (
    <>
      <div className="space-y-6">
        {/* Header with Create Section Button */}
        {isAdmin && (
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setCreateSectionModalOpen(true)}
            >
              + Create Section
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {sections.map((section) => (
              <PlanningSectionCard
                key={section.id}
                section={section}
                trip={trip}
                participants={participants}
                isAdmin={isAdmin}
                onUpdate={fetchPlanningSections}
                onCreateOption={handleCreateOption}
              />
            ))}
          </div>

          {/* Selection Summary Sidebar */}
          <div className="lg:col-span-1">
            <SelectionSummary
              sections={sections}
              userId={user?.id || ''}
            />
          </div>
        </div>
      </div>

      {/* Modals */}
      <CreatePlanningSectionModal
        isOpen={createSectionModalOpen}
        onClose={() => setCreateSectionModalOpen(false)}
        tripId={trip.id}
        onSuccess={fetchPlanningSections}
      />

      {selectedSectionId && (
        <CreateOptionModal
          isOpen={createOptionModalOpen}
          onClose={() => {
            setCreateOptionModalOpen(false)
            setSelectedSectionId(null)
          }}
          sectionId={selectedSectionId}
          onSuccess={fetchPlanningSections}
        />
      )}
    </>
  )
}

// Planning Section Card Component
function PlanningSectionCard({
  section,
  trip,
  participants,
  isAdmin,
  onUpdate,
  onCreateOption,
}: {
  section: any
  trip: Trip
  participants: ParticipantWithUser[]
  isAdmin: boolean
  onUpdate: () => void
  onCreateOption: (sectionId: string) => void
}) {
  const options = section.options || []
  const availableOptions = options.filter((opt: any) => opt.status !== 'draft' && opt.status !== 'cancelled')

  // Calculate how many people have made selections in this section
  const participantIds = participants.map(p => p.user_id)
  const selectionsCount = new Set(
    options.flatMap((opt: any) =>
      (opt.selections || [])
        .filter((sel: any) => participantIds.includes(sel.user_id))
        .map((sel: any) => sel.user_id)
    )
  ).size

  return (
    <Card>
      <Card.Header>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Card.Title>{section.title}</Card.Title>
              <Badge
                variant={
                  section.status === 'completed'
                    ? 'success'
                    : section.status === 'in_progress'
                    ? 'info'
                    : 'neutral'
                }
              >
                {section.status.replace('_', ' ')}
              </Badge>
            </div>
            {section.description && (
              <Card.Description>{section.description}</Card.Description>
            )}
            <div className="mt-2 text-sm text-gray-600">
              {selectionsCount} of {participants.length} people made selections
            </div>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCreateOption(section.id)}
            >
              + Add Option
            </Button>
          )}
        </div>
      </Card.Header>
      <Card.Content>
        {availableOptions.length === 0 ? (
          <EmptyState
            icon="📝"
            title="No options yet"
            description={isAdmin ? "Add options for this section" : "No options available yet"}
            action={
              isAdmin ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onCreateOption(section.id)}
                >
                  + Add Option
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {availableOptions.map((option: any) => (
              <OptionCard
                key={option.id}
                option={option}
                section={section}
                trip={trip}
                participants={participants}
                isAdmin={isAdmin}
                isLocked={trip.status === 'booked' || option.locked}
                onUpdate={onUpdate}
              />
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  )
}

// Option Card Component
function OptionCard({
  option,
  section,
  isLocked,
  onUpdate,
}: {
  option: any
  section: any
  trip: Trip
  participants: ParticipantWithUser[]
  isAdmin: boolean
  isLocked: boolean
  onUpdate: () => void
}) {
  const { user } = useAuth()
  const selections = option.selections || []
  const userSelection = selections.find((sel: any) => sel.user_id === user?.id)
  const isSelected = !!userSelection

  // Calculate price based on price_type
  const calculatePrice = () => {
    if (!option.price) return null

    if (option.price_type === 'total_split') {
      const numSelectors = selections.length
      if (numSelectors === 0) return option.price
      return option.price / numSelectors
    }

    return option.price
  }

  const price = calculatePrice()
  const currency = option.currency || 'EUR'

  const handleToggleSelection = async () => {
    if (isLocked) {
      alert('This option is locked and cannot be changed.')
      return
    }

    if (!user) return

    if (isSelected) {
      // Remove selection
      const { error } = await supabase
        .from('selections')
        .delete()
        .eq('id', userSelection.id)

      if (error) {
        alert(`Error removing selection: ${error.message}`)
        return
      }
    } else {
      // For single-choice sections, remove other selections in this section first
      if (!section.allow_multiple_selections) {
        // Get all option IDs in this section
        const sectionOptionIds = (section.options || []).map((opt: any) => opt.id)

        // Delete all user's selections in this section
        const { error: deleteError } = await supabase
          .from('selections')
          .delete()
          .eq('user_id', user.id)
          .in('option_id', sectionOptionIds)

        if (deleteError) {
          alert(`Error clearing previous selection: ${deleteError.message}`)
          return
        }
      }

      // Add new selection
      const { error } = await supabase
        .from('selections')
        .insert({
          option_id: option.id,
          user_id: user.id,
          metadata: {}
        })

      if (error) {
        alert(`Error adding selection: ${error.message}`)
        return
      }
    }

    onUpdate()
  }

  return (
    <div
      className={`border rounded-lg p-4 transition-all ${
        isSelected
          ? 'border-sky-500 bg-sky-50'
          : 'border-gray-200 hover:border-gray-300'
      } ${isLocked ? 'opacity-75' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="font-medium text-gray-900">{option.title}</h4>
            {option.status && (
              <Badge
                variant={
                  option.status === 'booked'
                    ? 'success'
                    : option.status === 'booking'
                    ? 'info'
                    : 'neutral'
                }
                className="text-xs"
              >
                {option.status}
              </Badge>
            )}
            {isLocked && (
              <span className="text-xs text-gray-500">🔒 Locked</span>
            )}
          </div>

          {option.description && (
            <p className="text-sm text-gray-600 mb-3">{option.description}</p>
          )}

          {/* Price Display */}
          {price !== null && (
            <div className="mb-3">
              <span className="text-lg font-bold text-gray-900">
                {currency} {price.toFixed(2)}
              </span>
              {option.price_type === 'total_split' && selections.length > 0 && (
                <span className="text-sm text-gray-600 ml-2">
                  (Total: {currency} {option.price.toFixed(2)} ÷ {selections.length} {selections.length === 1 ? 'person' : 'people'})
                </span>
              )}
              {option.price_type === 'per_person_fixed' && (
                <span className="text-sm text-gray-600 ml-2">per person</span>
              )}
            </div>
          )}

          {/* Social Proof - Who Selected This */}
          {selections.length > 0 && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm text-gray-600">Selected by:</span>
              <div className="flex items-center gap-1">
                {selections.slice(0, 5).map((sel: any) => (
                  <div
                    key={sel.id}
                    className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                    style={{
                      backgroundColor: (sel.user?.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                    title={sel.user?.full_name || sel.user?.email}
                  >
                    {(sel.user?.avatar_data as any)?.emoji || '😊'}
                  </div>
                ))}
                {selections.length > 5 && (
                  <span className="text-sm text-gray-600 ml-1">
                    +{selections.length - 5} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Selection Button */}
        <div>
          <Button
            variant={isSelected ? 'primary' : 'outline'}
            size="sm"
            onClick={handleToggleSelection}
            disabled={isLocked}
          >
            {isSelected ? '✓ Selected' : 'Select'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Selection Summary Sidebar Component
function SelectionSummary({
  sections,
  userId,
}: {
  sections: any[]
  userId: string
}) {
  // Get all user's selections across all sections
  const userSelections = sections.flatMap(section =>
    (section.options || []).flatMap((option: any) =>
      (option.selections || [])
        .filter((sel: any) => sel.user_id === userId)
        .map((sel: any) => ({ ...sel, option }))
    )
  )

  // Calculate total cost
  const totalCost = userSelections.reduce((sum, selection) => {
    const option = selection.option
    if (!option.price) return sum

    if (option.price_type === 'total_split') {
      const numSelectors = (option.selections || []).length
      return sum + (numSelectors > 0 ? option.price / numSelectors : option.price)
    }

    return sum + option.price
  }, 0)

  const currency = userSelections[0]?.option?.currency || 'EUR'

  return (
    <div className="sticky top-4">
      <Card>
        <Card.Header>
          <Card.Title>Your Selections</Card.Title>
          <Card.Description>
            {userSelections.length} {userSelections.length === 1 ? 'item' : 'items'} selected
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {userSelections.length === 0 ? (
            <EmptyState
              icon="📝"
              title="No selections yet"
              description="Select options from the planning sections"
            />
          ) : (
            <div className="space-y-3">
              {userSelections.map((selection) => {
                const option = selection.option
                const price = option.price_type === 'total_split'
                  ? (option.selections || []).length > 0
                    ? option.price / (option.selections || []).length
                    : option.price
                  : option.price

                return (
                  <div key={selection.id} className="pb-3 border-b border-gray-200 last:border-0">
                    <div className="font-medium text-sm text-gray-900 mb-1">
                      {option.title}
                    </div>
                    {option.price && (
                      <div className="text-sm text-gray-600">
                        {option.currency || currency} {price.toFixed(2)}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Total */}
              <div className="pt-3 border-t-2 border-gray-300">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-gray-900">Total:</span>
                  <span className="font-bold text-lg text-sky-600">
                    {currency} {totalCost.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}

// Coming Soon Tab Placeholder
function ComingSoonTab({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <Card.Content className="py-12">
        <EmptyState
          icon="🚧"
          title={`${title} - Coming Soon`}
          description={description}
        />
      </Card.Content>
    </Card>
  )
}
