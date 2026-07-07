import { EmptyState } from '../../../components/ui'
import { NoExpenses } from '../../../components/ui/illustrations'
import { ExpenseCard } from './ExpenseCard'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ExpenseFeedProps {
  grouped: Array<{ date: string; expenses: ExpenseWithDetails[] }>
  payerByUserId: Record<string, ParticipantWithUser>
  baseCurrency: string
  currentUserId: string | undefined
  onEdit: (expense: ExpenseWithDetails) => void
  onOpenClaim: (code: string) => void
  editDisabled?: boolean
  onAddExpense?: () => void
}

/**
 * Day-grouped expense feed (UX_REDESIGN.md Part 4 "Money: balance-first, no
 * inner tabs" #3): the list-rendering half of the legacy ExpensesTab, split
 * out into an importable piece so MoneySpace can reuse it verbatim instead
 * of re-implementing day-grouping/card rendering. `ExpensesTab` itself now
 * renders through this component too (see ExpensesTab.tsx), so there is one
 * source of truth for "how an expense card looks in a day-grouped list".
 */
export function ExpenseFeed({
  grouped,
  payerByUserId,
  baseCurrency,
  currentUserId,
  onEdit,
  onOpenClaim,
  editDisabled,
  onAddExpense,
}: ExpenseFeedProps) {
  if (grouped.length === 0) {
    return (
      <EmptyState
        icon={<NoExpenses className="w-32 h-24 text-[var(--text-muted)]" />}
        title="No expenses yet"
        description="Add the first expense for this trip to start tracking who owes what."
        action={
          onAddExpense ? (
            <button
              type="button"
              onClick={onAddExpense}
              disabled={editDisabled}
              className="inline-flex items-center justify-center rounded-[var(--radius-md)] bg-accent-600 hover:bg-accent-700 text-white font-medium text-[0.9375rem] px-4 h-11 press-scale disabled:opacity-50"
            >
              Add expense
            </button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {grouped.map(({ date, expenses: dayExpenses }) => (
        <div key={date}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">
            {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </h3>
          <div className="space-y-2 stagger-list">
            {dayExpenses.map((expense) => (
              <div key={expense.id} className="stagger-item">
                <ExpenseCard
                  expense={expense}
                  payer={payerByUserId[expense.paid_by]}
                  baseCurrency={baseCurrency}
                  currentUserId={currentUserId}
                  onEdit={() => onEdit(expense)}
                  onOpenClaim={onOpenClaim}
                  editDisabled={editDisabled}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
