import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, Button, Input, Select, TextArea } from './ui'
import { formatCurrency } from '../lib/currency'
import { Database } from '../types/database.types'

type User = Database['public']['Tables']['users']['Row']

interface RecordSettlementModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  participants: Array<{ user_id: string; user: User }>
  currentUserId: string
  onSuccess: () => void
}

export function RecordSettlementModal({
  isOpen,
  onClose,
  tripId,
  participants,
  currentUserId,
  onSuccess
}: RecordSettlementModalProps) {
  const [fromUserId, setFromUserId] = useState('')
  const [toUserId, setToUserId] = useState('')
  const [amount, setAmount] = useState('')
  const [settledAt, setSettledAt] = useState(new Date().toISOString().split('T')[0])
  const [paymentMethod, setPaymentMethod] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validation
    if (!fromUserId || !toUserId) {
      setError('Please select both payer and receiver')
      return
    }

    if (fromUserId === toUserId) {
      setError('Payer and receiver must be different people')
      return
    }

    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Amount must be a positive number')
      return
    }

    if (notes.length > 500) {
      setError('Notes must be 500 characters or less')
      return
    }

    if (paymentMethod.length > 100) {
      setError('Payment method must be 100 characters or less')
      return
    }

    setSubmitting(true)

    try {
      const { error: insertError } = await supabase
        .from('settlements')
        .insert({
          trip_id: tripId,
          from_user_id: fromUserId,
          to_user_id: toUserId,
          amount: amountNum,
          settled_at: settledAt,
          payment_method: paymentMethod || null,
          notes: notes || null,
          created_by: currentUserId
        })

      if (insertError) throw insertError

      // Success - reset form and close
      setFromUserId('')
      setToUserId('')
      setAmount('')
      setSettledAt(new Date().toISOString().split('T')[0])
      setPaymentMethod('')
      setNotes('')
      onSuccess()
      onClose()
    } catch (err: any) {
      console.error('Error recording settlement:', err)
      setError(err.message || 'Failed to record settlement')
    } finally {
      setSubmitting(false)
    }
  }

  const handleClose = () => {
    if (!submitting) {
      setError(null)
      onClose()
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Record Payment">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* From User (Payer) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Who paid? <span className="text-red-500">*</span>
            </label>
            <Select
              value={fromUserId}
              onChange={(e) => setFromUserId(e.target.value)}
              required
              placeholder="Select payer..."
              options={participants.map(p => ({
                value: p.user_id,
                label: p.user.full_name || p.user.email || 'Unknown'
              }))}
            />
          </div>

          {/* To User (Receiver) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Who received the payment? <span className="text-red-500">*</span>
            </label>
            <Select
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
              required
              placeholder="Select receiver..."
              options={participants.map(p => ({
                value: p.user_id,
                label: p.user.full_name || p.user.email || 'Unknown'
              }))}
            />
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount (GBP) <span className="text-red-500">*</span>
            </label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
            <p className="mt-1 text-xs text-gray-500">
              Enter the amount in GBP (British Pounds)
            </p>
          </div>

          {/* Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Payment Date <span className="text-red-500">*</span>
            </label>
            <Input
              type="date"
              value={settledAt}
              onChange={(e) => setSettledAt(e.target.value)}
              max={new Date().toISOString().split('T')[0]}
              required
            />
          </div>

          {/* Payment Method (Optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Payment Method (Optional)
            </label>
            <Select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder="Select method..."
              options={[
                { value: 'Bank Transfer', label: 'Bank Transfer' },
                { value: 'Cash', label: 'Cash' },
                { value: 'PayPal', label: 'PayPal' },
                { value: 'Venmo', label: 'Venmo' },
                { value: 'Revolut', label: 'Revolut' },
                { value: 'Other', label: 'Other' }
              ]}
            />
          </div>

          {/* Notes (Optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes (Optional)
            </label>
            <TextArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any additional notes about this payment..."
              rows={3}
              maxLength={500}
            />
            <p className="mt-1 text-xs text-gray-500">
              {notes.length}/500 characters
            </p>
          </div>
        </div>

        {/* Preview */}
        {fromUserId && toUserId && amount && parseFloat(amount) > 0 && (
          <div className="p-4 bg-sky-50 border border-sky-200 rounded-lg">
            <p className="text-sm font-medium text-gray-900">
              Settlement Summary:
            </p>
            <p className="text-sm text-gray-700 mt-2">
              <strong>
                {participants.find(p => p.user_id === fromUserId)?.user.full_name || 'Unknown'}
              </strong>
              {' '}paid{' '}
              <strong>
                {participants.find(p => p.user_id === toUserId)?.user.full_name || 'Unknown'}
              </strong>
              {' '}{formatCurrency(parseFloat(amount), 'GBP')}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={submitting}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={submitting}
            className="flex-1"
          >
            {submitting ? 'Recording...' : 'Record Payment'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
