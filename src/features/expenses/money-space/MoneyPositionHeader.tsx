import { useState } from 'react'
import { Badge, Button, UserAvatar } from '../../../components/ui'
import { formatMoney, formatMoneyMinor } from '../lib/formatMoney'
import { computeMoneyPosition } from './moneyPosition'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface MoneyPositionHeaderProps {
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  /** Already-folded cross-trip carryovers for this trip (as fold target) -- folded into the SAME balance math settlements use, so this header agrees with Settle Up. */
  carryovers?: SettlementCarryover[]
  participants: ParticipantWithUser[]
  currentUserId: string | undefined
  baseCurrency: string
  /** Settle-up STATE card affordance (plan §4 #4) — only meaningful when there's actually something to settle. */
  onSettleUp: () => void
  /** "See my breakdown" — pushes My Spending as a screen (plan §4 #5). */
  onSeeMyBreakdown: () => void
}

const KIND_COPY: Record<'owed' | 'owe' | 'settled', { verb: string; emoji: string }> = {
  owed: { verb: "You're owed", emoji: '💰' },
  owe: { verb: 'You owe', emoji: '⚠️' },
  settled: { verb: 'All square', emoji: '✅' },
}

/**
 * MoneySpace's position header (UX_REDESIGN.md Part 4 "Money: balance-first,
 * no inner tabs" #1): the single most important line on the Money space —
 * "You're owed £84" / "You owe £42 → Settle" / "All square ✓" — with an
 * expandable per-person breakdown and a "see my breakdown" link into My
 * Spending. Built on the same balance math every other money surface uses.
 */
export function MoneyPositionHeader({
  expenses,
  settlements,
  carryovers = [],
  participants,
  currentUserId,
  baseCurrency,
  onSettleUp,
  onSeeMyBreakdown,
}: MoneyPositionHeaderProps) {
  const [expanded, setExpanded] = useState(false)
  const position = computeMoneyPosition(
    expenses,
    settlements,
    participants.map((p) => p.user_id),
    currentUserId,
    baseCurrency,
    carryovers
  )
  const copy = KIND_COPY[position.kind]
  const byUserId = new Map(participants.map((p) => [p.user_id, p]))

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{copy.emoji} Your position</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              position.kind === 'owe' ? 'text-danger-600' : position.kind === 'owed' ? 'text-success-600' : 'text-[var(--text-primary)]'
            }`}
          >
            {position.kind === 'settled' ? (
              <>All square ✓</>
            ) : (
              <>
                {copy.verb} {formatMoney(position.amount, position.currency)}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {position.kind !== 'settled' && (
            <Button variant="primary" size="sm" onClick={onSettleUp}>
              Settle
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSeeMyBreakdown}>
            See my breakdown →
          </Button>
        </div>
      </div>

      {position.expensesMissingRate.length > 0 && (
        <Badge variant="warning">
          ⚠️ {position.expensesMissingRate.length} expense{position.expensesMissingRate.length === 1 ? '' : 's'} missing FX rates — excluded above
        </Badge>
      )}

      {position.perPerson.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Show'} per-person breakdown {expanded ? '▲' : '▼'}
          </button>

          {expanded && (
            <div className="mt-2.5 space-y-2 stagger-list">
              {position.perPerson.map((row) => {
                const person = byUserId.get(row.userId)
                const theyOweMe = row.netMinor > 0
                return (
                  <div key={row.userId} className="stagger-item flex items-center gap-2.5">
                    <UserAvatar avatarData={person?.user} size="xs" alt={person?.user?.full_name ?? person?.user?.email ?? ''} />
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                      {person?.user?.full_name || person?.user?.email || 'Someone'}
                    </span>
                    <span className={`text-sm font-medium tabular-nums ${theyOweMe ? 'text-success-600' : 'text-danger-600'}`}>
                      {theyOweMe ? 'owes you ' : 'you owe '}
                      {formatMoneyMinor(Math.abs(row.netMinor), baseCurrency)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
