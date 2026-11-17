import { useState } from 'react'
import { Button, Modal } from '../../../components/ui'
import { useSendToTable, useSetReceiptNotices } from '../../../lib/queries/useReceiptTable'
import type { Expense } from '../../../types'
import { DEADLINE_CHOICES, formatDeadline, pickDeadline, type DeadlineChoice } from '../../receipts/receiptFormat'
import { describeSendReason, failedLine, sentLine, toTellLine, type SendOutcome } from './receiptTable'

export interface SendToTableSheetProps {
  isOpen: boolean
  /** Closes the sheet. `sent` is true once the receipt really went to the table. */
  onClose: (sent: boolean) => void
  expense: Expense
  tripId: string
  /** The most people the send can email (`countToTell`): on the receipt, not you or the payer, not already replied. */
  toTell: number
  /** `trips.receipt_notices_enabled`; null = the column does not exist (hide the switch). */
  noticesEnabled: boolean | null
  canManageTrip: boolean
}

/**
 * "Done — send to the table": pick the reply-by time, see how many people will be told, send.
 * After sending it says how many were reached, were already told and were skipped, never which people.
 */
export function SendToTableSheet({ isOpen, onClose, expense, tripId, toTell, noticesEnabled, canManageTrip }: SendToTableSheetProps) {
  const send = useSendToTable(tripId)
  const setNotices = useSetReceiptNotices(tripId)
  const [choice, setChoice] = useState<DeadlineChoice>('three_days')
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<SendOutcome | null>(null)
  const emailsOff = noticesEnabled === false
  const now = new Date()
  const picked = pickDeadline(choice, now, custom)

  const submit = async () => {
    const pick = pickDeadline(choice, new Date(), custom)
    if (!pick.ok) return setError(pick.error)
    setError(null)
    const result = await send.mutateAsync({ expenseId: expense.id, deadline: pick.send })
    setOutcome(result)
  }

  const reached = outcome?.ok === true
  const close = () => onClose(reached)

  return (
    <Modal isOpen={isOpen} onClose={close} title={reached ? 'Sent to the table' : 'Send to the table'}>
      <div className="space-y-4">
        {reached && outcome ? (
          <>
            <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
              {emailsOff ? "Sent. Emails are off for this trip, so nobody was emailed — they'll see it in the app." : sentLine(outcome)}
            </p>
            {outcome.failed > 0 && (
              <p className="text-sm text-[var(--text-secondary)]" role="alert">
                {failedLine(outcome.failed)}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              {outcome.failed > 0 && (
                <Button variant="secondary" onClick={submit} isLoading={send.isPending}>
                  Try again
                </Button>
              )}
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              Everyone on {expense.vendor_name || expense.description} gets to check what they had and say "That's everything".
            </p>

            <div role="radiogroup" aria-label="Reply by" className="space-y-2">
              <p className="text-sm font-medium text-[var(--text-primary)]">Reply by</p>
              <div className="flex flex-wrap gap-2">
                {DEADLINE_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={choice === c.value}
                    onClick={() => setChoice(c.value)}
                    className={`min-h-11 px-4 py-1.5 rounded-[var(--radius-full)] border text-sm font-medium ${
                      choice === c.value ? 'bg-accent-600 border-accent-600 text-white' : 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {choice === 'custom' && (
                <input
                  type="datetime-local"
                  aria-label="Reply by date and time"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  className="min-h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 text-sm text-[var(--text-primary)]"
                />
              )}
              <p className="text-xs text-[var(--text-muted)]">{picked.ok ? `Reply by ${formatDeadline(picked.iso)}` : picked.error}</p>
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
              {emailsOff ? (
                <p className="text-sm text-[var(--text-primary)]">Emails are off for this trip. Nobody will be emailed; people see it in the app.</p>
              ) : (
                <p className="text-sm text-[var(--text-primary)]">{toTellLine(toTell)}</p>
              )}
              {noticesEnabled !== null && canManageTrip && (
                <label className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
                  <span>Email people about receipts</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!emailsOff}
                    disabled={setNotices.isPending}
                    onClick={() => setNotices.mutate(emailsOff)}
                    className={`min-h-11 min-w-16 px-3 rounded-[var(--radius-full)] border text-sm font-medium ${
                      !emailsOff ? 'bg-accent-600 border-accent-600 text-white' : 'bg-[var(--surface-raised)] border-[var(--border-default)]'
                    }`}
                  >
                    {emailsOff ? 'Off' : 'On'}
                  </button>
                </label>
              )}
            </div>

            {outcome && !outcome.ok && (
              <p className="text-sm text-[var(--text-primary)]" role="alert">
                {describeSendReason(outcome.reason)}
              </p>
            )}
            {error && (
              <p className="text-sm text-[var(--text-primary)]" role="alert">
                {error}
              </p>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={close}>
                Not now
              </Button>
              <Button variant="primary" onClick={submit} isLoading={send.isPending} disabled={!picked.ok}>
                Send to the table
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
