import { useMemo, useState } from 'react'
import { Badge, Button, UserAvatar } from '../../../components/ui'
import { formatMoney, formatMoneyMinor } from '../lib/formatMoney'
import { computeMoneyPosition, computePairwiseLedger, mergeSettlementsWithUsableCarryovers } from './moneyPosition'
import type { PairwiseLedgerEntry } from './moneyPosition'
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

/** Short human date for a ledger entry line ("1 Jul"). */
function ledgerDateLabel(date: string): string {
  if (!date) return ''
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** What a non-expense ledger entry IS, viewer-relative: sign already encodes direction (+ = the current user paid / is owed more). */
function ledgerEntryLabel(entry: PairwiseLedgerEntry, counterpartyName: string): string {
  if (entry.kind === 'carryover') return 'Carried over from another trip'
  return entry.amountMinor >= 0 ? `You paid ${counterpartyName}` : `${counterpartyName} paid you`
}

/**
 * MoneySpace's position header (UX_REDESIGN.md Part 4 "Money: balance-first,
 * no inner tabs" #1): the single most important line on the Money space —
 * "You're owed £84" / "You owe £42 → Settle" / "All square ✓" — with an
 * expandable per-person breakdown and a "see my breakdown" link into My
 * Spending. Each per-person row is itself tappable, unfolding the pairwise
 * ledger (expense shares + P2P payments between the two of you) so anyone
 * can see WHY they owe what they owe mid-trip. Built on the same balance
 * math every other money surface uses.
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
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null)
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

  // Same merged real-settlements + usable-carryovers list computeMoneyPosition
  // fed computePairwiseBreakdown -- the per-pair ledger must read the same
  // rows or its lines wouldn't sum to the net shown on the row above.
  const settlementsWithCarryovers = useMemo(
    () => mergeSettlementsWithUsableCarryovers(settlements, carryovers, baseCurrency, participants.map((p) => p.user_id)),
    [settlements, carryovers, baseCurrency, participants]
  )

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

      <div className="flex items-center gap-3">
        {position.perPerson.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Show'} per-person breakdown {expanded ? '▲' : '▼'}
          </button>
        )}
        {/* Mid-trip payments are first-class (they're just P2P transactions):
            recording one shouldn't wait for an end-of-trip settle screen, so
            the Settle-up flow -- where payments are recorded and tracked --
            is always reachable right next to the balances. */}
        <button type="button" onClick={onSettleUp} className="text-xs font-medium text-accent-700 dark:text-accent-400 press-scale">
          💸 Record a payment
        </button>
      </div>

      {position.perPerson.length > 0 && expanded && (
        <div className="space-y-2 stagger-list">
          {position.perPerson.map((row) => {
            const person = byUserId.get(row.userId)
            const personName = person?.user?.full_name || person?.user?.email || 'Someone'
            const theyOweMe = row.netMinor > 0
            const isOpen = expandedPersonId === row.userId
            const ledger = isOpen
              ? computePairwiseLedger(expenses, settlementsWithCarryovers, currentUserId, row.userId, baseCurrency)
              : []
            return (
              <div key={row.userId} className="stagger-item">
                <button
                  type="button"
                  onClick={() => setExpandedPersonId((v) => (v === row.userId ? null : row.userId))}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-2.5 text-left press-scale"
                >
                  <UserAvatar avatarData={person?.user} size="xs" alt={personName} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{personName}</span>
                  <span className={`text-sm font-medium tabular-nums ${theyOweMe ? 'text-success-600' : 'text-danger-600'}`}>
                    {theyOweMe ? 'owes you ' : 'you owe '}
                    {formatMoneyMinor(Math.abs(row.netMinor), baseCurrency)}
                  </span>
                  <span className="text-[var(--text-muted)] text-[10px] shrink-0" aria-hidden="true">
                    {isOpen ? '▲' : '▼'}
                  </span>
                </button>

                {isOpen && (
                  <div className="mt-1.5 ml-8 space-y-1 border-l border-[var(--border-subtle)] pl-3">
                    {ledger.map((entry) => (
                      <div key={entry.id} className={`flex items-baseline gap-2 text-xs ${entry.pending ? 'opacity-60' : ''}`}>
                        <span className="shrink-0 w-11 text-[var(--text-muted)] tabular-nums">{ledgerDateLabel(entry.date)}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                          {entry.kind === 'expense' ? entry.label : <>💸 {ledgerEntryLabel(entry, personName)}</>}
                          {entry.note && <span className="text-[var(--text-muted)]"> · {entry.note}</span>}
                          {entry.pending && <span className="text-warning-600"> · pending</span>}
                        </span>
                        <span
                          className={`shrink-0 font-medium tabular-nums ${entry.amountMinor >= 0 ? 'text-success-600' : 'text-danger-600'}`}
                        >
                          {entry.amountMinor >= 0 ? '+' : '−'}
                          {formatMoneyMinor(Math.abs(entry.amountMinor), baseCurrency)}
                        </span>
                      </div>
                    ))}
                    <p className="pt-0.5 text-[10px] text-[var(--text-muted)]">
                      + raises what {personName} owes you · − lowers it{ledger.some((e) => e.pending) ? ' · pending payments not counted yet' : ''}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
