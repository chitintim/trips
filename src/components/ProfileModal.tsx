import { useState, FormEvent } from 'react'
import { Modal, Button, Input } from './ui'
import { AvatarBuilder } from './AvatarBuilder'
import { supabase } from '../lib/supabase'
import { AvatarData, User } from '../types'

interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
  user: User
  onUpdate: () => void
}

export function ProfileModal({ isOpen, onClose, user, onUpdate }: ProfileModalProps) {
  const [firstName, setFirstName] = useState(user.first_name || '')
  const [lastName, setLastName] = useState(user.last_name || '')
  const [avatarData, setAvatarData] = useState<AvatarData>(
    (user.avatar_data as any) || {
      emoji: '😊',
      accessory: null,
      bgColor: '#0ea5e9',
    }
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setLoading(true)

    try {
      const { error: updateError } = await supabase
        .from('users')
        .update({
          first_name: firstName,
          last_name: lastName,
          full_name: `${firstName} ${lastName}`,
          avatar_data: avatarData as unknown as any,
        })
        .eq('id', user.id)

      if (updateError) {
        setError(updateError.message)
        return
      }

      setSuccess(true)
      onUpdate() // Refresh user data

      // Close modal after brief success message
      setTimeout(() => {
        onClose()
        setSuccess(false)
      }, 1500)
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Profile">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-3 text-sm">
            Profile updated successfully!
          </div>
        )}

        {/* First Name */}
        <Input
          label="First Name"
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Tim"
          required
          disabled={loading}
        />

        {/* Last Name */}
        <Input
          label="Last Name"
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="Lam"
          required
          disabled={loading}
        />

        {/* Avatar Builder */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Your Avatar
          </label>
          <AvatarBuilder
            value={avatarData}
            onChange={setAvatarData}
            disabled={loading}
          />
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
          <Button
            type="submit"
            variant="primary"
            isLoading={loading}
          >
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}
