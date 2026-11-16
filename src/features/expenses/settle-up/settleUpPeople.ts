import { withMoneyParticipants } from '../lib/balances'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'
import type { SettleUpPerson } from './settleUpLogic'

export const LEFT_TRIP_SUFFIX = ' (left the trip)'

interface ParticipantLike {
  user_id: string
  user?: { full_name?: string | null; email?: string | null } | null
}

/**
 * The people Settle Up computes over: the active roster plus anyone else who
 * appears in the money (payer, split member, claimant, settlement or carryover
 * party), marked `left`. Without the latter a removed person's expenses and
 * payments drop out of the ledger and the balances stop summing to zero.
 * `all` (including inactive rows) supplies names; unknown ids fall back to
 * "Former member".
 */
export function buildSettleUpPeople(input: {
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  carryovers: SettlementCarryover[]
  baseCurrency: string
  active: ParticipantLike[]
  all: ParticipantLike[]
}): SettleUpPerson[] {
  const nameOf = (p: ParticipantLike | undefined) => p?.user?.full_name || p?.user?.email || 'Former member'
  const allById = new Map(input.all.map((p) => [p.user_id, p]))
  const activeIds = input.active.map((p) => p.user_id)
  const activeSet = new Set(activeIds)
  const ids = withMoneyParticipants(activeIds, input.expenses, input.settlements, input.baseCurrency, input.carryovers)
  return ids.map((userId) => {
    const row = input.active.find((p) => p.user_id === userId) ?? allById.get(userId)
    return activeSet.has(userId) ? { userId, name: nameOf(row) } : { userId, name: nameOf(row), left: true }
  })
}
