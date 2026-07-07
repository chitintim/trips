import { Chip } from '../../../components/ui'
import { ALL_CATEGORIES, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import type { ExpenseFilterState } from '../expenses-tab/ExpenseFilters'

export interface MoneyFilterChipsProps {
  filters: ExpenseFilterState
  onChange: (updater: (prev: ExpenseFilterState) => ExpenseFilterState) => void
  /** The current user's id, so "Mine" can toggle the personId filter to self. */
  currentUserId: string | undefined
}

/**
 * MoneySpace's filter chips (UX_REDESIGN.md Part 4 "Money: balance-first, no
 * inner tabs" #2): All · Mine · Unclaimed · by category. "All" clears every
 * filter in one tap; "Mine" reuses the existing personId filter pinned to
 * the current user (paid by me, split to me, or claimed by me — see
 * ExpenseFilters.applyExpenseFilters).
 */
export function MoneyFilterChips({ filters, onChange, currentUserId }: MoneyFilterChipsProps) {
  const isAll = !filters.category && !filters.personId && !filters.unclaimedOnly
  const isMine = filters.personId === currentUserId

  return (
    <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Chip selected={isAll} onClick={() => onChange(() => ({ category: null, personId: null, currency: null, unclaimedOnly: false }))} size="sm">
        All
      </Chip>
      <Chip
        selected={isMine}
        onClick={() => onChange((f) => ({ ...f, personId: f.personId === currentUserId ? null : currentUserId ?? null }))}
        size="sm"
      >
        Mine
      </Chip>
      <Chip selected={filters.unclaimedOnly} onClick={() => onChange((f) => ({ ...f, unclaimedOnly: !f.unclaimedOnly }))} size="sm">
        🧾 Unclaimed
      </Chip>
      {ALL_CATEGORIES.map((c) => (
        <Chip
          key={c}
          selected={filters.category === c}
          onClick={() => onChange((f) => ({ ...f, category: f.category === c ? null : c }))}
          size="sm"
          icon={categoryIcon(c)}
        >
          {categoryLabel(c)}
        </Chip>
      ))}
    </div>
  )
}
