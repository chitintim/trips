import { useState, FormEvent, useEffect } from 'react'
import { Modal, Button, Input, Select } from './ui'
import { supabase } from '../lib/supabase'
import { Trip } from '../types'

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
  const [status, setStatus] = useState<'gathering_interest' | 'confirming_participants' | 'booking_details' | 'booked_awaiting_departure' | 'trip_ongoing' | 'trip_completed'>('gathering_interest')
  const [isPublic, setIsPublic] = useState(false)
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
      setIsPublic(editTrip.is_public)
    } else {
      // Reset form when creating new trip
      setName('')
      setLocation('')
      setStartDate('')
      setEndDate('')
      setStatus('gathering_interest')
      setIsPublic(false)
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
            is_public: isPublic,
          })
          .eq('id', editTrip.id)

        if (updateError) {
          console.error('Trip update error:', updateError)
          setError(updateError.message)
          setLoading(false)
          return
        }
      } else {
        // Create new trip using database function to avoid RLS recursion
        const { error: createError } = await supabase
          .rpc('create_trip_with_participant', {
            p_name: name.trim(),
            p_location: location.trim(),
            p_start_date: startDate,
            p_end_date: endDate,
            p_status: status,
            p_is_public: isPublic,
          })

        if (createError) {
          console.error('Trip creation error:', createError)
          setError(createError.message)
          setLoading(false)
          return
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
      setStatus('gathering_interest')
      setIsPublic(false)
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
            setStatus(e.target.value as 'gathering_interest' | 'confirming_participants' | 'booking_details' | 'booked_awaiting_departure' | 'trip_ongoing' | 'trip_completed')
          }
          disabled={loading}
          options={[
            { value: 'gathering_interest', label: '💭 Gathering Interest - Seeing who might be interested' },
            { value: 'confirming_participants', label: '✋ Confirming Participants - Getting commitments' },
            { value: 'booking_details', label: '🔄 Booking Details - Planning flights, transport, etc.' },
            { value: 'booked_awaiting_departure', label: '✅ Booked - All set, awaiting departure' },
            { value: 'trip_ongoing', label: '🎿 Trip Ongoing - Currently happening' },
            { value: 'trip_completed', label: '🏁 Trip Completed - All done' },
          ]}
          helperText="Set the current status of this trip"
        />

        {/* Public Visibility Toggle */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="is-public"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={loading}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <div className="flex-1">
            <label htmlFor="is-public" className="block text-sm font-medium text-gray-700 cursor-pointer">
              Make trip visible to all logged-in users
            </label>
            <p className="text-xs text-gray-500 mt-1">
              When enabled, all authenticated users can see this trip card (but not trip details). They can contact you to express interest in joining.
            </p>
          </div>
        </div>

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
