import { useRef, useState } from 'react'
import { Modal, Button, Input, TextArea, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { supabase } from '../../../lib/supabase'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import { parsePaymentDetails, type PaymentRail } from './paymentDetails'
import type { Json } from '../../../types/database.types'

export interface PaymentDetailsSheetProps {
  isOpen: boolean
  onClose: () => void
  currentPaymentDetails: unknown
}

/** Small profile sheet for editing users.payment_details (plan §12: bank/PayNow/Revolut/Wise handle, free text). */
export function PaymentDetailsSheet({ isOpen, onClose, currentPaymentDetails }: PaymentDetailsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const initial = useRef(parsePaymentDetails(currentPaymentDetails))
  const [rails, setRails] = useState<PaymentRail[]>(initial.current.rails)
  const [notes, setNotes] = useState(initial.current.notes ?? '')
  const [isSaving, setIsSaving] = useState(false)

  const isDirty = JSON.stringify(rails) !== JSON.stringify(initial.current.rails) || notes !== (initial.current.notes ?? '')
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const updateRail = (index: number, patch: Partial<PaymentRail>) => {
    setRails((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const addRail = () => setRails((prev) => [...prev, { label: '', value: '' }])
  const removeRail = (index: number) => setRails((prev) => prev.filter((_, i) => i !== index))

  const handleSave = async () => {
    if (!user) return
    setIsSaving(true)
    try {
      const payload = { rails: rails.filter((r) => r.label.trim() && r.value.trim()), notes: notes.trim() || undefined }
      const { error } = await supabase.from('users').update({ payment_details: payload as unknown as Json }).eq('id', user.id)
      if (error) throw error
      queryClient.invalidateQueries({ queryKey: queryKeys.currentUser(user.id) })
      showToast({ type: 'success', message: 'Payment details saved' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Your payment details" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Shown to people who owe you money, so they know how to pay you back.
        </p>

        {rails.map((rail, i) => (
          <div key={i} className="flex items-end gap-2">
            <Input label={i === 0 ? 'Method' : undefined} placeholder="e.g. Revolut" value={rail.label} onChange={(e) => updateRail(i, { label: e.target.value })} size="sm" />
            <Input label={i === 0 ? 'Handle / details' : undefined} placeholder="@handle or account" value={rail.value} onChange={(e) => updateRail(i, { value: e.target.value })} size="sm" />
            <button type="button" onClick={() => removeRail(i)} className="h-9 px-2 text-[var(--text-muted)] hover:text-danger-600 shrink-0" aria-label="Remove">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}

        <Button variant="secondary" size="sm" onClick={addRail}>+ Add payment method</Button>

        <TextArea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Please include your name in the transfer reference" />

        <Button variant="primary" fullWidth onClick={handleSave} isLoading={isSaving}>
          Save
        </Button>
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
