import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Badge, Spinner, EmptyState } from '../components/ui'
import { CreateTripModal, AddParticipantModal } from '../components'
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
        {activeTab === 'planning' && <ComingSoonTab title="Planning" description="Planning sections, options, and selections will be available here." />}
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
                <Badge variant={participant.role === 'organizer' ? 'primary' : 'neutral'}>
                  {participant.role}
                </Badge>
              </div>
            ))}
          </div>
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
