import { computeBalances, withMoneyParticipants } from '../../expenses/lib/balances'
import { balanceEpsilonMajor } from '../../expenses/settle-up/settleUpLogic'
import { fromMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'

export interface RemovalGuardInput {
  userId: string
  /** undefined while expenses/settlements are still loading. */
  expenses: ExpenseWithDetails[] | undefined
  settlements: Settlement[] | undefined
  carryovers: SettlementCarryover[]
  activeUserIds: string[]
  baseCurrency: string
}

export interface RemovalGuardResult {
  /** True while the data needed to decide has not loaded: removal must stay blocked. */
  loading: boolean
  /** Net balance in base-currency minor units (positive = owed money); null while loading. */
  netBalanceMinor: number | null
  hasBalance: boolean
  hasOpenSettlement: boolean
  /** They paid or are split on expenses with no FX rate, so their balance is unknown. */
  hasUnconvertedExpenses: boolean
  blocked: boolean
}

/**
 * Whether removing (deactivating) a participant would make money disappear.
 * Mirrors the server trigger guard_participant_removal
 * (20261116130000_guard_participant_removal.sql): same rules, so the UI
 * shows the reason before the server would refuse.
 */
export function evaluateRemovalGuard(input: RemovalGuardInput): RemovalGuardResult {
  const { userId, expenses, settlements, carryovers, activeUserIds, baseCurrency } = input
  if (!expenses || !settlements) {
    return { loading: true, netBalanceMinor: null, hasBalance: false, hasOpenSettlement: false, hasUnconvertedExpenses: false, blocked: true }
  }

  const ids = withMoneyParticipants(activeUserIds, expenses, settlements, baseCurrency, carryovers)
  const { balances, expensesMissingRate } = computeBalances(expenses, settlements, ids, baseCurrency, carryovers)
  const net = balances.find((b) => b.userId === userId)?.netBalanceMinor ?? 0
  const hasBalance = Math.abs(fromMinorUnits(net, baseCurrency)) > balanceEpsilonMajor(baseCurrency)

  const hasOpenSettlement = settlements.some(
    (s) => (s.from_user_id === userId || s.to_user_id === userId) && (s.status ?? 'confirmed') !== 'confirmed'
  )

  const missing = new Set(expensesMissingRate)
  const hasUnconvertedExpenses = expenses.some(
    (e) =>
      missing.has(e.id) &&
      (e.paid_by === userId || e.splits.some((s) => s.user_id === userId) || e.claims.some((c) => c.user_id === userId))
  )

  return {
    loading: false,
    netBalanceMinor: net,
    hasBalance,
    hasOpenSettlement,
    hasUnconvertedExpenses,
    blocked: hasBalance || hasOpenSettlement || hasUnconvertedExpenses,
  }
}
