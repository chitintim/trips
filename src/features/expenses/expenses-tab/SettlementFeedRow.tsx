import { Badge } from '../../../components/ui'
import { formatMoney } from '../lib/formatMoney'
import { isPendingSettlement } from '../lib/settlementFeed'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface SettlementFeedRowProps {
  settlement: Settlement
  participantsByUserId: Record<string, ParticipantWithUser>
  baseCurrency: string
  currentUserId: string | undefined
}

/**
 * A settlement rendered as a first-class Money-feed entry — "in a sense
 * they are just P2P transactions", so mid-trip payments (pre-payments,
 * paying someone back) show up in the same chronological stream as the
 * spending. Deliberately LIGHTER than an ExpenseCard (sunken row, one line
 * + optional note, no actions) so the feed still reads as "spending, with
 * transfers woven in" rather than two competing card types.
 *
 * 'marked_paid' rows (payer says paid, recipient hasn't confirmed) are
 * flagged as pending — they do NOT count in balances yet (computeBalances
 * semantics), and hiding them would invite double payment.
 */
export function SettlementFeedRow({ settlement, participantsByUserId, baseCurrency, currentUserId }: SettlementFeedRowProps) {
  const nameOf = (userId: string): string => {
    if (currentUserId && userId === currentUserId) return 'You'
    const p = participantsByUserId[userId]
    return p?.user.full_name || p?.user.email || 'Someone'
  }

  const pending = isPendingSettlement(settlement)
  const involvesViewer = currentUserId === settlement.from_user_id || currentUserId === settlement.to_user_id

  return (
    <div
      className={`flex items-start gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2.5 ${
        involvesViewer ? '' : 'opacity-60'
      }`}
    >
      <span className="mt-0.5 shrink-0 text-sm" aria-hidden="true">
        💸
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{nameOf(settlement.from_user_id)}</span>
            {' paid '}
            <span className="font-medium text-[var(--text-primary)]">{nameOf(settlement.to_user_id)}</span>
          </p>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {formatMoney(settlement.amount, settlement.currency || baseCurrency)}
          </p>
        </div>
        {(settlement.notes || pending) && (
          <div className="mt-0.5 flex items-center gap-2 min-w-0">
            {settlement.notes && <p className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{settlement.notes}</p>}
            {pending && (
              <Badge variant="warning" size="sm" className="shrink-0">
                Pending — not in balances yet
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
