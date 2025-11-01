import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Badge, Spinner, EmptyState, SelectionAvatars } from '../components/ui'
import { CreateTripModal, AddParticipantModal, TripNotesSection, ExpensesTab } from '../components'
import { CreatePlanningSectionModal } from '../components/CreatePlanningSectionModal'
import { CreateOptionModal } from '../components/CreateOptionModal'
import { Trip, User, TripParticipant } from '../types'

type TripTab = 'overview' | 'planning' | 'expenses'

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
      <div className="bg-white border-b border-gray-200 sticky top-0 z-sticky">
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
                variant={
                  trip.status === 'booked'
                    ? 'success'
                    : trip.status === 'booking'
                    ? 'info'
                    : 'warning'
                }
                className="flex-shrink-0"
              >
                {trip.status}
              </Badge>
            </div>
            {isAdmin && (
              <div className="flex gap-1 flex-shrink-0">
                <Button variant="outline" size="sm" onClick={handleEditTrip} className="hidden sm:inline-flex">
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDeleteTrip}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 hidden sm:inline-flex"
                >
                  Delete
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

          {/* Participants */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs sm:text-sm font-medium text-gray-700">
                👥 {participants.length} {participants.length === 1 ? 'Participant' : 'Participants'}
              </h3>
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={handleAddParticipant} className="text-xs">
                  + Add
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {participants.map((participant) => (
                <div
                  key={participant.user_id}
                  className="flex items-center gap-1.5 bg-gray-100 rounded-full px-2 py-1"
                  title={participant.user.full_name || participant.user.email}
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-sm"
                    style={{
                      backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                  >
                    <span className="relative">
                      {(participant.user.avatar_data as any)?.emoji || '😊'}
                      {(participant.user.avatar_data as any)?.accessory && (
                        <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[0.5rem]">
                          {(participant.user.avatar_data as any)?.accessory}
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="text-xs sm:text-sm font-medium text-gray-900 max-w-[120px] sm:max-w-none truncate">
                    {participant.user.full_name || participant.user.email}
                  </span>
                  {participant.role === 'organizer' && (
                    <Badge variant="secondary" className="text-xs hidden sm:inline-flex">
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
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        {activeTab === 'overview' && <TripOverviewTab trip={trip} participants={participants} />}
        {activeTab === 'planning' && <PlanningTab trip={trip} participants={participants} />}
        {activeTab === 'expenses' && <ExpensesTab tripId={trip.id} participants={participants} />}
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
                    <span className="relative">
                      {(participant.user.avatar_data as any)?.emoji || '😊'}
                      {(participant.user.avatar_data as any)?.accessory && (
                        <span className="absolute -top-1 left-1/2 -translate-x-1/2 text-xs">
                          {(participant.user.avatar_data as any)?.accessory}
                        </span>
                      )}
                    </span>
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

      {/* Notes & Announcements */}
      <TripNotesSection tripId={trip.id} isOrganizer={isOrganizer} />
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
  const [editingOption, setEditingOption] = useState<any | null>(null)
  const [editingSection, setEditingSection] = useState<any | null>(null)

  useEffect(() => {
    checkAdminStatus()
  }, [trip.id, user])

  useEffect(() => {
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
          onClose={() => {
            setCreateSectionModalOpen(false)
            setEditingSection(null)
          }}
          tripId={trip.id}
          onSuccess={fetchPlanningSections}
          section={editingSection}
        />
      </>
    )
  }

  const handleCreateOption = (sectionId: string, option?: any) => {
    setSelectedSectionId(sectionId)
    setEditingOption(option || null)
    setCreateOptionModalOpen(true)
  }

  // Optimistic update for selections (avoids full refetch and scroll jumping)
  const handleSelectionUpdate = (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => {
    setSections(prevSections => {
      return prevSections.map(section => {
        if (section.id !== sectionId) return section

        return {
          ...section,
          options: section.options.map((option: any) => {
            if (action === 'remove' && option.id === optionId) {
              return {
                ...option,
                selections: option.selections.filter((s: any) => s.user_id !== userId)
              }
            }

            if (action === 'add') {
              // For single-choice sections, remove user's other selections
              if (!section.allow_multiple_selections && option.id !== optionId) {
                return {
                  ...option,
                  selections: option.selections.filter((s: any) => s.user_id !== userId)
                }
              }

              // Add selection to the target option
              if (option.id === optionId && newSelection) {
                return {
                  ...option,
                  selections: [...option.selections, newSelection]
                }
              }
            }

            return option
          })
        }
      })
    })
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
                onSelectionUpdate={handleSelectionUpdate}
                onCreateOption={handleCreateOption}
                onEditSection={(sec) => {
                  setEditingSection(sec)
                  setCreateSectionModalOpen(true)
                }}
                onDeleteSection={async (sec) => {
                  const optionCount = (sec.options || []).length
                  const totalSelections = (sec.options || []).reduce(
                    (sum: number, opt: any) => sum + (opt.selections || []).length,
                    0
                  )

                  let confirmMessage = `Delete section "${sec.title}"?`

                  if (optionCount > 0) {
                    confirmMessage = `⚠️ Warning: Delete section "${sec.title}"?\n\nThis section has ${optionCount} ${optionCount === 1 ? 'option' : 'options'}${totalSelections > 0 ? ` with ${totalSelections} total ${totalSelections === 1 ? 'selection' : 'selections'}` : ''}.\n\nAll options and selections will be permanently deleted.\n\nThis action CANNOT be undone!`
                  }

                  if (!window.confirm(confirmMessage)) {
                    return
                  }

                  const { error } = await supabase
                    .from('planning_sections')
                    .delete()
                    .eq('id', sec.id)

                  if (error) {
                    alert(`Error deleting section: ${error.message}`)
                  } else {
                    fetchPlanningSections()
                  }
                }}
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
        onClose={() => {
          setCreateSectionModalOpen(false)
          setEditingSection(null)
        }}
        tripId={trip.id}
        onSuccess={fetchPlanningSections}
        section={editingSection}
      />

      {selectedSectionId && (
        <CreateOptionModal
          isOpen={createOptionModalOpen}
          onClose={() => {
            setCreateOptionModalOpen(false)
            setSelectedSectionId(null)
            setEditingOption(null)
          }}
          sectionId={selectedSectionId}
          option={editingOption}
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
  onSelectionUpdate,
  onCreateOption,
  onEditSection,
  onDeleteSection,
}: {
  section: any
  trip: Trip
  participants: ParticipantWithUser[]
  isAdmin: boolean
  onUpdate: () => void
  onSelectionUpdate: (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => void
  onCreateOption: (sectionId: string, option?: any) => void
  onEditSection: (section: any) => void
  onDeleteSection: (section: any) => void
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
        <div className="space-y-3">
          {/* Title row with Edit/Delete buttons */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
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
            {isAdmin && (
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => onEditSection(section)}
                  className="text-xs text-sky-600 hover:text-sky-700 px-2 py-1 rounded hover:bg-sky-50 transition-colors whitespace-nowrap"
                  title="Edit section"
                >
                  Edit
                </button>
                <button
                  onClick={() => onDeleteSection(section)}
                  className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors whitespace-nowrap"
                  title="Delete section"
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          {/* Description and stats */}
          <div>
            {section.description && (
              <Card.Description>{section.description}</Card.Description>
            )}
            <div className="mt-2 text-sm text-gray-600">
              {selectionsCount} of {participants.length} people made selections
            </div>
          </div>

          {/* Add Option button */}
          {isAdmin && (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCreateOption(section.id)}
              >
                + Add Option
              </Button>
            </div>
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
                onSelectionUpdate={onSelectionUpdate}
                onEdit={(opt) => {
                  // Will implement in parent
                  onCreateOption(section.id, opt)
                }}
                onDelete={async (opt) => {
                  const selectionCount = (opt.selections || []).length
                  let confirmMessage = `Delete "${opt.title}"?`

                  if (selectionCount > 0) {
                    confirmMessage = `⚠️ Warning: Delete "${opt.title}"?\n\n${selectionCount} ${selectionCount === 1 ? 'person has' : 'people have'} selected this option. Their selections will be permanently deleted.\n\nThis action CANNOT be undone!`
                  }

                  if (!window.confirm(confirmMessage)) {
                    return
                  }

                  const { error } = await supabase
                    .from('options')
                    .delete()
                    .eq('id', opt.id)

                  if (error) {
                    alert(`Error deleting option: ${error.message}`)
                  } else {
                    onUpdate()
                  }
                }}
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
  isAdmin,
  isLocked,
  onUpdate,
  onSelectionUpdate,
  onEdit,
  onDelete,
}: {
  option: any
  section: any
  trip: Trip
  participants: ParticipantWithUser[]
  isAdmin: boolean
  isLocked: boolean
  onUpdate: () => void
  onSelectionUpdate: (sectionId: string, optionId: string, userId: string, action: 'add' | 'remove', newSelection?: any) => void
  onEdit: (option: any) => void
  onDelete: (option: any) => void
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

    // OPTIMISTIC UPDATE: Update UI immediately, then sync with database
    // This prevents scroll jumping by avoiding a full re-fetch

    if (isSelected) {
      // Optimistically update UI - remove selection immediately
      onSelectionUpdate(section.id, option.id, user.id, 'remove')

      // Remove selection from database in background
      const { error } = await supabase
        .from('selections')
        .delete()
        .eq('id', userSelection.id)

      if (error) {
        alert(`Error removing selection: ${error.message}`)
        // Revert on error by refetching
        onUpdate()
        return
      }
    } else {
      // For single-choice sections, database cleanup happens first
      if (!section.allow_multiple_selections) {
        const sectionOptionIds = (section.options || []).map((opt: any) => opt.id)

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

      // Get user data for the selection
      const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      // Add new selection to database
      const { data: insertedSelection, error } = await supabase
        .from('selections')
        .insert({
          option_id: option.id,
          user_id: user.id,
          metadata: {}
        })
        .select()
        .single()

      if (error) {
        alert(`Error adding selection: ${error.message}`)
        return
      }

      // Optimistically update UI - add selection immediately
      const newSelection = {
        ...insertedSelection,
        user: userData
      }
      onSelectionUpdate(section.id, option.id, user.id, 'add', newSelection)
    }
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
          <div className="flex items-center gap-2 mb-2 flex-wrap">
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
            {isAdmin && (
              <div className="flex gap-1 ml-auto">
                <button
                  onClick={() => onEdit(option)}
                  className="text-xs text-sky-600 hover:text-sky-700 px-2 py-1 rounded hover:bg-sky-50 transition-colors"
                  title="Edit option"
                >
                  Edit
                </button>
                <button
                  onClick={() => onDelete(option)}
                  className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                  title="Delete option"
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          {option.description && (
            <div className="text-sm text-gray-600 mb-3 markdown-content">
              <ReactMarkdown
                components={{
                  h1: ({ children }) => <h1 className="text-lg font-semibold text-gray-900 mb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-base font-semibold text-gray-900 mb-2">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-900 mb-1">{children}</h3>,
                  p: ({ children }) => <p className="my-2">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
                  li: ({ children }) => <li className="my-0.5">{children}</li>,
                  a: ({ href, children }) => <a href={href} className="text-sky-600 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  code: ({ children }) => <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">{children}</code>,
                }}
              >
                {option.description}
              </ReactMarkdown>
            </div>
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
              <SelectionAvatars
                selections={selections}
                maxAvatars={3}
                size="sm"
              />
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

