import { useState, useEffect, FormEvent } from 'react'
import { Modal, Button, Select, ConfirmDiscardSheet } from './ui'
import { supabase } from '../lib/supabase'
import { useAddParticipant } from '../lib/queries/useConfirmations'
import { useUnsavedChangesGuard } from '../lib/forms'
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
  const [success, setSuccess] = useState(false)
  const addParticipant = useAddParticipant(tripId)

  // Dirty only once the auto-picked defaults have been touched -- avoids
  // prompting a discard-confirm for a form nobody has actually interacted
  // with yet.
  const [touched, setTouched] = useState(false)
  const isDirty = touched && !success
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  useEffect(() => {
    if (isOpen) {
      fetchUsers()
      setError(null)
      setSuccess(false)
      setTouched(false)
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

      await addParticipant.mutateAsync({ userId: selectedUserId, role })

      setLoading(false)
      setSuccess(true)

      // Wait a moment to show success, then refresh and close
      setTimeout(() => {
        onSuccess()
        onClose()

        // Reset form
        setSelectedUserId('')
        setRole('participant')
        setSuccess(false)
      }, 800)
    } catch (err) {
      console.error('Participant add error:', err)
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
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
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Participant" size="md">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <span className="text-lg">✓</span>
            <span>Participant added successfully!</span>
          </div>
        )}

        {/* User Selection */}
        <Select
          label="Select User"
          value={selectedUserId}
          onChange={(e) => {
            setSelectedUserId(e.target.value)
            setTouched(true)
          }}
          disabled={loading || success}
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
          onChange={(e) => {
            setRole(e.target.value as 'organizer' | 'participant')
            setTouched(true)
          }}
          disabled={loading || success}
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
            onClick={handleClose}
            disabled={loading || success}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={loading} disabled={success}>
            Add Participant
          </Button>
        </div>
      </form>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
