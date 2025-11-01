import { useState, FormEvent } from 'react'
import { Modal, Button, Input, Select } from './ui'
import { supabase } from '../lib/supabase'
import { Trip } from '../types'

interface CreateInvitationModalProps {
  isOpen: boolean
  onClose: () => void
  trips: Trip[]
  onSuccess: () => void
}

export function CreateInvitationModal({
  isOpen,
  onClose,
  trips,
  onSuccess,
}: CreateInvitationModalProps) {
  const [tripId, setTripId] = useState<string>('')
  const [expiresInDays, setExpiresInDays] = useState('7')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [createdCode, setCreatedCode] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setLoading(true)

    try {
      const { data: authData, error: authError } = await supabase.auth.getUser()

      if (authError) {
        console.error('Auth error:', authError)
        setError('Authentication error. Please try logging in again.')
        setLoading(false)
        return
      }

      if (!authData?.user) {
        setError('Not authenticated. Please log in.')
        setLoading(false)
        return
      }

      // Calculate expiration date
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays))

      // Use database function to avoid RLS ambiguity
      const { data, error: createError } = await supabase
        .rpc('create_invitation', {
          p_trip_id: tripId as string,
          p_expires_at: expiresAt.toISOString(),
        })
        .single()

      if (createError) {
        console.error('Invitation creation error:', createError)
        setError(createError.message)
        setLoading(false)
        return
      }

      if (!data) {
        setError('Failed to create invitation')
        setLoading(false)
        return
      }

      setCreatedCode(data.code)
      setSuccess(true)
      setLoading(false)
      onSuccess()

      // Reset form after delay
      setTimeout(() => {
        setSuccess(false)
        setCreatedCode(null)
        setTripId('')
        setExpiresInDays('7')
      }, 5000)
    } catch (err) {
      console.error('Unexpected error:', err)
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  const copyInvitationLink = () => {
    if (!createdCode) return

    const link = `${window.location.origin}/trips/signup?code=${createdCode}`
    navigator.clipboard.writeText(link)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Invitation">
      {!success ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          {/* Trip Selection */}
          <Select
            label="Assign to Trip (Optional)"
            value={tripId}
            onChange={(e) => setTripId(e.target.value)}
            disabled={loading}
            options={[
              { value: '', label: 'No trip (assign later)' },
              ...trips.map((trip) => ({
                value: trip.id,
                label: `${trip.name} - ${trip.location}`,
              })),
            ]}
            helperText="You can assign the invitation to a trip later if needed"
          />

          {/* Expiration */}
          <Input
            label="Expires In (Days)"
            type="number"
            min="1"
            max="365"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            disabled={loading}
            helperText="Default is 7 days. Set to 365 for ~1 year."
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
              Create Invitation
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-6">
          {/* Success Message */}
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">✅</span>
              <h3 className="font-semibold">Invitation Created!</h3>
            </div>
            <p className="text-sm">
              Share this code or link with the person you want to invite.
            </p>
          </div>

          {/* Invitation Code */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Invitation Code
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={createdCode || ''}
                readOnly
                className="flex-1 font-mono text-lg px-4 py-2 border border-gray-300 rounded-lg bg-gray-50"
              />
              <Button
                variant="outline"
                onClick={() => {
                  if (createdCode) {
                    navigator.clipboard.writeText(createdCode)
                  }
                }}
              >
                Copy Code
              </Button>
            </div>
          </div>

          {/* Invitation Link */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Invitation Link
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={`${window.location.origin}/trips/signup?code=${createdCode}`}
                readOnly
                className="flex-1 text-sm px-4 py-2 border border-gray-300 rounded-lg bg-gray-50"
              />
              <Button variant="outline" onClick={copyInvitationLink}>
                Copy Link
              </Button>
            </div>
          </div>

          {/* Close Button */}
          <div className="flex justify-end pt-4">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
