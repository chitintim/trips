import { useMemo } from 'react'
import { Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useSettlements, useSettlementCarryovers } from '../../../lib/queries/useSettlements'
import { computeBalances, splitOwedAmounts } from '../../expenses'
import { formatMoney } from '../../decisions/lib/costImpact'
import type { Trip } from '../../../types'

export interface SettleStatusCardProps {
  trip: Trip
  onNavigate: (spaceId: string) => void
  /** Compact chip mode for the ongoing layout ("you owe / are owed" chip). */
  compact?: boolean
}

/**
 * Settle status (completed Today layout, and the compact running-balance
 * chip during the trip): the user's net position using the SAME balance
 * math as the Money tabs, one tap to Settle up.
 */
export function SettleStatusCard({ trip, onNavigate, compact = false }: SettleStatusCardProps) {
  const { user } = useAuth()
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: expensesData } = useExpenses(trip.id)
  const { data: settlements = [] } = useSettlements(trip.id)
  // Folded cross-trip carryovers move real money on this trip -- computing
  // without them would show a phantom (even sign-flipped) balance here once
  // a carryover-inclusive settlement is paid, disagreeing with Money/Settle
  // Up. Same balance math, same inputs, everywhere.
  const { data: carryovers = [] } = useSettlementCarryovers(trip.id)

  const summary = useMemo(() => {
    if (!user || participants.length === 0) return null
    const { balances } = computeBalances(
      expensesData?.expenses ?? [],
      settlements,
      participants.map((p) => p.user_id),
      trip.base_currency,
      carryovers
    )
    const mine = balances.find((b) => b.userId === user.id)
    if (!mine) return null
    return { ...splitOwedAmounts(mine.netBalanceMinor, trip.base_currency), isBalanced: mine.isBalanced }
  }, [user, participants, expensesData, settlements, trip.base_currency, carryovers])

  if (!summary) return null
  if (compact && summary.isBalanced && (expensesData?.expenses ?? []).length === 0) return null

  const statusLine = summary.isBalanced
    ? "You're all square 🎉"
    : summary.youOwe > 0
      ? `You owe ${formatMoney(summary.youOwe, trip.base_currency)}`
      : `You're owed ${formatMoney(summary.owedToYou, trip.base_currency)}`

  if (compact) {
    return (
      <button
        onClick={() => onNavigate('money')}
        className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
      >
        <span className="text-sm text-[var(--text-primary)]">
          💸 <span className="font-medium">{statusLine}</span>
        </span>
        <span className="text-sm text-[var(--text-muted)]">Money →</span>
      </button>
    )
  }

  return (
    <Card>
      <Card.Content className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Settling up</h3>
        <p className="text-2xl font-semibold text-[var(--text-primary)]">{statusLine}</p>
        {!summary.isBalanced && (
          <p className="text-sm text-[var(--text-muted)]">Suggested payments are ready in Settle up.</p>
        )}
        <Button size="sm" onClick={() => onNavigate('money')}>
          {summary.isBalanced ? 'See the money summary' : 'Settle up'}
        </Button>
      </Card.Content>
    </Card>
  )
}
