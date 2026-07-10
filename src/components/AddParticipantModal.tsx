import { useState, useEffect, FormEvent } from 'react'
import { Modal, Button, Select, ConfirmDiscardSheet, Skeleton, useToast } from './ui'
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
  const { showToast } = useToast()
  const [users, setUsers] = useState<User[]>([])
  // Distinct from `users.length === 0` so the fetch-in-flight state doesn't
  // briefly render as "everyone's already on this trip" before the first
  // response lands.
  const [usersLoading, setUsersLoading] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [role, setRole] = useState<'organizer' | 'participant'>('participant')
  const [loading, setLoading] = useState(false)
  const addParticipant = useAddParticipant(tripId)

  // Dirty only once the auto-picked defaults have been touched -- avoids
  // prompting a discard-confirm for a form nobody has actually interacted
  // with yet.
  const [touched, setTouched] = useState(false)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(touched)
  const handleClose = () => confirmClose(onClose)

  useEffect(() => {
    if (isOpen) {
      fetchUsers()
      setTouched(false)
    }
  }, [isOpen])

  const fetchUsers = async () => {
    setUsersLoading(true)
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
    setUsersLoading(false)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (!selectedUserId) {
      showToast({ type: 'error', message: 'Please select a user' })
      return
    }

    setLoading(true)
    try {
      await addParticipant.mutateAsync({ userId: selectedUserId, role })

      showToast({ type: 'success', message: 'Participant added' })
      onSuccess()
      onClose()

      // Reset form
      setSelectedUserId('')
      setRole('participant')
    } catch (err) {
      console.error('Participant add error:', err)
      showToast({
        type: 'error',
        message: 'Could not add participant',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setLoading(false)
    }
  }

  if (isOpen && usersLoading) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Add Participant">
        <div className="py-2">
          <Skeleton variant="list" lines={3} />
        </div>
      </Modal>
    )
  }

  if (isOpen && users.length === 0) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Add Participant">
        <div className="py-8 text-center text-[var(--text-secondary)]">
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
        {/* User Selection */}
        <Select
          label="Select User"
          value={selectedUserId}
          onChange={(e) => {
            setSelectedUserId(e.target.value)
            setTouched(true)
          }}
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
          onChange={(e) => {
            setRole(e.target.value as 'organizer' | 'participant')
            setTouched(true)
          }}
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
            onClick={handleClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={loading}>
            Add Participant
          </Button>
        </div>
      </form>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
