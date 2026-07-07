import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, Button, Skeleton } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { BalanceHeader } from './BalanceHeader'
import { ExpenseFeed } from './ExpenseFeed'
import { ExpenseEditorWizard } from '../editor/ExpenseEditorWizard'
import { EMPTY_FILTERS, applyExpenseFilters, groupExpensesByDay } from './ExpenseFilters'
import { ALL_CATEGORIES, categoryIcon, categoryLabel } from '../lib/categoryStyle'
import type { Trip } from '../../../types'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface ExpensesTabProps {
  trip: Trip
}

/**
 * Redesigned Expenses tab (plan §10 #5): day-grouped cards, category icons,
 * payer avatar, FX badge, receipt thumbnail, claim-status ring, filter
 * chips (category/person/currency/unclaimed), balance header StatCards.
 */
export function ExpensesTab({ trip }: ExpensesTabProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { data, isLoading } = useExpenses(trip.id)
  const { data: participants = [] } = useParticipants(trip.id)

  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingExpense, setEditingExpense] = useState<ExpenseWithDetails | null>(null)
  const [editorKey, setEditorKey] = useState(0)

  const expenses = data?.expenses ?? []
  const settlements = data?.settlements ?? []
  // Freeze flow (plan §12): a frozen settlement snapshot blocks expense
  // edits (unfreeze + audit required to resume) -- see SettleUpTab.
  const isFrozen = !!trip.settlement_snapshot

  const currencies = useMemo(() => Array.from(new Set(expenses.map((e) => e.currency))), [expenses])

  const filtered = useMemo(() => applyExpenseFilters(expenses, filters), [expenses, filters])
  const grouped = useMemo(() => groupExpensesByDay(filtered), [filtered])

  const payerByUserId = useMemo(() => Object.fromEntries(participants.map((p) => [p.user_id, p])), [participants])

  const openAdd = () => {
    setEditingExpense(null)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }

  const openEdit = (expense: ExpenseWithDetails) => {
    setEditingExpense(expense)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={100} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BalanceHeader
        expenses={expenses}
        settlements={settlements}
        participantUserIds={participants.map((p) => p.user_id)}
        currentUserId={user?.id}
        baseCurrency={trip.base_currency}
      />

      {isFrozen && (
        <div className="rounded-[var(--radius-md)] border border-accent-200 bg-accent-50 dark:bg-accent-950 dark:border-accent-800 px-3.5 py-2.5 text-sm text-accent-700 dark:text-accent-300">
          🔒 Balances are frozen for settlement. Unfreeze from the Settle Up tab to edit expenses again.
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip
            selected={filters.unclaimedOnly}
            onClick={() => setFilters((f) => ({ ...f, unclaimedOnly: !f.unclaimedOnly }))}
            size="sm"
          >
            🧾 Unclaimed
          </Chip>
          {ALL_CATEGORIES.map((c) => (
            <Chip
              key={c}
              selected={filters.category === c}
              onClick={() => setFilters((f) => ({ ...f, category: f.category === c ? null : c }))}
              size="sm"
              icon={categoryIcon(c)}
            >
              {categoryLabel(c)}
            </Chip>
          ))}
          {currencies.length > 1 &&
            currencies.map((c) => (
              <Chip
                key={c}
                selected={filters.currency === c}
                onClick={() => setFilters((f) => ({ ...f, currency: f.currency === c ? null : c }))}
                size="sm"
              >
                {c}
              </Chip>
            ))}
        </div>
        <Button variant="primary" size="sm" onClick={openAdd} className="shrink-0" disabled={isFrozen}>
          + Add
        </Button>
      </div>

      <ExpenseFeed
        grouped={grouped}
        payerByUserId={payerByUserId}
        baseCurrency={trip.base_currency}
        currentUserId={user?.id}
        onEdit={openEdit}
        onOpenClaim={(code) => navigate(`/claim/${code}`)}
        editDisabled={isFrozen}
        onAddExpense={openAdd}
      />

      <ExpenseEditorWizard
        key={editorKey}
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        trip={trip}
        participants={participants}
        allExpenses={expenses}
        editingExpense={editingExpense}
      />
    </div>
  )
}
