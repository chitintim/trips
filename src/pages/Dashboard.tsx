import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useScrollDirection } from '../hooks/useScrollDirection'
import { supabase } from '../lib/supabase'
import { Button, Card, EmptyState, Badge, Spinner } from '../components/ui'
import { ProfileModal } from '../components/ProfileModal'
import { CreateInvitationModal } from '../components/CreateInvitationModal'
import { CreateTripModal } from '../components/CreateTripModal'
import { ViewUserTripsModal } from '../components/ViewUserTripsModal'
import { User, Trip, Invitation } from '../types'
import { getTripStatusBadgeVariant, getTripStatusLabel, getTripTiming } from '../lib/tripStatus'

type AdminTab = 'trips' | 'users' | 'invitations'

export function Dashboard() {
  const { user, signOut } = useAuth()
  const scrollDirection = useScrollDirection()
  const [isAdmin, setIsAdmin] = useState(false)
  const [activeTab, setActiveTab] = useState<AdminTab>('trips')
  const [loading, setLoading] = useState(true)
  const [signingOut, setSigningOut] = useState(false)
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)

  // Fetch user data and check admin status
  useEffect(() => {
    fetchUserData()
  }, [user])

  const fetchUserData = async () => {
    if (!user) return

    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single()

    if (data) {
      setCurrentUser(data)
      setIsAdmin(data.role === 'admin')
    }
    setLoading(false)
  }

  const handleSignOut = async () => {
    // Confirm before signing out
    if (!window.confirm('Are you sure you want to sign out?')) {
      return
    }

    try {
      setSigningOut(true)

      // Call Supabase sign out
      const { error } = await signOut()

      if (error) {
        console.error('Sign out error:', error)
        alert(`Sign out failed: ${error.message}`)
        setSigningOut(false)
        return
      }

      // Sign out succeeded - force full page reload to clear state
      // Using window.location.href works better on mobile Safari
      window.location.href = window.location.origin + '/trips/login'
    } catch (err: any) {
      console.error('Unexpected sign out error:', err)
      alert(`Unexpected error: ${err?.message || 'Please try again'}`)
      setSigningOut(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 to-orange-50">
      {/* Header */}
      <header
        className={`bg-white shadow-sm border-b border-gray-200 sticky top-0 z-sticky transition-transform duration-300 ease-in-out ${
          scrollDirection === 'down' ? '-translate-y-full' : 'translate-y-0'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎿</span>
              <div>
                <h1 className="text-xl font-bold text-gray-900">
                  Tim's Super Trip Planner
                </h1>
                {isAdmin && (
                  <span className="text-xs text-sky-600 font-medium">
                    Admin Dashboard
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              {currentUser && (
                <button
                  onClick={() => setProfileModalOpen(true)}
                  className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900 transition-colors"
                >
                  <div
                    className="w-8 h-8 rounded-full flex flex-col items-center justify-center text-base"
                    style={{
                      backgroundColor: (currentUser.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                  >
                    {(currentUser.avatar_data as any)?.accessory && (
                      <span className="text-xs -mb-1">
                        {(currentUser.avatar_data as any)?.accessory}
                      </span>
                    )}
                    <span>
                      {(currentUser.avatar_data as any)?.emoji || '😊'}
                    </span>
                  </div>
                  <span className="hidden sm:inline">
                    {currentUser.full_name || user?.email}
                  </span>
                </button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSignOut}
                disabled={signingOut}
                isLoading={signingOut}
              >
                {signingOut ? 'Signing out...' : 'Sign Out'}
              </Button>
            </div>
          </div>
        </div>

        {/* Admin Tabs */}
        {isAdmin && (
          <div className="border-t border-gray-200">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <nav className="flex gap-6" aria-label="Admin sections">
                <button
                  onClick={() => setActiveTab('trips')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                    activeTab === 'trips'
                      ? 'border-sky-500 text-sky-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  🏔️ Trips
                </button>
                <button
                  onClick={() => setActiveTab('users')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                    activeTab === 'users'
                      ? 'border-sky-500 text-sky-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  👥 Users
                </button>
                <button
                  onClick={() => setActiveTab('invitations')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                    activeTab === 'invitations'
                      ? 'border-sky-500 text-sky-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  🎫 Invitations
                </button>
              </nav>
            </div>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isAdmin ? (
          <>
            {activeTab === 'trips' && <TripsTab />}
            {activeTab === 'users' && <UsersTab />}
            {activeTab === 'invitations' && <InvitationsTab />}
          </>
        ) : (
          <MemberView />
        )}
      </main>

      {/* Profile Modal */}
      {currentUser && (
        <ProfileModal
          isOpen={profileModalOpen}
          onClose={() => setProfileModalOpen(false)}
          user={currentUser}
          onUpdate={fetchUserData}
        />
      )}
    </div>
  )
}

// Member view (non-admin users)
function MemberView() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [myTrips, setMyTrips] = useState<(Trip & { confirmed_count: number })[]>([])
  const [publicTrips, setPublicTrips] = useState<(Trip & { confirmed_count: number })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user) {
      fetchMyTrips()
    }
  }, [user])

  const fetchMyTrips = async () => {
    setLoading(true)

    if (!user) {
      setLoading(false)
      return
    }

    // Fetch all trips (RLS now allows viewing public trips)
    const { data: tripsData, error } = await supabase
      .from('trips')
      .select('*')
      .order('start_date', { ascending: false })

    if (error) {
      console.error('Error fetching my trips:', error)
      alert(`Error loading trips: ${error.message}`)
      setLoading(false)
      return
    }

    console.log('All trips data:', tripsData)

    if (tripsData) {
      // Get user's trip participations
      const { data: participations, error: participationError } = await supabase
        .from('trip_participants')
        .select('trip_id')
        .eq('user_id', user.id)

      if (participationError) {
        console.error('Error fetching participations:', participationError)
      }

      console.log('User participations:', participations)
      const userTripIds = new Set(participations?.map(p => p.trip_id) || [])

      // For each trip, get the confirmed count and separate into my trips vs public trips
      const tripsWithCounts = await Promise.all(
        tripsData.map(async (trip) => {
          const { count } = await supabase
            .from('trip_participants')
            .select('*', { count: 'exact', head: true })
            .eq('trip_id', trip.id)
            .eq('confirmation_status', 'confirmed')

          return {
            ...trip,
            confirmed_count: count || 0
          }
        })
      )

      // Get today's date for comparison
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      // Separate user's trips into upcoming and past
      const userTripsAll = tripsWithCounts.filter(trip => userTripIds.has(trip.id))
      const upcomingUserTrips = userTripsAll
        .filter(trip => new Date(trip.start_date) >= today)
        .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()) // Ascending (soonest first)
      const pastUserTrips = userTripsAll
        .filter(trip => new Date(trip.start_date) < today)
        .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()) // Descending (most recent first)

      // Combine: upcoming first, then past
      const userTrips = [...upcomingUserTrips, ...pastUserTrips]

      // Public trips: only show upcoming trips user is NOT part of
      const otherPublicTrips = tripsWithCounts
        .filter(trip =>
          trip.is_public &&
          !userTripIds.has(trip.id) &&
          new Date(trip.start_date) >= today
        )
        .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()) // Ascending (soonest first)

      console.log('Fetched my trips:', userTrips)
      console.log('Fetched public trips:', otherPublicTrips)
      setMyTrips(userTrips)
      setPublicTrips(otherPublicTrips)
    }
    setLoading(false)
  }

  const handleViewTrip = (tripId: string) => {
    navigate(`/${tripId}`)
  }

  const formatDateRange = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

    if (start.getFullYear() === end.getFullYear()) {
      return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}, ${start.getFullYear()}`
    }
    return `${start.toLocaleDateString('en-US', { ...options, year: 'numeric' })} - ${end.toLocaleDateString('en-US', { ...options, year: 'numeric' })}`
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Welcome Back! 👋
        </h2>
        <p className="text-gray-600">
          Your ski trips and adventures await
        </p>
      </div>

      {/* My Trips Section */}
      <div className="mb-8">
        <h3 className="text-xl font-semibold text-gray-800 mb-4">My Trips</h3>
        {myTrips.length === 0 ? (
          <Card>
            <Card.Content className="py-12">
              <EmptyState
                icon="🎿"
                title="No trips yet"
                description="You haven't been added to any trips yet. Tim will add you soon!"
              />
            </Card.Content>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {myTrips.map((trip) => {
              const timing = getTripTiming(trip.start_date, trip.end_date)
              return (
                <Card key={trip.id} className="hover:shadow-lg transition-shadow cursor-pointer !p-4" onClick={() => handleViewTrip(trip.id)}>
                  <Card.Header>
                    <div className="flex items-start justify-between gap-2">
                      <Card.Title className="text-lg">{trip.name}</Card.Title>
                      <div className="flex flex-col gap-1 items-end flex-shrink-0">
                        <Badge variant={getTripStatusBadgeVariant(trip.status)}>
                          {getTripStatusLabel(trip.status)}
                        </Badge>
                        {timing && (
                          <Badge variant={timing.variant}>
                            {timing.label}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Card.Description className="mt-2">
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="flex items-center gap-1">
                          <span>📍</span> {trip.location}
                        </span>
                        <span className="flex items-center gap-1">
                          <span>📅</span> {formatDateRange(trip.start_date, trip.end_date)}
                        </span>
                        <span className="flex items-center gap-1">
                          <span>👥</span> {trip.capacity_limit ? `${trip.confirmed_count}/${trip.capacity_limit} confirmed` : `${trip.confirmed_count} confirmed`}
                        </span>
                      </div>
                    </Card.Description>
                  </Card.Header>
                  <Card.Footer>
                    <Button
                      variant="primary"
                      size="sm"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleViewTrip(trip.id)
                      }}
                    >
                      View Trip Details
                    </Button>
                  </Card.Footer>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Public Trips Section (trips user is not in) */}
      {publicTrips.length > 0 && (
        <div>
          <h3 className="text-xl font-semibold text-gray-800 mb-4">Other Public Trips</h3>
          <p className="text-sm text-gray-600 mb-4">
            Interested in joining? Contact Tim to express your interest!
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {publicTrips.map((trip) => {
              const timing = getTripTiming(trip.start_date, trip.end_date)
              return (
                <Card key={trip.id} className="opacity-60 !p-4 pointer-events-none">
                  <Card.Header>
                    <div className="flex items-start justify-between gap-2">
                      <Card.Title className="text-lg">{trip.name}</Card.Title>
                      <div className="flex flex-col gap-1 items-end flex-shrink-0">
                        <Badge variant={getTripStatusBadgeVariant(trip.status)}>
                          {getTripStatusLabel(trip.status)}
                        </Badge>
                        {timing && (
                          <Badge variant={timing.variant}>
                            {timing.label}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Card.Description className="mt-2">
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="flex items-center gap-1">
                          <span>📍</span> {trip.location}
                        </span>
                        <span className="flex items-center gap-1">
                          <span>📅</span> {formatDateRange(trip.start_date, trip.end_date)}
                        </span>
                        <span className="flex items-center gap-1">
                          <span>👥</span> {trip.capacity_limit ? `${trip.confirmed_count}/${trip.capacity_limit} confirmed` : `${trip.confirmed_count} confirmed`}
                        </span>
                      </div>
                    </Card.Description>
                  </Card.Header>
                  <Card.Footer>
                    <div className="text-xs text-gray-600 text-center py-2">
                      Contact Tim to join this trip
                    </div>
                  </Card.Footer>
                </Card>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

// Trips management tab (admin only)
function TripsTab() {
  const navigate = useNavigate()
  const [trips, setTrips] = useState<(Trip & { confirmed_count: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null)

  useEffect(() => {
    fetchTrips()
  }, [])

  const fetchTrips = async () => {
    setLoading(true)
    const { data: tripsData, error } = await supabase
      .from('trips')
      .select('*')
      .order('start_date', { ascending: false })

    if (error) {
      console.error('Error fetching trips:', error)
      alert(`Error loading trips: ${error.message}`)
      setLoading(false)
      return
    }

    if (tripsData) {
      // For each trip, get the confirmed count
      const tripsWithCounts = await Promise.all(
        tripsData.map(async (trip) => {
          const { count } = await supabase
            .from('trip_participants')
            .select('*', { count: 'exact', head: true })
            .eq('trip_id', trip.id)
            .eq('confirmation_status', 'confirmed')

          return {
            ...trip,
            confirmed_count: count || 0
          }
        })
      )

      // Get today's date for comparison
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      // Separate into upcoming and past trips
      const upcomingTrips = tripsWithCounts
        .filter(trip => new Date(trip.start_date) >= today)
        .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()) // Ascending (soonest first)
      const pastTrips = tripsWithCounts
        .filter(trip => new Date(trip.start_date) < today)
        .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()) // Descending (most recent first)

      // Combine: upcoming first, then past
      const sortedTrips = [...upcomingTrips, ...pastTrips]

      console.log('Fetched trips:', sortedTrips)
      setTrips(sortedTrips)
    }
    setLoading(false)
  }

  const handleCreateTrip = () => {
    setEditingTrip(null)
    setCreateModalOpen(true)
  }

  const handleEditTrip = (trip: Trip) => {
    setEditingTrip(trip)
    setCreateModalOpen(true)
  }

  const handleViewTrip = (tripId: string) => {
    navigate(`/${tripId}`)
  }

  const handleModalClose = () => {
    setCreateModalOpen(false)
    setEditingTrip(null)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">
            Trips
          </h2>
          <p className="text-gray-600">
            Manage all your ski trip adventures
          </p>
        </div>
        <Button variant="primary" onClick={handleCreateTrip}>
          + Create Trip
        </Button>
      </div>

      {trips.length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="🏔️"
              title="No trips created yet"
              description="Create your first trip to get started organizing your ski adventure!"
              action={
                <Button variant="primary" onClick={handleCreateTrip}>
                  Create Your First Trip
                </Button>
              }
            />
          </Card.Content>
        </Card>
      ) : (
        <div className="grid gap-4">
          {trips.map((trip) => {
            const timing = getTripTiming(trip.start_date, trip.end_date)
            return (
              <Card key={trip.id}>
                <Card.Content className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {trip.name}
                        </h3>
                        <Badge variant={getTripStatusBadgeVariant(trip.status)}>
                          {getTripStatusLabel(trip.status)}
                        </Badge>
                        {timing && (
                          <Badge variant={timing.variant}>
                            {timing.label}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 text-sm text-gray-600">
                        <div className="flex items-center gap-4">
                          <span>📍 {trip.location}</span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span>
                            📅 {new Date(trip.start_date).toLocaleDateString()} -{' '}
                            {new Date(trip.end_date).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span>👥</span>
                          <span>{trip.capacity_limit ? `${trip.confirmed_count}/${trip.capacity_limit} confirmed` : `${trip.confirmed_count} confirmed`}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditTrip(trip)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewTrip(trip.id)}
                      >
                        View
                      </Button>
                    </div>
                  </div>
                </Card.Content>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create/Edit Trip Modal */}
      <CreateTripModal
        isOpen={createModalOpen}
        onClose={handleModalClose}
        onSuccess={fetchTrips}
        editTrip={editingTrip}
      />
    </>
  )
}

// Users management tab (admin only)
function UsersTab() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [viewTripsModalOpen, setViewTripsModalOpen] = useState(false)

  useEffect(() => {
    fetchUsers()
  }, [])

  const fetchUsers = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })

    if (!error && data) {
      setUsers(data)
    }
    setLoading(false)
  }

  const handleViewUserTrips = (user: User) => {
    setSelectedUser(user)
    setViewTripsModalOpen(true)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">
          Users
        </h2>
        <p className="text-gray-600">
          Manage all users and their trip assignments
        </p>
      </div>

      <Card>
        <Card.Content className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Joined
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-full flex flex-col items-center justify-center text-lg"
                          style={{
                            backgroundColor:
                              (user.avatar_data as any)?.bgColor || '#0ea5e9',
                          }}
                        >
                          {(user.avatar_data as any)?.accessory && (
                            <span className="text-xs -mb-1">
                              {(user.avatar_data as any)?.accessory}
                            </span>
                          )}
                          <span>
                            {(user.avatar_data as any)?.emoji || '😊'}
                          </span>
                        </div>
                        <div className="font-medium text-gray-900">
                          {user.full_name || 'Unnamed User'}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {user.email}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge variant={user.role === 'admin' ? 'info' : 'neutral'}>
                        {user.role}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewUserTrips(user)}
                      >
                        View Trips
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card.Content>
      </Card>

      {/* View User Trips Modal */}
      {selectedUser && (
        <ViewUserTripsModal
          isOpen={viewTripsModalOpen}
          onClose={() => setViewTripsModalOpen(false)}
          user={selectedUser}
        />
      )}
    </>
  )
}

// Invitations management tab (admin only)
function InvitationsTab() {
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [createModalOpen, setCreateModalOpen] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)

    // Fetch invitations
    const { data: invitationsData } = await supabase
      .from('invitations')
      .select('*')
      .order('created_at', { ascending: false })

    // Fetch trips for dropdown
    const { data: tripsData } = await supabase
      .from('trips')
      .select('*')
      .order('start_date', { ascending: false })

    if (invitationsData) setInvitations(invitationsData)
    if (tripsData) setTrips(tripsData)

    setLoading(false)
  }

  const copyInvitationLink = (code: string) => {
    const link = `${window.location.origin}/trips/signup?code=${code}`
    navigator.clipboard.writeText(link)
  }

  const handleDeleteInvitation = async (invitation: Invitation) => {
    const status = getInvitationStatus(invitation)
    const confirmMessage =
      status === 'completed'
        ? `Delete completed invitation code "${invitation.code}"?\n\nThis invitation was used and the user has verified their email. Safe to remove.`
        : status === 'pending_verification'
        ? `Delete invitation code "${invitation.code}"?\n\nUser has signed up but hasn't verified their email yet. Are you sure?`
        : status === 'expired'
        ? `Delete expired invitation code "${invitation.code}"?\n\nThis invitation has expired and can be safely removed.`
        : `⚠️ Delete ACTIVE invitation code "${invitation.code}"?\n\nWARNING: This invitation is still active and can be used to sign up. Once deleted, the code will no longer work.\n\nAre you sure you want to delete it?`

    if (!window.confirm(confirmMessage)) {
      return
    }

    const { error } = await supabase
      .from('invitations')
      .delete()
      .eq('id', invitation.id)

    if (error) {
      alert(`Error deleting invitation: ${error.message}`)
      return
    }

    // Refresh the list
    fetchData()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  const getInvitationStatus = (inv: Invitation): 'active' | 'pending_verification' | 'completed' | 'expired' => {
    // Use the database status if available
    if (inv.status) {
      return inv.status
    }
    // Fallback for old data without status
    if (inv.used_by) return 'completed'
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired'
    return 'active'
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">
            Invitations
          </h2>
          <p className="text-gray-600">
            Create and manage invitation codes
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
          + Create Invitation
        </Button>
      </div>

      {invitations.length === 0 ? (
        <Card>
          <Card.Content className="py-12">
            <EmptyState
              icon="🎫"
              title="No invitations created yet"
              description="Create invitation codes to allow new users to join your trips!"
              action={
                <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
                  Create First Invitation
                </Button>
              }
            />
          </Card.Content>
        </Card>
      ) : (
        <Card>
          <Card.Content className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Code
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Expires
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Created
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {invitations.map((invitation) => {
                    const status = getInvitationStatus(invitation)
                    return (
                      <tr key={invitation.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">
                          {invitation.code}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge
                            variant={
                              status === 'completed'
                                ? 'neutral'
                                : status === 'expired'
                                ? 'error'
                                : status === 'pending_verification'
                                ? 'warning'
                                : 'success'
                            }
                          >
                            {status === 'pending_verification' ? 'Pending Email' : status === 'completed' ? 'Completed' : status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {invitation.expires_at
                            ? new Date(invitation.expires_at).toLocaleDateString()
                            : 'Never'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {new Date(invitation.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="flex gap-2 justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyInvitationLink(invitation.code)}
                            >
                              Copy Link
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteInvitation(invitation)}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Create Invitation Modal */}
      <CreateInvitationModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        trips={trips}
        onSuccess={fetchData}
      />
    </>
  )
}
