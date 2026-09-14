import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Select, TextArea, ConfirmDiscardSheet, useToast } from '../../../components/ui'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import { useUpdateSettlementStatus, type Settlement } from '../../../lib/queries/useSettlements'
import { useTripActivityLog } from '../../organizer/lib/activity'

export interface MarkPaidSheetProps {
  isOpen: boolean
  onClose: () => void
  /** null while no row is targeted -- caller keeps this mounted and gates on isOpen (same as PaymentDetailsSheet), so this can also be safely rendered with a null settlement between opens. */
  settlement: Settlement | null
  tripId: string
  toName: string
}

const PAYMENT_METHOD_OPTIONS = [
  { value: 'Bank transfer', label: 'Bank transfer' },
  { value: 'Cash', label: 'Cash' },
  { value: 'PayPal', label: 'PayPal' },
  { value: 'Other', label: 'Other' },
]

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * "Mark paid" note-tracking sheet (settle-up review: "no note tracking for
 * me to confirm when and how I settled"). Captures payment method, the
 * actual settled date, and an optional note before flipping a settlement
 * row 'suggested' -> 'marked_paid' -- previously that transition recorded
 * nothing but the status itself, and settled_at was silently pinned to
 * freeze time. Modeled on PaymentDetailsSheet.tsx's pattern (Modal +
 * useUnsavedChangesGuard, own supabase-backed hooks rather than props).
 */
export function MarkPaidSheet({ isOpen, onClose, settlement, tripId, toName }: MarkPaidSheetProps) {
  const { showToast } = useToast()
  const updateStatus = useUpdateSettlementStatus(tripId)
  const logTypedActivity = useTripActivityLog(tripId)

  const initial = useRef({ method: 'Bank transfer', customMethod: '', date: todayIso(), note: '' })
  const [method, setMethod] = useState(initial.current.method)
  const [customMethod, setCustomMethod] = useState(initial.current.customMethod)
  const [date, setDate] = useState(initial.current.date)
  const [note, setNote] = useState(initial.current.note)

  // Re-seed on every open (same "mounted unconditionally, re-seed on
  // isOpen false->true" fix PaymentDetailsSheet already needed -- see its
  // audit-finding-#5 comment) so a previous discard or a different
  // settlement row never leaks into the next open.
  const wasOpen = useRef(isOpen)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const seeded = { method: 'Bank transfer', customMethod: '', date: todayIso(), note: '' }
      initial.current = seeded
      setMethod(seeded.method)
      setCustomMethod(seeded.customMethod)
      setDate(seeded.date)
      setNote(seeded.note)
    }
    wasOpen.current = isOpen
  }, [isOpen])

  const isDirty =
    method !== initial.current.method ||
    customMethod !== initial.current.customMethod ||
    date !== initial.current.date ||
    note !== initial.current.note
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  if (!settlement) return null

  const resolvedMethod = method === 'Other' ? customMethod.trim() : method

  const handleSave = () => {
    updateStatus.mutate(
      {
        settlementId: settlement.id,
        status: 'marked_paid',
        payment_method: resolvedMethod || null,
        notes: note.trim() || null,
        settled_at: new Date(`${date}T12:00:00`).toISOString(),
      },
      {
        onSuccess: () => {
          logTypedActivity({
            verb: 'settlement_marked_paid',
            entity: { type: 'settlement', id: settlement.id, label: `You → ${toName}` },
          })
          showToast({ type: 'success', message: `Marked as paid — waiting for ${toName} to confirm.` })
          onClose()
        },
        onError: (err) =>
          showToast({ type: 'error', message: 'Failed to mark as paid', description: err instanceof Error ? err.message : undefined }),
      }
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Mark as paid" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          How and when did you pay {toName}? This is kept as your record — {toName} will see it when confirming.
        </p>

        <Select label="Payment method" options={PAYMENT_METHOD_OPTIONS} value={method} onChange={(e) => setMethod(e.target.value)} size="sm" />

        {method === 'Other' && (
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Method name</label>
            <input
              type="text"
              value={customMethod}
              onChange={(e) => setCustomMethod(e.target.value)}
              maxLength={100}
              placeholder="e.g. Wise"
              className="block w-full h-9 px-3 text-sm rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500"
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Date paid</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={todayIso()}
            className="block w-full h-9 px-3 text-sm rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500"
          />
        </div>

        <TextArea
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="e.g. Sent via Revolut, ref 'Sicily trip'"
        />

        <Button variant="primary" fullWidth onClick={handleSave} isLoading={updateStatus.isPending} disabled={method === 'Other' && !customMethod.trim()}>
          Mark as paid
        </Button>
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
