import { StatCard, Badge } from '../../../components/ui'
import { fromMinorUnits } from '../../../lib/money'
import { computeBalances, splitOwedAmounts } from '../lib/balances'
import { formatMoney } from '../lib/formatMoney'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

export interface BalanceHeaderProps {
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  participantUserIds: string[]
  currentUserId: string | undefined
  baseCurrency: string
}

/**
 * Balance header (plan §10 #5): StatCards for you owe / owed to you /
 * group total in trips.base_currency, plus a prominent warning chip for
 * expenses missing FX rates (v1 bug fix -- never silently zero them out).
 */
export function BalanceHeader({ expenses, settlements, participantUserIds, currentUserId, baseCurrency }: BalanceHeaderProps) {
  const { balances, groupTotalMinor, expensesMissingRate } = computeBalances(
    expenses,
    settlements,
    participantUserIds,
    baseCurrency
  )

  const myBalance = balances.find((b) => b.userId === currentUserId)
  const { youOwe, owedToYou } = splitOwedAmounts(myBalance?.netBalanceMinor ?? 0, baseCurrency)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="You owe" value={formatMoney(youOwe, baseCurrency)} size="sm" />
        <StatCard label="Owed to you" value={formatMoney(owedToYou, baseCurrency)} size="sm" />
        <StatCard label="Group total" value={formatMoney(fromMinorUnits(groupTotalMinor, baseCurrency), baseCurrency)} size="sm" />
      </div>

      {expensesMissingRate.length > 0 && (
        <Badge variant="warning">
          ⚠️ {expensesMissingRate.length} expense{expensesMissingRate.length === 1 ? '' : 's'} missing FX rates — excluded from totals above
        </Badge>
      )}
    </div>
  )
}
