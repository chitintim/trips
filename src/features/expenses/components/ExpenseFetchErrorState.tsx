import { Button, EmptyState } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'

export interface ExpenseFetchErrorStateProps {
  /** What failed to load, e.g. "expenses" or "your spending" -- feeds the title copy. */
  label: string
  /** Refetch handler, typically the `refetch` returned by the failing useQuery. */
  onRetry: () => void
}

/**
 * Audit finding #1: MoneySpace/MySpendingTab used to destructure only
 * `{ data, isLoading }` from useExpenses, so a failed fetch fell through to
 * the "No expenses yet" empty state -- indistinguishable from a trip that
 * genuinely has none. This is the shared fallback both screens render on
 * `isError` instead: same ErrorState illustration + copy pattern as
 * ErrorBoundary.tsx, but scoped to a single query (no need to unmount the
 * whole tab) with a retry that calls the query's own `refetch`.
 */
export function ExpenseFetchErrorState({ label, onRetry }: ExpenseFetchErrorStateProps) {
  return (
    <EmptyState
      icon={<ErrorState className="w-24 h-24 text-danger-500" />}
      title={`Couldn't load ${label}`}
      description="Something went wrong fetching this. Check your connection and try again."
      action={
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  )
}
