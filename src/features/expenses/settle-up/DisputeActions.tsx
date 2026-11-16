import { useState } from 'react'
import { Button, Modal, useToast } from '../../../components/ui'
import { useAskReceiverAgain, useReceiverDisputeReceipt, useRetractPayment } from '../../../lib/queries/useSettlements'
import { ACTION_LABELS, RETRACT_CONFIRM_TITLE, askedAgainNote, retractConfirmBody, type DisputeAction, type DisputeView } from './paymentDispute'

interface DisputeActionsProps {
  tripId: string
  settlementId: string
  payerName: string
  receiverName: string
  view: DisputeView
  /** An organizer recorded this payment as paid for the payer (the undo dialog says so). */
  recordedOnBehalf?: boolean
}

/** The status line, quiet "It hasn't arrived", "ask again" and "I haven't paid yet" for one payment row. */
export function DisputeActions({ tripId, settlementId, receiverName, view, recordedOnBehalf = false }: DisputeActionsProps) {
  const { showToast } = useToast()
  const dispute = useReceiverDisputeReceipt(tripId)
  const askAgain = useAskReceiverAgain(tripId)
  const retract = useRetractPayment(tripId)
  const [confirmRetract, setConfirmRetract] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!view.statusLine && view.actions.length === 0 && !view.helpText) return null
  const busy = dispute.isPending || askAgain.isPending || retract.isPending

  const run = (a: DisputeAction) => {
    setError(null)
    setNote(null)
    if (a === 'retract') return setConfirmRetract(true)
    const onError = (err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong')
    if (a === 'not_arrived') dispute.mutate(settlementId, { onError })
    else
      askAgain.mutate(
        { settlementId, receiverName },
        // onSuccess runs only when payment-notice answered 200: never claim "asked" for a refusal or a failure.
        { onSuccess: () => { setNote(askedAgainNote(receiverName)); showToast({ type: 'success', message: askedAgainNote(receiverName) }) }, onError }
      )
  }

  return (
    <div className="pl-9 pt-0.5 space-y-1.5">
      {view.statusLine && <p className="text-xs font-medium text-warn-700 dark:text-warn-300">{view.statusLine}</p>}
      {view.helpText && <p className="text-xs text-[var(--text-muted)]">{view.helpText}</p>}
      {view.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'ask_again' ? 'primary' : a === 'retract' && !view.statusLine ? 'ghost' : 'secondary'}
              disabled={busy}
              isLoading={(a === 'not_arrived' && dispute.isPending) || (a === 'ask_again' && askAgain.isPending)}
              onClick={() => run(a)}
            >
              {ACTION_LABELS[a]}
            </Button>
          ))}
        </div>
      )}
      {note && <p className="text-xs text-[var(--text-secondary)]" role="status">{note}</p>}
      {error && <p className="text-xs text-danger-700 dark:text-danger-300" role="alert">{error}</p>}
      <Modal isOpen={confirmRetract} onClose={() => (retract.isPending ? undefined : setConfirmRetract(false))} title={RETRACT_CONFIRM_TITLE} size="sm">
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{retractConfirmBody(receiverName, recordedOnBehalf)}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmRetract(false)} disabled={retract.isPending}>Cancel</Button>
            <Button
              variant="primary"
              isLoading={retract.isPending}
              onClick={() =>
                retract.mutate(settlementId, {
                  onSuccess: () => setConfirmRetract(false),
                  onError: (err) => { setConfirmRetract(false); setError(err instanceof Error ? err.message : 'Something went wrong') },
                })
              }
            >
              {ACTION_LABELS.retract}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
