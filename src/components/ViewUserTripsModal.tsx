import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button, Badge, Spinner, EmptyState } from './ui'
import { supabase } from '../lib/supabase'
import { Trip, User } from '../types'
import { getTripStatusBadgeVariant, getTripStatusLabel, getTripTiming } from '../lib/tripStatus'

interface ViewUserTripsModalProps {
  isOpen: boolean
  onClose: () => void
  user: User
}

interface TripWithRole extends Trip {
  role: 'organizer' | 'participant'
}

export function ViewUserTripsModal({
  isOpen,
  onClose,
  user,
}: ViewUserTripsModalProps) {
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TripWithRole[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isOpen) {
      fetchUserTrips()
    }
  }, [isOpen, user.id])

  const fetchUserTrips = async () => {
    setLoading(true)

    // Fetch trips where user is a participant
    const { data, error } = await supabase
      .from('trip_participants')
      .select(`
        role,
        trip:trip_id (*)
      `)
      .eq('user_id', user.id)

    if (!error && data) {
      // Transform the data to include role
      const tripsWithRole = data
        .map((item: any) => ({
          ...item.trip,
          role: item.role,
        }))
        .filter((trip: any) => trip.id) // Filter out null trips

      setTrips(tripsWithRole)
    }

    setLoading(false)
  }

  const handleViewTrip = (tripId: string) => {
    navigate(`/trips/${tripId}`)
    onClose()
  }

  const formatDateRange = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }

    return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${user.full_name || user.email}'s Trips`}
      size="lg"
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : trips.length === 0 ? (
        <div className="py-8">
          <EmptyState
            icon="🎿"
            title="No trips yet"
            description={`${user.full_name || user.email} hasn't been added to any trips yet.`}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {trips.map((trip) => {
            const timing = getTripTiming(trip.start_date, trip.end_date)
            return (
              <div
                key={trip.id}
                className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {trip.name}
                      </h3>
                      <Badge variant={getTripStatusBadgeVariant(trip.status)}>
                        {getTripStatusLabel(trip.status)}
                      </Badge>
                      <Badge variant={trip.role === 'organizer' ? 'primary' : 'neutral'}>
                        {trip.role}
                      </Badge>
                      {timing && (
                        <Badge variant={timing.variant}>
                          {timing.label}
                        </Badge>
                      )}
                    </div>
                  <div className="flex items-center gap-4 text-sm text-gray-600">
                    <span>📍 {trip.location}</span>
                    <span>📅 {formatDateRange(trip.start_date, trip.end_date)}</span>
                  </div>
                </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleViewTrip(trip.id)}
                  >
                    View Trip
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex justify-end pt-4 mt-6 border-t border-gray-200">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}
