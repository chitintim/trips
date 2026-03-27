import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Spinner, EmptyState } from './ui'
import { AddExpenseModal } from './AddExpenseModal'
import { RecordSettlementModal } from './RecordSettlementModal'
import { SettlementHistoryModal } from './SettlementHistoryModal'
import { formatCurrency, convertCurrency, isProvisionalRate, isConfirmedRateAvailable, type Currency } from '../lib/currency'
import { minimizeTransactions, getUserTransactions, type Person } from '../lib/debtMinimization'
import { getReceiptUrl } from '../lib/receiptUpload'
import { Database } from '../types/database.types'

type Expense = Database['public']['Tables']['expenses']['Row']
type ExpenseSplit = Database['public']['Tables']['expense_splits']['Row']
type User = Database['public']['Tables']['users']['Row']
type Settlement = Database['public']['Tables']['settlements']['Row']

export interface ExpenseWithDetails extends Expense {
  payer: User
  splits: Array<ExpenseSplit & { user: User }>
  line_items?: any[]
  claims?: any[]
  allocation_link?: any
  expected_participants?: string[]
}

interface BalanceData {
  userId: string
  user: User
  totalPaid: number
  totalOwed: number
  settlementsReceived: number
  settlementsPaid: number
  netBalance: number
}

export function ExpensesTab({ tripId, participants }: { tripId: string; participants: any[] }) {
  const { user } = useAuth()
  const [expenses, setExpenses] = useState<ExpenseWithDetails[]>([])
  const [balances, setBalances] = useState<BalanceData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState<string>('all')
  const [addExpenseModalOpen, setAddExpenseModalOpen] = useState(false)
  const [recordSettlementModalOpen, setRecordSettlementModalOpen] = useState(false)
  const [settlementHistoryModalOpen, setSettlementHistoryModalOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [editingExpense, setEditingExpense] = useState<ExpenseWithDetails | null>(null)
  const [updatingFx, setUpdatingFx] = useState(false)

  // Ref to track expenses for real-time callbacks (avoids stale closures)
  const expensesRef = useRef<ExpenseWithDetails[]>([])
  expensesRef.current = expenses

  // Ref to suppress real-time refreshes during FX bulk update
  const suppressRealtimeRef = useRef(false)

  // Cache settlements so claim-change recalculations don't need a separate fetch
  const settlementsRef = useRef<Settlement[]>([])

  const isOrganizer = participants.some((p: any) => p.user_id === user?.id && p.role === 'organizer')

  useEffect(() => {
    checkAdminStatus()
  }, [user])

  const checkAdminStatus = async () => {
    if (!user) return
    const { data } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (data) {
      setIsAdmin(data.role === 'admin')
    }
  }

  useEffect(() => {
    fetchExpenses()
  }, [tripId])

  // Real-time subscription for expense updates — only depends on tripId
  useEffect(() => {
    if (!tripId) return

    // Subscribe to expense changes
    const expenseChannel = supabase
      .channel(`trip_expenses_realtime:${tripId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'expenses',
          filter: `trip_id=eq.${tripId}`
        },
        () => {
          if (suppressRealtimeRef.current) {
            console.log('⏸️ Expense changed but suppressed during FX update')
            return
          }
          console.log('✅ Expense changed, refreshing all...')
          fetchExpenses()
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*', // INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'expense_item_claims'
        },
        (payload: any) => handleClaimChangeRef.current(payload)
      )
      .subscribe()

    console.log('✅ Real-time subscription active for expense claims')

    return () => {
      console.log('🔴 Closing real-time subscription')
      supabase.removeChannel(expenseChannel)
    }
  }, [tripId])

  const fetchExpenses = async () => {
    // Only show full spinner on initial load, not re-fetches
    const isInitialLoad = expenses.length === 0
    if (isInitialLoad) setLoading(true)

    // Fetch expenses with payer and splits
    const { data: expensesData, error } = await supabase
      .from('expenses')
      .select(`
        *,
        payer:paid_by (*),
        splits:expense_splits (
          *,
          user:user_id (*)
        )
      `)
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching expenses:', error)
      setLoading(false)
      return
    }

    // Identify itemized expenses for batch loading
    const itemizedExpenseIds = (expensesData || [])
      .filter((e: any) => e.ai_parsed && e.status)
      .map((e: any) => e.id as string)

    // Collect option_ids for selection lookup
    const optionIds = [...new Set(
      (expensesData || [])
        .filter((e: any) => e.option_id)
        .map((e: any) => e.option_id as string)
    )]

    // Batch-fetch all itemized data + selections + settlements in parallel (3 bulk queries instead of N*3)
    const [lineItemsRes, claimsRes, linksRes, selectionsRes, settlementsRes] = await Promise.all([
      itemizedExpenseIds.length > 0
        ? supabase.from('expense_line_items').select('*').in('expense_id', itemizedExpenseIds).order('line_number')
        : Promise.resolve({ data: [] as any[], error: null }),
      itemizedExpenseIds.length > 0
        ? supabase.from('expense_item_claims').select('*, user:user_id (id, full_name, avatar_data)').in('expense_id', itemizedExpenseIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      itemizedExpenseIds.length > 0
        ? supabase.from('expense_allocation_links').select('*').in('expense_id', itemizedExpenseIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      optionIds.length > 0
        ? supabase.from('selections').select('option_id, user_id').in('option_id', optionIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      supabase.from('settlements').select('*').eq('trip_id', tripId),
    ])

    // Group itemized data by expense_id
    const lineItemsByExpense = new Map<string, any[]>()
    for (const item of (lineItemsRes.data || [])) {
      const list = lineItemsByExpense.get(item.expense_id) || []
      list.push(item)
      lineItemsByExpense.set(item.expense_id, list)
    }

    const claimsByExpense = new Map<string, any[]>()
    for (const claim of (claimsRes.data || [])) {
      const list = claimsByExpense.get(claim.expense_id) || []
      list.push(claim)
      claimsByExpense.set(claim.expense_id, list)
    }

    const linkByExpense = new Map<string, any>()
    for (const link of (linksRes.data || [])) {
      linkByExpense.set(link.expense_id, link)
    }

    // Build option selections map
    const optionSelections: Record<string, string[]> = {}
    for (const sel of (selectionsRes.data || [])) {
      if (!optionSelections[sel.option_id]) optionSelections[sel.option_id] = []
      optionSelections[sel.option_id].push(sel.user_id)
    }

    // Assemble final expenses array
    const assembledExpenses = (expensesData || []).map((expense: any) => ({
      ...expense,
      line_items: lineItemsByExpense.get(expense.id) || [],
      claims: claimsByExpense.get(expense.id) || [],
      allocation_link: linkByExpense.get(expense.id) || null,
      expected_participants: expense.option_id ? (optionSelections[expense.option_id] || []) : [],
    }))

    setExpenses(assembledExpenses as any)

    // Calculate balances using pre-fetched settlements
    calculateBalances(assembledExpenses as any, (settlementsRes.data || []) as Settlement[])

    setLoading(false)
  }

  const calculateBalances = (expensesData: ExpenseWithDetails[], settlements?: Settlement[]) => {
    console.log('Calculating balances for', expensesData.length, 'expenses')

    // Use provided settlements, or fall back to cached settlements from last full fetch
    if (settlements) {
      settlementsRef.current = settlements
    } else {
      settlements = settlementsRef.current
    }

    console.log('Found', settlements.length, 'settlements')

    // Build FX rate map from DB values only (no API calls — keeps page load fast)
    // Expenses missing fx_rate will show 0 in balances until user clicks "Update FX"
    const fxRateMap = new Map<string, number>() // expense_id → rate to GBP
    for (const exp of expensesData) {
      if (exp.fx_rate) {
        fxRateMap.set(exp.id, exp.fx_rate)
      }
    }

    // Helper: get GBP amount for an expense
    const getExpenseGBP = (exp: ExpenseWithDetails): number => {
      if (exp.base_currency_amount) return exp.base_currency_amount
      if (!exp.currency || exp.currency === 'GBP') return exp.amount
      const rate = fxRateMap.get(exp.id)
      return rate ? exp.amount * rate : 0 // skip if no rate available
    }

    // Helper: get GBP amount for a split
    const getSplitGBP = (split: ExpenseSplit, expense: ExpenseWithDetails): number => {
      if (split.base_currency_amount) return split.base_currency_amount
      if (!expense.currency || expense.currency === 'GBP') return split.amount
      const rate = fxRateMap.get(expense.id)
      return rate ? split.amount * rate : 0
    }

    // Calculate for each participant
    const balanceMap = new Map<string, BalanceData>()

    participants.forEach(participant => {
      const userId = participant.user_id
      const participantUser = participant.user

      // Total paid by this user (in GBP)
      const totalPaid = expensesData
        .filter(exp => exp.paid_by === userId)
        .reduce((sum, exp) => sum + getExpenseGBP(exp), 0)

      // Total owed by this user from regular expense splits (in GBP)
      const totalOwedFromSplits = expensesData
        .reduce((sum, exp) => {
          const userSplits = (exp.splits || []).filter(s => s.user_id === userId)
          return sum + userSplits.reduce((s, split) => s + getSplitGBP(split, exp), 0)
        }, 0)

      // Total owed by this user from itemized expense claims (in GBP)
      const totalOwedFromClaims = expensesData
        .filter(exp => exp.ai_parsed && exp.claims)
        .reduce((sum: number, exp: any) => {
          const userClaims = (exp.claims || []).filter((claim: any) => claim.user_id === userId)
          const claimTotal = userClaims.reduce((claimSum: number, claim: any) => {
            const amountInOriginalCurrency = claim.amount_owed || 0
            const rate = fxRateMap.get(exp.id) || exp.fx_rate || (exp.currency === 'GBP' ? 1 : 0)
            return claimSum + (amountInOriginalCurrency * rate)
          }, 0)
          return sum + claimTotal
        }, 0)

      // Combined total owed
      const totalOwed = totalOwedFromSplits + totalOwedFromClaims

      // Settlements received (others paid this user)
      const settlementsReceived = settlements
        .filter(s => s.to_user_id === userId)
        .reduce((sum, s) => sum + s.amount, 0)

      // Settlements paid (this user paid others)
      const settlementsPaid = settlements
        .filter(s => s.from_user_id === userId)
        .reduce((sum, s) => sum + s.amount, 0)

      // When you PAY someone (settlementsPaid), your debt decreases (balance improves)
      // When you RECEIVE payment (settlementsReceived), what you're owed decreases (balance worsens)
      const netBalance = totalPaid - totalOwed + settlementsPaid - settlementsReceived

      balanceMap.set(userId, {
        userId,
        user: participantUser,
        totalPaid,
        totalOwed,
        settlementsReceived,
        settlementsPaid,
        netBalance
      })
    })

    const newBalances = Array.from(balanceMap.values())
    console.log('Final balances:', newBalances.map(b => ({
      name: b.user.full_name || b.user.email,
      netBalance: b.netBalance
    })))
    setBalances(newBalances)
  }

  // Update FX rates for expenses missing conversion data
  const handleUpdateFxRates = async () => {
    setUpdatingFx(true)
    suppressRealtimeRef.current = true // Suppress real-time refreshes during bulk update
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]
    let updated = 0
    let failed = 0

    // Find expenses missing FX data or with provisional rates that can be updated
    const needsUpdate = expenses.filter(exp => {
      if (!exp.currency || exp.currency === 'GBP') return false
      if (!exp.base_currency_amount || !exp.fx_rate) return true
      if (isProvisionalRate(exp.payment_date, exp.fx_rate_date) && isConfirmedRateAvailable(exp.payment_date)) return true
      return false
    })

    if (needsUpdate.length === 0) {
      alert('All expenses already have up-to-date FX rates.')
      suppressRealtimeRef.current = false
      setUpdatingFx(false)
      return
    }

    // Quick connectivity check before processing all expenses
    try {
      const testResult = await convertCurrency(1, needsUpdate[0].currency as Currency, todayStr, 'GBP')
      if (!testResult) {
        alert('The exchange rate API is currently unavailable. Please try again later.')
        suppressRealtimeRef.current = false
        setUpdatingFx(false)
        return
      }
    } catch {
      alert('The exchange rate API is currently unavailable. Please try again later.')
      suppressRealtimeRef.current = false
      setUpdatingFx(false)
      return
    }

    for (const exp of needsUpdate) {
      const dateStr = exp.payment_date || exp.created_at?.split('T')[0] || todayStr
      try {
        const result = await convertCurrency(exp.amount, exp.currency as Currency, dateStr, 'GBP')
        if (!result) {
          failed++
          continue
        }

        // Skip if rate AND date are unchanged (allows provisional → confirmed updates)
        const newRate = result.rate.rate
        const newDate = result.rate.date
        if (exp.fx_rate && Math.abs(exp.fx_rate - newRate) < 0.000001 && exp.fx_rate_date === newDate) continue

        // Update expense
        const { error: expError } = await supabase
          .from('expenses')
          .update({
            base_currency_amount: result.convertedAmount,
            fx_rate: newRate,
            fx_rate_date: result.rate.date
          })
          .eq('id', exp.id)

        if (expError) {
          console.error(`Failed to update expense ${exp.description}:`, expError)
          failed++
          continue
        }

        // Update splits for this expense
        const { data: splits } = await supabase
          .from('expense_splits')
          .select('id, amount')
          .eq('expense_id', exp.id)

        if (splits) {
          for (const split of splits) {
            await supabase
              .from('expense_splits')
              .update({ base_currency_amount: split.amount * newRate })
              .eq('id', split.id)
          }
        }

        console.log(`Updated FX for "${exp.description}": ${exp.currency} → GBP @ ${newRate} (date: ${result.rate.date})`)
        updated++
      } catch (err) {
        console.error(`FX update error for ${exp.description}:`, err)
        failed++
      }
    }

    // Re-enable real-time and do a single clean refresh
    suppressRealtimeRef.current = false
    setUpdatingFx(false)

    if (updated > 0) {
      await fetchExpenses() // Refresh data and recalculate balances
      alert(`Updated ${updated} expense${updated > 1 ? 's' : ''} with latest FX rates.${failed > 0 ? ` ${failed} failed (API may be unavailable).` : ''}`)
    } else if (failed > 0) {
      alert(`Could not update FX rates — the exchange rate API may be temporarily unavailable. Try again later.`)
    } else {
      alert('All FX rates are already up to date.')
    }
  }

  // Handle real-time claim changes (targeted refetch) — uses ref for current expenses
  const handleClaimChange = useCallback(async (payload: any) => {
    console.log('🔔 Claim change detected:', payload)

    // Extract expense_id from payload (works for INSERT, UPDATE, DELETE)
    const expenseId = payload.new?.expense_id || payload.old?.expense_id
    if (!expenseId) return

    // Check if this expense belongs to current trip (fast O(n) lookup)
    const expense = expensesRef.current.find(e => e.id === expenseId)
    if (!expense) {
      console.log('⏭️  Change not for this trip, ignoring')
      return
    }

    console.log('✅ Change is for our trip, refetching expense:', expense.description)

    // Refetch ONLY this expense's claims (targeted)
    await refetchExpenseClaims(expenseId)
  }, [])

  // Stable ref for handleClaimChange so subscription callback doesn't go stale
  const handleClaimChangeRef = useRef(handleClaimChange)
  handleClaimChangeRef.current = handleClaimChange

  // Refetch claims for a specific expense (targeted refetch)
  const refetchExpenseClaims = async (expenseId: string) => {
    try {
      // Fetch updated claims for this expense only
      const { data: claims, error: claimsError } = await supabase
        .from('expense_item_claims')
        .select('*')
        .eq('expense_id', expenseId)

      if (claimsError) throw claimsError

      // Fetch users for these claims
      const claimUserIds = [...new Set((claims || []).map(c => c.user_id))]
      let claimUsers: any[] = []

      if (claimUserIds.length > 0) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, full_name, avatar_data')
          .in('id', claimUserIds)

        claimUsers = usersData || []
      }

      // Attach user data to claims
      const claimsWithUsers = (claims || []).map(claim => {
        const user = claimUsers.find(u => u.id === claim.user_id)
        return {
          ...claim,
          user: user || { id: claim.user_id, full_name: 'Unknown', avatar_data: null }
        }
      })

      // Update state immutably (React will re-render affected card)
      setExpenses(prevExpenses => {
        const updatedExpenses = prevExpenses.map(exp =>
          exp.id === expenseId
            ? { ...exp, claims: claimsWithUsers }
            : exp
        )
        // Recalculate balances with the updated claims
        calculateBalances(updatedExpenses)
        return updatedExpenses
      })

      console.log('✅ Expense claims updated in state and balances recalculated')
    } catch (error) {
      console.error('❌ Error refetching expense claims:', error)
      // Silently fail - don't disrupt UX
    }
  }

  const getCategoryIcon = (category: string): string => {
    const icons: Record<string, string> = {
      accommodation: '🏠',
      transport: '🚗',
      food: '🍽️',
      activities: '⛷️',
      equipment: '🎿',
      other: '📦'
    }
    return icons[category] || '📦'
  }

  const filteredExpenses = expenses.filter(expense => {
    if (activeFilter === 'all') return true
    return expense.category === activeFilter
  })

  // Count expenses missing FX conversion data
  // Count expenses needing FX update: missing data OR provisional rate with confirmed now available
  const fxUpdateCount = expenses.filter(exp => {
    if (!exp.currency || exp.currency === 'GBP') return false
    // Missing FX data entirely
    if (!exp.base_currency_amount || !exp.fx_rate) return true
    // Provisional rate that can now be updated
    if (isProvisionalRate(exp.payment_date, exp.fx_rate_date) && isConfirmedRateAvailable(exp.payment_date)) return true
    return false
  }).length

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content - Expense List */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header with Add Button */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Expenses</h2>
            <div className="flex items-center gap-2">
              {fxUpdateCount > 0 && (
                <button
                  onClick={handleUpdateFxRates}
                  disabled={updatingFx}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {updatingFx ? (
                    <><Spinner size="sm" /> Updating...</>
                  ) : (
                    <>💱 Update FX ({fxUpdateCount})</>
                  )}
                </button>
              )}
              <Button variant="primary" size="sm" onClick={() => setAddExpenseModalOpen(true)}>
                + Add Expense
              </Button>
            </div>
          </div>

          {/* Actions Required Banner */}
          {(() => {
            if (!user) return null
            const actions: Array<{ message: string; linkUrl?: string; linkLabel: string; expenseId: string }> = []

            expenses.forEach(expense => {
              if (!expense.ai_parsed || !expense.status) return

              // Check if current user needs to claim items
              const userHasClaimed = expense.claims?.some((c: any) => c.user_id === user.id && c.quantity_claimed > 0)
              if (!userHasClaimed && expense.status !== 'allocated' && expense.allocation_link) {
                // Check if user is an expected participant (via option selections or trip participant)
                const isPayer = expense.paid_by === user.id
                if (!isPayer) {
                  actions.push({
                    message: `You haven't claimed items on "${expense.description}"`,
                    linkUrl: `/claim/${expense.allocation_link.code}`,
                    linkLabel: 'Claim now',
                    expenseId: expense.id
                  })
                }
              }

              // Check if expense owner/admin sees unclaimed items
              const isOwner = expense.paid_by === user.id || isAdmin
              if (isOwner && expense.allocation_link && expense.status !== 'allocated') {
                const totalQty = expense.line_items?.reduce((sum: number, item: any) => sum + Number(item.quantity), 0) || 0
                const claimedQty = expense.claims?.reduce((sum: number, claim: any) => sum + Number(claim.quantity_claimed), 0) || 0
                const claimPercent = totalQty > 0 ? Math.round((claimedQty / totalQty) * 100) : 0
                if (claimPercent < 100) {
                  const uniqueClaimants = new Set(expense.claims?.map((c: any) => c.user_id) || [])
                  const numClaimants = uniqueClaimants.size
                  // Don't duplicate if we already have a "claim now" action for this expense
                  if (!actions.some(a => a.expenseId === expense.id)) {
                    actions.push({
                      message: `"${expense.description}" is ${claimPercent}% claimed — ${numClaimants} ${numClaimants === 1 ? 'person has' : 'people have'} claimed`,
                      linkUrl: `/claim/${expense.allocation_link.code}`,
                      linkLabel: 'View claims',
                      expenseId: expense.id
                    })
                  }
                }
              }
            })

            if (actions.length === 0) return null

            return (
              <div className="space-y-2">
                {actions.map((action, i) => (
                  <div key={i} className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-amber-900">{action.message}</p>
                    {action.linkUrl && (
                      <Link
                        to={action.linkUrl}
                        className="text-sm font-medium text-amber-700 hover:text-amber-900 whitespace-nowrap underline"
                      >
                        {action.linkLabel} →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

        {/* Category Filters */}
        <div className="flex flex-wrap gap-2">
          <FilterButton
            active={activeFilter === 'all'}
            onClick={() => setActiveFilter('all')}
          >
            All ({expenses.length})
          </FilterButton>
          {['accommodation', 'transport', 'food', 'activities', 'equipment', 'other'].map(category => {
            const count = expenses.filter(e => e.category === category).length
            if (count === 0) return null
            return (
              <FilterButton
                key={category}
                active={activeFilter === category}
                onClick={() => setActiveFilter(category)}
              >
                {getCategoryIcon(category)} {category.charAt(0).toUpperCase() + category.slice(1)} ({count})
              </FilterButton>
            )
          })}
        </div>

        {/* Expense Cards */}
        {filteredExpenses.length === 0 ? (
          <Card>
            <Card.Content className="py-12">
              <EmptyState
                icon="💰"
                title="No expenses yet"
                description="Start tracking trip expenses by adding your first expense."
                action={
                  <Button variant="primary" onClick={() => setAddExpenseModalOpen(true)}>
                    + Add Expense
                  </Button>
                }
              />
            </Card.Content>
          </Card>
        ) : (
          <div className="space-y-2">
            {filteredExpenses.map(expense => (
              <ExpenseCard
                key={expense.id}
                expense={expense}
                currentUserId={user?.id || ''}
                isAdmin={isAdmin}
                isOrganizer={isOrganizer}
                participants={participants}
                onDelete={fetchExpenses}
                onEdit={(exp) => setEditingExpense(exp)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sidebar - Balance Summary */}
      <div className="lg:col-span-1">
        <BalanceSummary
          key={expenses.length} // Force re-render when expenses change
          balances={balances}
          currentUserId={user?.id || ''}
          isAdmin={isAdmin}
          tripId={tripId}
          onOpenSettlementHistory={() => setSettlementHistoryModalOpen(true)}
          onOpenRecordPayment={() => setRecordSettlementModalOpen(true)}
        />
      </div>
    </div>

    {/* Add Expense Modal */}
    <AddExpenseModal
      isOpen={addExpenseModalOpen || !!editingExpense}
      onClose={() => {
        setAddExpenseModalOpen(false)
        setEditingExpense(null)
      }}
      tripId={tripId}
      participants={participants}
      onSuccess={fetchExpenses}
      editingExpense={editingExpense}
    />

    {/* Record Settlement Modal */}
    <RecordSettlementModal
      isOpen={recordSettlementModalOpen}
      onClose={() => setRecordSettlementModalOpen(false)}
      tripId={tripId}
      participants={participants}
      currentUserId={user?.id || ''}
      onSuccess={fetchExpenses}
    />

    {/* Settlement History Modal */}
    <SettlementHistoryModal
      isOpen={settlementHistoryModalOpen}
      onClose={() => setSettlementHistoryModalOpen(false)}
      tripId={tripId}
    />
  </>
  )
}

// Filter Button Component
function FilterButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
        active
          ? 'bg-sky-100 text-sky-700 border-2 border-sky-500'
          : 'bg-gray-100 text-gray-700 border-2 border-transparent hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  )
}

// Expense Card Component
function ExpenseCard({
  expense,
  currentUserId,
  isAdmin,
  isOrganizer,
  participants,
  onDelete,
  onEdit
}: {
  expense: ExpenseWithDetails
  currentUserId: string
  isAdmin: boolean
  isOrganizer: boolean
  participants: any[]
  onDelete: () => void
  onEdit: (expense: ExpenseWithDetails) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Check if this is an itemized expense
  const isItemized = expense.ai_parsed && expense.status && expense.line_items

  // Calculate itemized expense stats
  let itemizedStats = null
  if (isItemized) {
    const lineItems = expense.line_items || []
    const claims = expense.claims || []

    const totalQuantity = lineItems.reduce((sum, item) => sum + Number(item.quantity), 0)
    const claimedQuantity = claims.reduce((sum, claim) => sum + Number(claim.quantity_claimed), 0)
    const percentClaimed = totalQuantity > 0 ? (claimedQuantity / totalQuantity) * 100 : 0

    const userClaims = claims.filter((c: any) => c.user_id === currentUserId)
    // Convert claim amounts to GBP if fx_rate available, otherwise keep in original currency
    const hasFxRate = !!expense.fx_rate
    const fxRate = expense.fx_rate || 1
    const userTotal = userClaims.reduce((sum: number, claim: any) => sum + Number(claim.amount_owed) * fxRate, 0)

    itemizedStats = {
      totalItems: lineItems.length,
      percentClaimed,
      fullyAllocated: percentClaimed >= 99.9,
      userHasClaimed: userClaims.length > 0,
      userTotal,
      userTotalCurrency: (hasFxRate ? 'GBP' : (expense.currency || 'GBP')) as Currency,
      linkCode: expense.allocation_link?.code
    }
  }

  // Debug logging
  console.log('ExpenseCard render:', {
    description: expense.description,
    receipt_url: expense.receipt_url,
    expanded
  })

  const handleDelete = async () => {
    const confirmMessage = `⚠️ Delete expense "${expense.description}"?\n\nThis will permanently delete:\n- The expense (${formatCurrency(expense.amount, expense.currency as Currency)})\n- ${expense.splits.length} split ${expense.splits.length === 1 ? 'entry' : 'entries'}\n\nThis action CANNOT be undone!`

    if (!window.confirm(confirmMessage)) {
      return
    }

    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', expense.id)

    if (error) {
      alert(`Error deleting expense: ${error.message}`)
    } else {
      onDelete()
    }
  }

  const getCategoryIcon = (category: string): string => {
    const icons: Record<string, string> = {
      accommodation: '🏠',
      transport: '🚗',
      food: '🍽️',
      activities: '⛷️',
      equipment: '🎿',
      other: '📦'
    }
    return icons[category] || '📦'
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
  }

  const currentUserSplit = expense.splits.find(s => s.user_id === currentUserId)
  const isPayer = expense.paid_by === currentUserId

  // Determine border color
  let borderColor = ''
  if (isItemized && itemizedStats) {
    if (itemizedStats.fullyAllocated) {
      // Fully claimed - color based on user involvement
      if (isPayer) {
        borderColor = 'border-l-4 border-l-green-500' // User paid
      } else if (itemizedStats.userHasClaimed) {
        borderColor = 'border-l-4 border-l-orange-500' // User owes money
      } else {
        borderColor = 'border-l-4 border-l-gray-400' // User not involved
      }
    } else {
      // Partially claimed
      borderColor = 'border-l-4 border-l-purple-500'
    }
  } else {
    // Regular expense (non-itemized)
    if (isPayer) {
      borderColor = 'border-l-4 border-l-green-500'
    } else if (currentUserSplit) {
      borderColor = 'border-l-4 border-l-orange-500'
    }
  }

  return (
    <Card
      noPadding
      className={`cursor-pointer transition-all hover:shadow-md ${borderColor}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="py-1.5 px-3">
        {/* Header Row */}
        <div className="flex items-center justify-between gap-2 min-h-[32px]">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {/* Category Icon */}
            <div className="flex-shrink-0 text-lg leading-none flex items-center">
              {getCategoryIcon(expense.category)}
            </div>

            {/* Title and Details */}
            <div className="flex-1 min-w-0 py-0.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-sm text-gray-900 truncate leading-none -mb-px">
                  {expense.description}
                </h3>
                {(isAdmin || isOrganizer || expense.paid_by === currentUserId) && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(expense)
                      }}
                      className="text-xs text-sky-600 hover:text-sky-700 bg-sky-50 hover:bg-sky-100 px-2 py-0.5 rounded transition-colors leading-none font-medium"
                      title="Edit expense"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete()
                      }}
                      className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 px-1.5 py-0.5 rounded transition-colors leading-none"
                      title="Delete expense"
                    >
                      Del
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 text-[11px] text-gray-500 leading-none">
                <span className="truncate">{expense.payer.full_name || expense.payer.email}</span>
                <span>•</span>
                <span className="whitespace-nowrap">{formatDate(expense.payment_date)}</span>
                {isItemized && itemizedStats ? (
                  <>
                    <span>•</span>
                    <span
                      className={`font-medium whitespace-nowrap ${
                        itemizedStats.fullyAllocated ? 'text-green-600' : 'text-purple-600'
                      }`}
                    >
                      {itemizedStats.fullyAllocated
                        ? '✓ Fully Claimed'
                        : `${Math.round(itemizedStats.percentClaimed)}% Claimed`}
                    </span>
                    {itemizedStats.userHasClaimed && (
                      <>
                        <span>•</span>
                        <span className="font-medium whitespace-nowrap text-orange-600">
                          You: {formatCurrency(itemizedStats.userTotal, itemizedStats.userTotalCurrency)}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {isPayer && (
                      <>
                        <span>•</span>
                        <span className="font-medium whitespace-nowrap text-green-600">
                          ✓ Paid
                        </span>
                      </>
                    )}
                    {currentUserSplit && (
                      <>
                        <span>•</span>
                        <span className="font-medium whitespace-nowrap text-orange-600">
                          Owe {currentUserSplit.base_currency_amount
                            ? formatCurrency(currentUserSplit.base_currency_amount, 'GBP')
                            : formatCurrency(currentUserSplit.amount, (expense.currency as Currency) || 'GBP')
                          }
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Amount */}
          <div className="flex-shrink-0 text-right py-0.5">
            <div className="font-bold text-sm text-gray-900 leading-none -mb-px">
              {formatCurrency(expense.amount, expense.currency as Currency)}
            </div>
            {expense.base_currency_amount && expense.currency !== 'GBP' && (
              <div className="text-[10px] text-gray-500 leading-none">
                {formatCurrency(expense.base_currency_amount, 'GBP')}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-gray-200">
          {isItemized && itemizedStats ? (
            /* Itemized Expense Details */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-700">Itemized Expense</h4>
                {itemizedStats.linkCode && (
                  <Link
                    to={`/claim/${itemizedStats.linkCode}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded hover:bg-purple-200 transition-colors"
                  >
                    {itemizedStats.userHasClaimed ? '✏️ Edit Claims' : '📋 Claim Items'}
                  </Link>
                )}
              </div>

              {/* Progress Bar */}
              <div>
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>{expense.line_items?.length} items</span>
                  <span>{Math.round(itemizedStats.percentClaimed)}% claimed</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      itemizedStats.fullyAllocated ? 'bg-green-500' : 'bg-purple-500'
                    }`}
                    style={{ width: `${Math.min(itemizedStats.percentClaimed, 100)}%` }}
                  />
                </div>
              </div>

              {/* Outstanding Claimants */}
              {expense.expected_participants && expense.expected_participants.length > 0 && !itemizedStats.fullyAllocated && (() => {
                const claimedUserIds = new Set(expense.claims?.filter((c: any) => c.quantity_claimed > 0).map((c: any) => c.user_id) || [])
                const missingUsers = expense.expected_participants!
                  .filter(uid => !claimedUserIds.has(uid))
                  .map(uid => {
                    const p = participants.find((pp: any) => pp.user_id === uid)
                    return p?.user?.full_name || p?.user?.email || 'Unknown'
                  })
                if (missingUsers.length === 0) return null
                return (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-2">
                    <p className="text-xs font-medium text-amber-900">
                      Haven't claimed yet: {missingUsers.join(', ')}
                    </p>
                  </div>
                )
              })()}

              {/* Claims Summary */}
              {expense.claims && expense.claims.length > 0 && (
                <div>
                  <h5 className="text-xs font-medium text-gray-600 mb-2">Who Claimed:</h5>
                  <div className="space-y-1">
                    {Object.entries(
                      expense.claims.reduce((acc: any, claim: any) => {
                        if (!acc[claim.user_id]) {
                          acc[claim.user_id] = {
                            user: claim.user,
                            total: 0,
                            items: 0
                          }
                        }
                        // Convert claim amount to GBP if fx_rate available, otherwise keep in original currency
                        const fxRate = expense.fx_rate || 1
                        acc[claim.user_id].total += Number(claim.amount_owed) * fxRate
                        acc[claim.user_id].currency = expense.fx_rate ? 'GBP' : (expense.currency || 'GBP')
                        acc[claim.user_id].items += 1
                        return acc
                      }, {})
                    ).map(([userId, data]: [string, any]) => (
                      <div key={userId} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-6 h-6 rounded-full flex flex-col items-center justify-center text-xs"
                            style={{
                              backgroundColor: data.user?.avatar_data?.bgColor || '#0ea5e9',
                            }}
                          >
                            {data.user?.avatar_data?.accessory && (
                              <span className="text-[8px] -mb-0.5">
                                {data.user.avatar_data.accessory}
                              </span>
                            )}
                            <span className="text-xs">
                              {data.user?.avatar_data?.emoji || '😊'}
                            </span>
                          </div>
                          <span className="text-gray-900">
                            {data.user?.full_name || 'Unknown'} ({data.items} {data.items === 1 ? 'item' : 'items'})
                          </span>
                        </div>
                        <span className="font-medium text-gray-700">
                          {formatCurrency(data.total, data.currency || 'GBP')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {itemizedStats.linkCode && (
                <div className="text-xs bg-gray-50 p-2 rounded">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-700">Share Link:</span>
                      <div className="mt-1 font-mono text-sky-600 break-all">
                        {`${window.location.origin}/trips/claim/${itemizedStats.linkCode}`}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const link = `${window.location.origin}/trips/claim/${itemizedStats.linkCode}`
                        navigator.clipboard.writeText(link)
                        setCopiedLink(true)
                        setTimeout(() => setCopiedLink(false), 2000)
                      }}
                      className="flex-shrink-0 px-2 py-1 text-xs bg-sky-100 text-sky-700 rounded hover:bg-sky-200 transition-colors"
                    >
                      {copiedLink ? '✓ Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Regular Expense Details */
            <>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Split Details:</h4>
          <div className="space-y-1">
            {expense.splits.map(split => (
                <div key={split.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
                      style={{
                        backgroundColor: (split.user.avatar_data as any)?.bgColor || '#0ea5e9',
                      }}
                    >
                      <span className="relative">
                        {(split.user.avatar_data as any)?.emoji || '😊'}
                      </span>
                    </div>
                    <span className="text-gray-900">
                      {split.user.full_name || split.user.email}
                    </span>
                  </div>
                  <span className="font-medium text-gray-700">
                    {formatCurrency(
                      split.base_currency_amount || split.amount,
                      split.base_currency_amount ? 'GBP' : ((expense.currency as Currency) || 'GBP')
                    )}
                  </span>
                </div>
              ))}
            </div>

            {expense.location && (
              <div className="mt-3 text-sm text-gray-600">
                📍 {expense.location}
              </div>
            )}

            {/* Receipt */}
            {expense.receipt_url && <ReceiptDisplay receiptPath={expense.receipt_url} />}
            </>
          )}

          {/* Receipt for all expense types */}
          {isItemized && expense.receipt_url && (
            <div className="mt-3">
              <ReceiptDisplay receiptPath={expense.receipt_url} />
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// Balance Summary Component
function BalanceSummary({
  balances,
  currentUserId,
  isAdmin,
  tripId,
  onOpenSettlementHistory,
  onOpenRecordPayment
}: {
  balances: BalanceData[]
  currentUserId: string
  isAdmin: boolean
  tripId: string
  onOpenSettlementHistory: () => void
  onOpenRecordPayment: () => void
}) {
  const [snapshot, setSnapshot] = useState<any>(null)
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null)
  const [savingSnapshot, setSavingSnapshot] = useState(false)

  useEffect(() => {
    const fetchSnapshot = async () => {
      const { data } = await supabase
        .from('trips')
        .select('settlement_snapshot, settlement_snapshot_at')
        .eq('id', tripId)
        .single()
      if (data) {
        setSnapshot(data.settlement_snapshot)
        setSnapshotAt(data.settlement_snapshot_at)
      }
    }
    fetchSnapshot()
  }, [tripId])

  const handleFinalizeSettlements = async () => {
    if (!window.confirm('This will freeze the settlement arrangement. The recommended payments will no longer change as new expenses or settlements are added. Proceed?')) return

    setSavingSnapshot(true)
    const people: Person[] = balances.map(b => ({
      userId: b.userId,
      name: b.user.full_name || b.user.email || 'Unknown',
      netBalance: b.netBalance
    }))
    const allTransactions = minimizeTransactions(people)

    const snapshotData = {
      transactions: allTransactions.map(t => ({
        from: t.from,
        to: t.to,
        fromName: t.fromName,
        toName: t.toName,
        amount: t.amount,
        settled: false
      })),
      balances: people.map(p => ({ userId: p.userId, name: p.name, netBalance: p.netBalance })),
      created_at: new Date().toISOString()
    }

    const { error } = await supabase
      .from('trips')
      .update({
        settlement_snapshot: snapshotData,
        settlement_snapshot_at: new Date().toISOString(),
        settlement_snapshot_by: currentUserId
      })
      .eq('id', tripId)

    if (!error) {
      setSnapshot(snapshotData)
      setSnapshotAt(new Date().toISOString())
    } else {
      alert('Failed to finalize settlements: ' + error.message)
    }
    setSavingSnapshot(false)
  }

  const handleToggleSettled = async (index: number) => {
    if (!snapshot) return
    const updated = { ...snapshot }
    updated.transactions = [...updated.transactions]
    updated.transactions[index] = { ...updated.transactions[index], settled: !updated.transactions[index].settled }

    const { error } = await supabase
      .from('trips')
      .update({ settlement_snapshot: updated })
      .eq('id', tripId)

    if (!error) {
      setSnapshot(updated)
    }
  }
  const currentUserBalance = balances.find(b => b.userId === currentUserId)

  if (!currentUserBalance) {
    return null
  }

  const isOwed = currentUserBalance.netBalance > 0
  const isOwing = currentUserBalance.netBalance < 0
  const isBalanced = Math.abs(currentUserBalance.netBalance) < 0.01

  return (
    <div className="sticky top-4">
      <Card>
        <Card.Header>
          <Card.Title>Your Balance</Card.Title>
          <Card.Description>Track what you're owed and owing</Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="space-y-3">
            {/* Summary Items */}
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">You paid:</span>
                <span className="font-medium text-gray-900">
                  {formatCurrency(currentUserBalance.totalPaid, 'GBP')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">You owe:</span>
                <span className="font-medium text-gray-900">
                  {formatCurrency(currentUserBalance.totalOwed, 'GBP')}
                </span>
              </div>
              {currentUserBalance.settlementsReceived > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Received:</span>
                  <span className="font-medium text-green-600">
                    +{formatCurrency(currentUserBalance.settlementsReceived, 'GBP')}
                  </span>
                </div>
              )}
              {currentUserBalance.settlementsPaid > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Paid back:</span>
                  <span className="font-medium text-red-600">
                    -{formatCurrency(currentUserBalance.settlementsPaid, 'GBP')}
                  </span>
                </div>
              )}
            </div>

            {/* Net Balance */}
            <div className="pt-3 border-t-2 border-gray-300">
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-900">Net balance:</span>
                <span
                  className={`font-bold text-lg ${
                    isBalanced
                      ? 'text-gray-500'
                      : isOwed
                      ? 'text-green-600'
                      : 'text-red-600'
                  }`}
                >
                  {formatCurrency(Math.abs(currentUserBalance.netBalance), 'GBP')}
                  {isOwed && ' ✓'}
                  {isOwing && ' ⚠️'}
                </span>
              </div>
              {isBalanced && (
                <div className="text-center text-sm text-gray-500 mt-2">
                  All settled up!
                </div>
              )}
              {isOwed && (
                <div className="text-center text-sm text-green-600 mt-2">
                  You are owed this amount
                </div>
              )}
              {isOwing && (
                <div className="text-center text-sm text-red-600 mt-2">
                  You owe this amount
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="space-y-2 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={onOpenSettlementHistory}
              >
                View Settlement History
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="w-full"
                onClick={onOpenRecordPayment}
              >
                Record Payment
              </Button>
            </div>
          </div>
        </Card.Content>
      </Card>

      {/* Optimized Settlement Summary */}
      <Card className="mt-4">
        <Card.Header>
          <Card.Title>Optimized Settlements</Card.Title>
          <Card.Description>
            {snapshot ? `Finalized on ${new Date(snapshotAt!).toLocaleDateString('en-GB')}` : 'Minimum transactions to settle all debts'}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {snapshot ? (
            /* Frozen snapshot view */
            <div className="space-y-4">
              {(() => {
                const txns = snapshot.transactions || []
                const settledCount = txns.filter((t: any) => t.settled).length
                const totalCount = txns.length

                if (totalCount === 0) {
                  return (
                    <div className="text-center py-4 text-sm text-gray-500">
                      All settled up! 🎉
                    </div>
                  )
                }

                return (
                  <>
                    {/* Progress */}
                    <div className="text-sm text-gray-600 text-center">
                      {settledCount}/{totalCount} settlements completed
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-green-500 h-2 rounded-full transition-all"
                        style={{ width: `${(settledCount / totalCount) * 100}%` }}
                      />
                    </div>

                    {/* Transaction list */}
                    <div className="space-y-2">
                      {txns.map((txn: any, idx: number) => {
                        const isInvolved = txn.from === currentUserId || txn.to === currentUserId
                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-2 p-2 rounded-lg border ${
                              txn.settled
                                ? 'bg-green-50 border-green-200'
                                : isInvolved
                                ? 'bg-sky-50 border-sky-200'
                                : 'bg-gray-50 border-gray-200'
                            }`}
                          >
                            <button
                              onClick={() => handleToggleSettled(idx)}
                              className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center text-xs ${
                                txn.settled
                                  ? 'bg-green-500 border-green-500 text-white'
                                  : 'border-gray-300 hover:border-gray-400'
                              }`}
                            >
                              {txn.settled && '✓'}
                            </button>
                            <div className={`flex-1 flex justify-between items-center text-sm ${txn.settled ? 'line-through opacity-60' : ''}`}>
                              <span className="text-gray-900">
                                <strong>{txn.fromName}</strong>
                                <span className="text-gray-500 mx-1">→</span>
                                <strong>{txn.toName}</strong>
                              </span>
                              <span className={`font-bold ${txn.settled ? 'text-green-600' : 'text-gray-600'}`}>
                                {formatCurrency(txn.amount, 'GBP')}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Admin: Re-finalize button */}
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={handleFinalizeSettlements}
                        disabled={savingSnapshot}
                      >
                        {savingSnapshot ? 'Re-finalizing...' : 'Re-finalize Settlements'}
                      </Button>
                    )}
                  </>
                )
              })()}
            </div>
          ) : (
            /* Live calculation view */
            (() => {
              const people: Person[] = balances.map(b => ({
                userId: b.userId,
                name: b.user.full_name || b.user.email || 'Unknown',
                netBalance: b.netBalance
              }))

              const allTransactions = minimizeTransactions(people)
              const { toPay, toReceive } = getUserTransactions(allTransactions, currentUserId)
              const allSettled = people.every(p => Math.abs(p.netBalance) < 0.01)

              if (allSettled || allTransactions.length === 0) {
                return (
                  <div className="text-center py-4 text-sm text-gray-500">
                    All settled up! 🎉
                  </div>
                )
              }

              return (
                <div className="space-y-4">
                  {toPay.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-700 mb-2 uppercase">You Pay:</h4>
                      <div className="space-y-2">
                        {toPay.map((transaction, idx) => (
                          <div key={idx} className="flex justify-between items-center p-2 bg-red-50 rounded-lg border border-red-200">
                            <span className="text-sm text-gray-900">
                              Pay <strong>{transaction.toName}</strong>
                            </span>
                            <span className="font-bold text-red-600">
                              {formatCurrency(transaction.amount, 'GBP')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {toReceive.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-700 mb-2 uppercase">You Receive:</h4>
                      <div className="space-y-2">
                        {toReceive.map((transaction, idx) => (
                          <div key={idx} className="flex justify-between items-center p-2 bg-green-50 rounded-lg border border-green-200">
                            <span className="text-sm text-gray-900">
                              <strong>{transaction.fromName}</strong> pays you
                            </span>
                            <span className="font-bold text-green-600">
                              {formatCurrency(transaction.amount, 'GBP')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="pt-3 border-t border-gray-200">
                    <div className="text-xs text-gray-600">
                      💡 This shows the <strong>minimum {allTransactions.length} transaction{allTransactions.length !== 1 ? 's' : ''}</strong> needed to settle all debts in the group.
                    </div>
                  </div>

                  {/* Admin: Show all group transactions + Finalize button */}
                  {isAdmin && allTransactions.length > 0 && (
                    <div className="pt-4 mt-4 border-t border-gray-300">
                      <h4 className="text-xs font-semibold text-gray-700 mb-3 uppercase flex items-center gap-1">
                        <span>👑</span> All Group Settlements
                      </h4>
                      <div className="space-y-2">
                        {allTransactions.map((transaction, idx) => {
                          const isCurrentUserInvolved =
                            transaction.from === currentUserId ||
                            transaction.to === currentUserId

                          return (
                            <div
                              key={idx}
                              className={`flex justify-between items-center p-2 rounded-lg border ${
                                isCurrentUserInvolved
                                  ? 'bg-sky-50 border-sky-200'
                                  : 'bg-gray-50 border-gray-200'
                              }`}
                            >
                              <span className="text-sm text-gray-900">
                                <strong>{transaction.fromName}</strong>
                                <span className="text-gray-500 mx-1">→</span>
                                <strong>{transaction.toName}</strong>
                              </span>
                              <span className={`font-bold ${
                                isCurrentUserInvolved ? 'text-sky-600' : 'text-gray-600'
                              }`}>
                                {formatCurrency(transaction.amount, 'GBP')}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        className="w-full mt-3"
                        onClick={handleFinalizeSettlements}
                        disabled={savingSnapshot}
                      >
                        {savingSnapshot ? 'Finalizing...' : 'Finalize Settlements'}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })()
          )}
        </Card.Content>
      </Card>
    </div>
  )
}

// Receipt Display Component (handles async URL fetching)
function ReceiptDisplay({ receiptPath }: { receiptPath: string }) {
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchReceiptUrl = async () => {
      try {
        setLoading(true)
        const url = await getReceiptUrl(receiptPath)
        setReceiptUrl(url)
        setError(null)
      } catch (err: any) {
        console.error('Error fetching receipt URL:', err)
        setError(err.message || 'Failed to load receipt')
      } finally {
        setLoading(false)
      }
    }

    fetchReceiptUrl()
  }, [receiptPath])

  if (loading) {
    return (
      <div className="mt-3">
        <h4 className="text-sm font-medium text-gray-700 mb-2">Receipt:</h4>
        <div className="flex items-center justify-center h-40 bg-gray-100 rounded-lg">
          <p className="text-sm text-gray-500">Loading receipt...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mt-3">
        <h4 className="text-sm font-medium text-gray-700 mb-2">Receipt:</h4>
        <div className="flex items-center justify-center h-40 bg-red-50 rounded-lg border border-red-200">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3">
      <h4 className="text-sm font-medium text-gray-700 mb-2">Receipt:</h4>
      <a
        href={receiptUrl || '#'}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <img
          src={receiptUrl || ''}
          alt="Receipt"
          className="max-w-full h-auto rounded-lg border border-gray-300 hover:border-sky-500 transition-colors cursor-pointer"
          style={{ maxHeight: '300px' }}
          onError={(e) => {
            console.error('Failed to load receipt image:', receiptPath)
            e.currentTarget.style.display = 'none'
            const errorMsg = document.createElement('p')
            errorMsg.className = 'text-red-600 text-sm'
            errorMsg.textContent = 'Failed to load receipt image'
            e.currentTarget.parentElement?.appendChild(errorMsg)
          }}
        />
      </a>
      <p className="mt-1 text-xs text-gray-500">
        Click to view full size
      </p>
    </div>
  )
}

