import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Skeleton } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { effectiveTripStage } from '../../../lib/tripStage'
import { MoneyPositionHeader } from './MoneyPositionHeader'
import { MoneyFilterChips } from './MoneyFilterChips'
import { ExpenseFeed } from '../expenses-tab/ExpenseFeed'
import { ExpenseEditorWizard } from '../editor/ExpenseEditorWizard'
import { SettleUpTab } from '../settle-up/SettleUpTab'
import { MySpendingTab } from '../my-spending/MySpendingTab'
import { EMPTY_FILTERS, applyExpenseFilters, groupExpensesByDay } from '../expenses-tab/ExpenseFilters'
import type { Trip } from '../../../types'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface MoneySpaceProps {
  trip: Trip
  /**
   * Legacy ?tab= deep links for money sub-tabs land here — 'settle-up' opens
   * the pushed Settle-up screen, 'my-spending' opens My Spending, anything
   * else (or undefined) is just the feed (UX_REDESIGN.md Part 4 #1's
   * back-compat requirement).
   */
  initialScreen?: 'settle-up' | 'my-spending' | null
}

/**
 * MoneySpace (UX_REDESIGN.md Part 4 "Money: balance-first, no inner tabs"):
 * one screen — position header, filter chips, day-grouped feed — with
 * Settle-up rendered as a STATE card (prominent when balances are frozen or
 * the trip has completed) rather than a tab, and My Spending reached only by
 * "see my breakdown" from the position header. Both push as full-screen
 * sheets built from the SAME SettleUpTab/MySpendingTab components v2.0
 * shipped (Money internals unchanged per UX_REDESIGN.md §3/Part 4 — only
 * the hub chrome around them changes). EXPENSE_TAB_CONFIGS stays exported
 * from the feature barrel for back-compat but is no longer rendered as an
 * inner tab strip anywhere.
 */
export function MoneySpace({ trip, initialScreen = null }: MoneySpaceProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { data, isLoading } = useExpenses(trip.id)
  const { data: participants = [] } = useParticipants(trip.id)

  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingExpense, setEditingExpense] = useState<ExpenseWithDetails | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [settleUpOpen, setSettleUpOpen] = useState(initialScreen === 'settle-up')
  const [mySpendingOpen, setMySpendingOpen] = useState(initialScreen === 'my-spending')

  const expenses = data?.expenses ?? []
  const settlements = data?.settlements ?? []
  const isFrozen = !!trip.settlement_snapshot
  const effectiveStage = effectiveTripStage(trip)
  // Settle-up as a STATE (plan §4 #4): the card is prominent whenever
  // there's an active settlement flow to finish — balances frozen (a
  // suggestion round is in progress) or the trip has effectively completed
  // (settling up is the natural next step) — not merely "some balance
  // exists" (that's every trip, every day).
  const settleUpIsProminent = isFrozen || effectiveStage === 'trip_completed'

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
        <Skeleton variant="card" height={140} />
        <Skeleton variant="list" lines={4} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <MoneyPositionHeader
        expenses={expenses}
        settlements={settlements}
        participants={participants}
        currentUserId={user?.id}
        baseCurrency={trip.base_currency}
        onSettleUp={() => setSettleUpOpen(true)}
        onSeeMyBreakdown={() => setMySpendingOpen(true)}
      />

      {/* Settle-up STATE card (plan §4 #4): only prominent when there's an
          active flow to finish, otherwise the position header's "Settle"
          button above is the only entry point (no redundant chrome). */}
      {settleUpIsProminent && (
        <button
          type="button"
          onClick={() => setSettleUpOpen(true)}
          className="w-full text-left rounded-[var(--radius-lg)] border border-accent-300 bg-accent-50 dark:bg-accent-950/30 p-4 press-scale hover:border-accent-400 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-accent-800 dark:text-accent-300">
                {isFrozen ? '🔒 Balances are frozen — settlement in progress' : '🏁 Trip complete — settle up'}
              </p>
              <p className="text-xs text-accent-700 dark:text-accent-400 mt-0.5">
                {isFrozen ? 'Review suggested payments and mark them paid.' : 'Wrap up who owes what before everyone forgets.'}
              </p>
            </div>
            <span className="text-accent-600 dark:text-accent-400 shrink-0" aria-hidden="true">
              →
            </span>
          </div>
        </button>
      )}

      <MoneyFilterChips filters={filters} onChange={setFilters} currentUserId={user?.id} />

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

      {/* Settle up — pushed screen (plan §4 #4), not a tab. */}
      <Modal isOpen={settleUpOpen} onClose={() => setSettleUpOpen(false)} size="xl" title="Settle up">
        <SettleUpTab trip={trip} />
      </Modal>

      {/* My spending — pushed from the position header's "see my breakdown" (plan §4 #5), not a tab. */}
      <Modal isOpen={mySpendingOpen} onClose={() => setMySpendingOpen(false)} size="xl" title="My spending">
        <MySpendingTab trip={trip} />
      </Modal>
    </div>
  )
}
