import { useState, useEffect, FormEvent } from 'react'
import { Modal, Button, Select } from './ui'
import { supabase } from '../lib/supabase'
import { User } from '../types'

interface AddParticipantModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  existingParticipantIds: string[]
  onSuccess: () => void
}

export function AddParticipantModal({
  isOpen,
  onClose,
  tripId,
  existingParticipantIds,
  onSuccess,
}: AddParticipantModalProps) {
  const [users, setUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [role, setRole] = useState<'organizer' | 'participant'>('participant')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      fetchUsers()
    }
  }, [isOpen])

  const fetchUsers = async () => {
    const { data, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .order('full_name')

    if (!fetchError && data) {
      // Filter out users already in the trip
      const availableUsers = data.filter(
        (user) => !existingParticipantIds.includes(user.id)
      )
      setUsers(availableUsers)

      // Reset selection
      setSelectedUserId(availableUsers.length > 0 ? availableUsers[0].id : '')
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (!selectedUserId) {
        setError('Please select a user')
        setLoading(false)
        return
      }

      const { error: insertError } = await supabase
        .from('trip_participants')
        .insert({
          trip_id: tripId,
          user_id: selectedUserId,
          role,
        })

      if (insertError) {
        console.error('Participant add error:', insertError)
        setError(insertError.message)
        setLoading(false)
        return
      }

      setLoading(false)
      onSuccess()
      onClose()

      // Reset form
      setSelectedUserId('')
      setRole('participant')
    } catch (err) {
      console.error('Unexpected error:', err)
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  if (users.length === 0 && isOpen) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Add Participant">
        <div className="py-8 text-center text-gray-600">
          All users are already participants in this trip!
        </div>
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Participant" size="md">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {/* User Selection */}
        <Select
          label="Select User"
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          disabled={loading}
          options={users.map((user) => ({
            value: user.id,
            label: user.full_name || user.email,
          }))}
          required
        />

        {/* Role Selection */}
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'organizer' | 'participant')}
          disabled={loading}
          options={[
            { value: 'participant', label: '👤 Participant - Can view and make selections' },
            { value: 'organizer', label: '⭐ Organizer - Can manage trip settings' },
          ]}
          helperText="Organizers have additional permissions to manage the trip"
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
            Add Participant
          </Button>
        </div>
      </form>
    </Modal>
  )
}
