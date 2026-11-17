import { Button, Card, useToast } from '../../../components/ui'
import { useReplyToReceipt } from '../../../lib/queries/useReceiptTable'
import { formatDeadlineDay, LEFTOVER_RULE, replyByLine } from '../../receipts/receiptFormat'
import { describeTableError, type ReceiptColumns } from './receiptTable'

export interface ClaimReplyBarProps {
  tripId: string
  expenseId: string
  userId: string
  columns: ReceiptColumns
  /** The server's answer (`expense_claim_responses`); the server always wins. */
  response: 'done' | 'not_there' | null
  /** You paid: "I wasn't there" does not apply. */
  isPayer: boolean
  /** You hold an ordinary item of your own (table items do not count): the server refuses "I wasn't there" until you take them off. */
  hasOwnItems: boolean
  /** The payer put you down for this; null when nobody did. */
  putDownLine: string | null
  /** Replies are allowed (the responses table exists and the receipt is open). */
  canReply: boolean
  /** The reply-by time has gone: show the answer read-only, like the public page. */
  deadlinePassed?: boolean
  frozen: boolean
  /** The payer's first name, for the "ask <payer> to change that first" message. */
  payerName?: string
}

/**
 * On the claim page, once the receipt was sent to the table: the deadline, and "That's everything" / "I wasn't there"
 * with Undo. Your own item changes keep your reply; if SOMEONE ELSE changes your items the database deletes it (the screen refetches and shows
 * whatever the server says). The payer is done by definition when they send the receipt, so they get no "That's everything".
 */
export function ClaimReplyBar({ tripId, expenseId, userId, columns, response, isPayer, hasOwnItems, putDownLine, canReply, deadlinePassed = false, frozen, payerName }: ClaimReplyBarProps) {
  const { showToast } = useToast()
  const reply = useReplyToReceipt(tripId)
  const closed = !!columns.claimsClosedAt
  const set = async (value: 'done' | 'not_there' | null) => {
    try {
      await reply.mutateAsync({ expenseId, userId, response: value, deadline: columns.claimDeadline })
    } catch (err) {
      showToast({ type: 'error', message: "Couldn't save your answer", description: describeTableError(err, undefined, payerName) })
    }
  }

  if (closed) {
    return (
      <Card noPadding className="p-3">
        <p className="text-sm text-[var(--text-primary)]">Replies closed on {formatDeadlineDay(columns.claimsClosedAt as string)}.</p>
      </Card>
    )
  }
  if (deadlinePassed) {
    return (
      <Card noPadding className="p-3 space-y-1">
        <p className="text-sm text-[var(--text-primary)]">The time to reply has passed. Anything nobody has claimed is shared out soon.</p>
        {response === 'done' && <p className="text-xs text-[var(--text-muted)]">You said that's everything.</p>}
        {response === 'not_there' && <p className="text-xs text-[var(--text-muted)]">You said you weren't there.</p>}
      </Card>
    )
  }
  if (!canReply || isPayer) return null

  return (
    <Card noPadding className="p-3 space-y-2">
      {putDownLine && <p className="text-sm font-medium text-[var(--text-primary)]">{putDownLine}</p>}
      {columns.claimDeadline && (
        <div>
          <p className="text-sm text-[var(--text-primary)]">{replyByLine(columns.claimDeadline)}</p>
          {response === null && <p className="text-xs text-[var(--text-muted)]">{LEFTOVER_RULE}</p>}
        </div>
      )}
      {response === 'done' && (
        <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
          You said that's everything ✓
        </p>
      )}
      {response === 'not_there' && (
        <p className="text-sm font-medium text-[var(--text-primary)]" role="status">
          You said you weren't there.
        </p>
      )}
      {!frozen && (
        <div className="flex flex-wrap gap-2">
          {response === null ? (
            <>
              <Button variant="primary" className="min-h-11" onClick={() => set('done')} isLoading={reply.isPending && reply.variables?.response === 'done'} disabled={reply.isPending}>
                That's everything
              </Button>
              {!hasOwnItems && (
                <Button variant="secondary" className="min-h-11" onClick={() => set('not_there')} isLoading={reply.isPending && reply.variables?.response === 'not_there'} disabled={reply.isPending}>
                  I wasn't there
                </Button>
              )}
            </>
          ) : (
            <Button variant="secondary" className="min-h-11" onClick={() => set(null)} isLoading={reply.isPending}>
              Undo
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
