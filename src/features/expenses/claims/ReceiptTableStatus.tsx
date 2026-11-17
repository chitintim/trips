import { useState } from 'react'
import { Button, Card, Modal, useToast } from '../../../components/ui'
import { useExtendDeadline, useReopenClaims, useSendToTable } from '../../../lib/queries/useReceiptTable'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'
import { DEADLINE_CHOICES, formatDeadline, formatDeadlineDay, pickDeadline, type DeadlineChoice } from '../../receipts/receiptFormat'
import { ShareRestNowSheet } from './ShareRestNowSheet'
import { describeSendReason, describeTableError, failedLine, REPLY_LABEL, sentLine, STATUS_COPY, type ReceiptColumns, type ReceiptTableRpcSupport, type ReplySummary } from './receiptTable'

export interface ReceiptTableStatusProps {
  expense: Expense
  tripId: string
  columns: ReceiptColumns
  replies: ReplySummary
  rpc: ReceiptTableRpcSupport
  participants: ParticipantWithUser[]
  /** Who got leftovers, for the closed line: "Sam £4.00 · Alex £2.50". Empty = none. */
  leftoversText: string
  /** Balances are frozen: show, don't change. */
  frozen?: boolean
}

/**
 * The payer's status line once a receipt is sent to the table: "Sent · reply by Fri 20 Nov · 3 of 8 have replied", who has
 * replied, and Extend / Share the rest now / Tell people what changed. Once closed, claims are final until the payer or an organizer taps Reopen.
 */
export function ReceiptTableStatus({ expense, tripId, columns, replies, rpc, participants, leftoversText, frozen = false }: ReceiptTableStatusProps) {
  const { showToast } = useToast()
  const extend = useExtendDeadline(tripId)
  const resend = useSendToTable(tripId)
  const reopen = useReopenClaims(tripId)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [choice, setChoice] = useState<DeadlineChoice>('three_days')
  const [custom, setCustom] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)

  const closed = !!columns.claimsClosedAt
  const deadline = columns.claimDeadline

  const deadlineChooser = (label: string) => (
    <>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
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
          aria-label={`${label} date and time`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="min-h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 text-sm text-[var(--text-primary)]"
        />
      )}
      {pickError && (
        <p className="text-sm text-[var(--text-primary)]" role="alert">
          {pickError}
        </p>
      )}
    </>
  )

  if (closed) {
    const closedDay = formatDeadlineDay(columns.claimsClosedAt as string)
    const doReopen = async () => {
      const pick = pickDeadline(choice, new Date(), custom)
      if (!pick.ok) return setPickError(pick.error)
      setPickError(null)
      try {
        await reopen.mutateAsync({ expenseId: expense.id, deadline: pick.send })
        showToast({ type: 'success', message: 'Reopened', description: 'The leftovers are unshared again and every answer is kept.' })
        setReopenOpen(false)
      } catch (err) {
        setPickError(describeTableError(err))
      }
    }
    return (
      <Card noPadding className="p-3 space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
          {leftoversText ? STATUS_COPY.closedLeftovers(closedDay, leftoversText) : STATUS_COPY.closed(closedDay)}
        </p>
        <p className="text-xs text-[var(--text-muted)]">Claims are final. Reopen it to change anything.</p>
        {!frozen && rpc.reopen && (
          <>
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setReopenOpen(true)}>
              {STATUS_COPY.reopen}
            </Button>
            <Modal isOpen={reopenOpen} onClose={() => setReopenOpen(false)} title="Reopen this receipt?">
              <div className="space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  The shared leftovers are taken back and people can change their items again. Everyone's answers are kept. Pick the new reply time.
                </p>
                {deadlineChooser('New reply time')}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={() => setReopenOpen(false)}>
                    Not now
                  </Button>
                  <Button variant="primary" onClick={doReopen} isLoading={reopen.isPending}>
                    Reopen
                  </Button>
                </div>
              </div>
            </Modal>
          </>
        )}
      </Card>
    )
  }

  const day = deadline ? formatDeadlineDay(deadline) : ''
  const line = day ? (replies.total > 0 ? STATUS_COPY.sent(day, replies.replied, replies.total) : STATUS_COPY.sentNoCount(day)) : 'Sent'
  const canAct = !frozen

  // Every option counts from now, so "Tomorrow" can be earlier than the current deadline: say so instead of calling it an extension.
  const extendPick = pickDeadline(choice, new Date(), custom)
  const movesEarlier = extendPick.ok && !!deadline && new Date(extendPick.iso).getTime() < new Date(deadline).getTime()

  const doExtend = async () => {
    const pick = pickDeadline(choice, new Date(), custom)
    if (!pick.ok) return setPickError(pick.error)
    setPickError(null)
    try {
      await extend.mutateAsync({ expenseId: expense.id, deadline: pick.iso })
      showToast({ type: 'success', message: `Reply time moved to ${formatDeadlineDay(pick.iso)}` })
      setExtendOpen(false)
    } catch (err) {
      setPickError(describeTableError(err))
    }
  }

  const doResend = async () => {
    const result = await resend.mutateAsync({ expenseId: expense.id })
    if (!result.ok) return showToast({ type: 'error', message: describeSendReason(result.reason) })
    showToast({ type: result.failed > 0 ? 'warning' : 'success', message: sentLine(result), ...(result.failed > 0 ? { description: `${failedLine(result.failed)}. Tap "${STATUS_COPY.resend}" to retry.` } : {}) })
  }

  return (
    <Card noPadding className="p-3 space-y-2">
      <div>
        <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
          {line}
        </p>
        {deadline && <p className="text-xs text-[var(--text-muted)]">Reply by {formatDeadline(deadline)}</p>}
      </div>

      {replies.rows.length > 0 && (
        <details className="text-sm">
          <summary className="min-h-11 flex items-center cursor-pointer text-accent-700 dark:text-accent-400 font-medium">Who has replied</summary>
          <ul className="space-y-1 pb-1">
            {replies.rows.map((r) => (
              <li key={r.userId} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 break-words text-[var(--text-primary)]">{r.name}</span>
                <span className={r.state === 'none' ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}>{REPLY_LABEL[r.state]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-2">
          {rpc.extend && (
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setExtendOpen(true)}>
              {STATUS_COPY.extend}
            </Button>
          )}
          {rpc.apply && (
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setShareOpen(true)}>
              {STATUS_COPY.shareNow}
            </Button>
          )}
          {rpc.send && (
            <Button variant="ghost" size="sm" className="min-h-11" onClick={doResend} isLoading={resend.isPending}>
              {STATUS_COPY.resend}
            </Button>
          )}
        </div>
      )}

      <Modal isOpen={extendOpen} onClose={() => setExtendOpen(false)} title={movesEarlier ? "Move the reply time earlier" : "Extend the reply time"}>
        <div className="space-y-3">
          {deadlineChooser('New reply time')}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setExtendOpen(false)}>
              Not now
            </Button>
            <Button variant="primary" onClick={doExtend} isLoading={extend.isPending}>
              {movesEarlier && extendPick.ok ? `Move the deadline to ${formatDeadlineDay(extendPick.iso)}` : 'Extend'}
            </Button>
          </div>
        </div>
      </Modal>

      <ShareRestNowSheet isOpen={shareOpen} onClose={() => setShareOpen(false)} expense={expense} participants={participants} tripId={tripId} />
    </Card>
  )
}
