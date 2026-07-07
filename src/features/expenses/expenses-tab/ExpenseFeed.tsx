import { useCallback, useState } from 'react'
import { EmptyState } from '../../../components/ui'
import { NoExpenses } from '../../../components/ui/illustrations'
import { ExpenseCard } from './ExpenseCard'
import { formatMoneyMinor } from '../lib/formatMoney'
import { classifyDayLabel, computeDayGroupSummary, isPastDate, todayDateOnly } from '../lib/expenseRowInsights'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ExpenseFeedProps {
  grouped: Array<{ date: string; expenses: ExpenseWithDetails[] }>
  /** Every trip participant keyed by user_id (payer + liable-avatar resolution, plan point 1). */
  participantsByUserId: Record<string, ParticipantWithUser>
  baseCurrency: string
  currentUserId: string | undefined
  /** Keys the collapsed/expanded-day sessionStorage state per trip (plan point 4). */
  tripId: string
  tripStartDate: string
  tripEndDate: string
  onEdit: (expense: ExpenseWithDetails) => void
  onOpenClaim: (code: string) => void
  editDisabled?: boolean
  onAddExpense?: () => void
}

function expandedStorageKey(tripId: string): string {
  return `expenseFeed:expandedDays:${tripId}`
}

/** Reads the per-trip manual expand/collapse overrides. Falls back to "no overrides" on any storage error (private browsing, quota, SSR) -- this is a display nicety, never worth breaking the feed over. */
function loadExpandedOverrides(tripId: string): Record<string, boolean> {
  try {
    const raw = window.sessionStorage.getItem(expandedStorageKey(tripId))
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function dayHeaderLabel(date: string, tripStartDate: string, tripEndDate: string): string {
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const kind = classifyDayLabel(date, tripStartDate, tripEndDate)
  if (kind === 'pre-trip') return `Pre-trip · ${dateLabel}`
  if (kind === 'post-trip') return `Post-trip · ${dateLabel}`
  return dateLabel
}

/**
 * Day-grouped expense feed (UX_REDESIGN.md Part 4 "Money: balance-first, no
 * inner tabs" #3): the list-rendering half of the legacy ExpensesTab, split
 * out into an importable piece so MoneySpace can reuse it verbatim instead
 * of re-implementing day-grouping/card rendering. `ExpensesTab` itself now
 * renders through this component too (see ExpensesTab.tsx), so there is one
 * source of truth for "how an expense card looks in a day-grouped list".
 *
 * Day headers carry a summary (plan point 4: "Tue 30 Dec · 5 expenses ·
 * £340") and double as a collapse toggle. Days before today default
 * collapsed (sessionStorage-persisted per trip, so a session-long browse
 * doesn't keep re-collapsing what the user opened); today and future days
 * default expanded. Pre-trip/post-trip groups (deposits, refunds -- see
 * UX_REDESIGN.md Part 3 calendar edge case #6) get the same treatment with
 * a label prefix instead of a separate section.
 */
export function ExpenseFeed({
  grouped,
  participantsByUserId,
  baseCurrency,
  currentUserId,
  tripId,
  tripStartDate,
  tripEndDate,
  onEdit,
  onOpenClaim,
  editDisabled,
  onAddExpense,
}: ExpenseFeedProps) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => loadExpandedOverrides(tripId))
  const today = todayDateOnly()

  const isExpanded = useCallback((date: string) => (date in overrides ? overrides[date] : !isPastDate(date, today)), [overrides, today])

  const toggleDay = (date: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [date]: !isExpanded(date) }
      try {
        window.sessionStorage.setItem(expandedStorageKey(tripId), JSON.stringify(next))
      } catch {
        // Best-effort persistence only -- never let storage failures break toggling.
      }
      return next
    })
  }

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
      {grouped.map(({ date, expenses: dayExpenses }) => {
        const summary = computeDayGroupSummary(dayExpenses, baseCurrency)
        const expanded = isExpanded(date)
        return (
          <div key={date}>
            <button
              type="button"
              onClick={() => toggleDay(date)}
              aria-expanded={expanded}
              className="w-full flex items-center justify-between gap-2 mb-2 text-left press-scale"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] truncate">
                {dayHeaderLabel(date, tripStartDate, tripEndDate)} · {summary.count} expense{summary.count === 1 ? '' : 's'} ·{' '}
                {formatMoneyMinor(summary.totalMinor, summary.currency)}
                {summary.hasMissingRate && <span className="text-danger-600 normal-case font-normal"> · missing FX rate</span>}
              </h3>
              <span className="text-[var(--text-muted)] text-[10px] shrink-0" aria-hidden="true">
                {expanded ? '▲' : '▼'}
              </span>
            </button>

            {expanded && (
              <div className="space-y-2 stagger-list">
                {dayExpenses.map((expense) => (
                  <div key={expense.id} className="stagger-item">
                    <ExpenseCard
                      expense={expense}
                      participantsByUserId={participantsByUserId}
                      baseCurrency={baseCurrency}
                      currentUserId={currentUserId}
                      onEdit={() => onEdit(expense)}
                      onOpenClaim={onOpenClaim}
                      editDisabled={editDisabled}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
