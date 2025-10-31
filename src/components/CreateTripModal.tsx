import { useState, FormEvent, useEffect } from 'react'
import { Modal, Button, Input, Select } from './ui'
import { supabase } from '../lib/supabase'
import { Trip, TripInsert } from '../types'

interface CreateTripModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  editTrip?: Trip | null
}

export function CreateTripModal({
  isOpen,
  onClose,
  onSuccess,
  editTrip = null,
}: CreateTripModalProps) {
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [status, setStatus] = useState<'planning' | 'booking' | 'booked'>('planning')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill form when editing
  useEffect(() => {
    if (editTrip) {
      setName(editTrip.name)
      setLocation(editTrip.location)
      setStartDate(editTrip.start_date)
      setEndDate(editTrip.end_date)
      setStatus(editTrip.status)
    } else {
      // Reset form when creating new trip
      setName('')
      setLocation('')
      setStartDate('')
      setEndDate('')
      setStatus('planning')
    }
    setError(null)
  }, [editTrip, isOpen])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // Validation
      if (!name.trim() || !location.trim() || !startDate || !endDate) {
        setError('All fields are required')
        setLoading(false)
        return
      }

      if (new Date(endDate) < new Date(startDate)) {
        setError('End date must be after start date')
        setLoading(false)
        return
      }

      const { data: authData, error: authError } = await supabase.auth.getUser()

      if (authError || !authData?.user) {
        setError('Authentication error. Please try logging in again.')
        setLoading(false)
        return
      }

      if (editTrip) {
        // Update existing trip
        const { error: updateError } = await supabase
          .from('trips')
          .update({
            name: name.trim(),
            location: location.trim(),
            start_date: startDate,
            end_date: endDate,
            status,
          })
          .eq('id', editTrip.id)

        if (updateError) {
          console.error('Trip update error:', updateError)
          setError(updateError.message)
          setLoading(false)
          return
        }
      } else {
        // Create new trip
        const tripData: TripInsert = {
          name: name.trim(),
          location: location.trim(),
          start_date: startDate,
          end_date: endDate,
          status,
          created_by: authData.user.id,
        }

        const { data: newTrip, error: createError } = await supabase
          .from('trips')
          .insert(tripData)
          .select('id')
          .single()

        if (createError) {
          console.error('Trip creation error:', createError)
          setError(createError.message)
          setLoading(false)
          return
        }

        // Add creator as participant with organizer role
        if (newTrip) {
          const { error: participantError } = await supabase
            .from('trip_participants')
            .insert({
              trip_id: newTrip.id,
              user_id: authData.user.id,
              role: 'organizer',
            })

          if (participantError) {
            console.error('Participant creation error:', participantError)
            // Don't fail the whole operation, just log it
          }
        }
      }

      setLoading(false)
      onSuccess()
      onClose()

      // Reset form
      setName('')
      setLocation('')
      setStartDate('')
      setEndDate('')
      setStatus('planning')
    } catch (err) {
      console.error('Unexpected error:', err)
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editTrip ? 'Edit Trip' : 'Create Trip'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {/* Trip Name */}
        <Input
          label="Trip Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={loading}
          placeholder="e.g., Val Thorens 2025"
          required
        />

        {/* Location */}
        <Input
          label="Location"
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={loading}
          placeholder="e.g., Val Thorens, France"
          required
        />

        {/* Date Range */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Start Date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={loading}
            required
          />
          <Input
            label="End Date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={loading}
            required
          />
        </div>

        {/* Status */}
        <Select
          label="Trip Status"
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as 'planning' | 'booking' | 'booked')
          }
          disabled={loading}
          options={[
            { value: 'planning', label: '📝 Planning - Still deciding on options' },
            { value: 'booking', label: '🔄 Booking - Ready to book selections' },
            { value: 'booked', label: '✅ Booked - All bookings confirmed' },
          ]}
          helperText="Set the current status of this trip"
        />

        {/* Buttons */}
        <div className="flex gap-3 justify-end pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={loading}>
            {editTrip ? 'Update Trip' : 'Create Trip'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
