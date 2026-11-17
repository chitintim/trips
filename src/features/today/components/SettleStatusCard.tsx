import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useSettlements, useSettlementCarryovers } from '../../../lib/queries/useSettlements'
import { explainMoneyPosition } from '../../../lib/cost/moneyEquation'
import { useMoneyInputsSettled } from '../../expenses/money-space/useMoneyInputsSettled'
import { buildMoneyPositionView } from '../../expenses/money-space/moneyPositionView'
import type { Trip } from '../../../types'

export interface SettleStatusCardProps {
  trip: Trip
  onNavigate: (spaceId: string) => void
}

/**
 * Running-balance chip during the trip: the user's net position using the
 * SAME balance math as the Money tabs. After the trip, paying is a to-do in
 * Your to-dos, so this card is only used while the trip is on.
 */
export function SettleStatusCard({ trip, onNavigate }: SettleStatusCardProps) {
  const { user } = useAuth()
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: expensesData } = useExpenses(trip.id)
  const { data: settlements = [] } = useSettlements(trip.id)
  // Folded cross-trip carryovers move real money on this trip -- computing
  // without them would show a phantom (even sign-flipped) balance here once
  // a carryover-inclusive settlement is paid, disagreeing with Money/Settle
  // Up. Same balance math, same inputs, everywhere.
  const { data: carryovers = [] } = useSettlementCarryovers(trip.id)
  const inputsSettled = useMoneyInputsSettled(trip.id)

  // The SAME headline the Money header prints (explainMoneyPosition + buildMoneyPositionView), so money
  // already marked paid is never called "You owe", and a frozen trip with stale suggested rows is
  // never called square.
  const view = useMemo(() => {
    if (!user || participants.length === 0) return null
    const names: Record<string, string> = {}
    for (const p of participants) names[p.user_id] = p.user?.full_name || p.user?.email || 'someone'
    return buildMoneyPositionView(
      explainMoneyPosition({
        expenses: expensesData?.expenses ?? [],
        settlements,
        participantUserIds: participants.map((p) => p.user_id),
        currentUserId: user.id,
        baseCurrency: trip.base_currency,
        carryovers,
        frozen: trip.settlement_snapshot != null,
        inputsSettled,
        names,
      })
    )
  }, [user, participants, expensesData, settlements, trip.base_currency, trip.settlement_snapshot, carryovers, inputsSettled])

  if (!view) return null
  if (view.square && (expensesData?.expenses ?? []).length === 0) return null

  const statusLine = view.square ? "You're all square 🎉" : view.headline

  return (
    <button
      onClick={() => onNavigate('money')}
      className="w-full text-left rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 flex items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
    >
      <span className="text-sm text-[var(--text-primary)]">
        💸 <span className="font-medium">{statusLine}</span>
        {view.settleHint && <span className="block text-xs text-[var(--text-muted)]">{view.settleHint}</span>}
      </span>
      <span className="text-sm text-[var(--text-muted)]">Money →</span>
    </button>
  )
}
