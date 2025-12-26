import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Card, Spinner, EmptyState } from './ui'
import { AddExpenseModal } from './AddExpenseModal'
import { RecordSettlementModal } from './RecordSettlementModal'
import { SettlementHistoryModal } from './SettlementHistoryModal'
import { formatCurrency, type Currency } from '../lib/currency'
import { minimizeTransactions, getUserTransactions, type Person } from '../lib/debtMinimization'
import { getReceiptUrl } from '../lib/receiptUpload'
import { Database } from '../types/database.types'

type Expense = Database['public']['Tables']['expenses']['Row']
type ExpenseSplit = Database['public']['Tables']['expense_splits']['Row']
type User = Database['public']['Tables']['users']['Row']
type Settlement = Database['public']['Tables']['settlements']['Row']

interface ExpenseWithDetails extends Expense {
  payer: User
  splits: Array<ExpenseSplit & { user: User }>
  line_items?: any[]
  claims?: any[]
  allocation_link?: any
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

  // Real-time subscription for expense updates
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
        handleClaimChange
      )
      .subscribe()

    console.log('✅ Real-time subscription active for expense claims')

    return () => {
      console.log('🔴 Closing real-time subscription')
      supabase.removeChannel(expenseChannel)
    }
  }, [tripId, expenses])

  const fetchExpenses = async () => {
    setLoading(true)

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

    console.log('Fetched expenses with receipts:', expensesData?.map(e => ({
      id: e.id,
      description: e.description,
      receipt_url: e.receipt_url,
      has_receipt: !!e.receipt_url
    })))

    // For itemized expenses, load additional data
    const expensesWithItemizedData = await Promise.all(
      (expensesData || []).map(async (expense: any) => {
        if (expense.ai_parsed && expense.status) {
          // This is an itemized expense, load line items, claims, and allocation link
          const [lineItemsRes, claimsRes, linkRes] = await Promise.all([
            supabase
              .from('expense_line_items')
              .select('*')
              .eq('expense_id', expense.id)
              .order('line_number'),
            supabase
              .from('expense_item_claims')
              .select(`
                *,
                user:user_id (id, full_name, avatar_data)
              `)
              .eq('expense_id', expense.id),
            supabase
              .from('expense_allocation_links')
              .select('*')
              .eq('expense_id', expense.id)
              .single()
          ])

          return {
            ...expense,
            line_items: lineItemsRes.data || [],
            claims: claimsRes.data || [],
            allocation_link: linkRes.data
          }
        }
        return expense
      })
    )

    setExpenses(expensesWithItemizedData as any)

    // Calculate balances - pass expensesWithItemizedData to include claims
    await calculateBalances(expensesWithItemizedData as any)

    setLoading(false)
  }

  const calculateBalances = async (expensesData: ExpenseWithDetails[]) => {
    console.log('Calculating balances for', expensesData.length, 'expenses')

    // Fetch settlements
    const { data: settlementsData } = await supabase
      .from('settlements')
      .select('*')
      .eq('trip_id', tripId)

    const settlements = (settlementsData || []) as Settlement[]

    console.log('Found', settlements.length, 'settlements')

    // Calculate for each participant
    const balanceMap = new Map<string, BalanceData>()

    participants.forEach(participant => {
      const userId = participant.user_id
      const participantUser = participant.user

      // Total paid by this user
      const totalPaid = expensesData
        .filter(exp => exp.paid_by === userId)
        .reduce((sum, exp) => sum + (exp.base_currency_amount || exp.amount), 0)

      // Total owed by this user from regular expense splits
      const totalOwedFromSplits = expensesData
        .flatMap(exp => exp.splits || [])
        .filter(split => split.user_id === userId)
        .reduce((sum, split) => sum + (split.base_currency_amount || split.amount), 0)

      // Total owed by this user from itemized expense claims (converted to GBP)
      const totalOwedFromClaims = expensesData
        .filter(exp => exp.ai_parsed && exp.claims) // Only itemized expenses with claims
        .reduce((sum: number, exp: any) => {
          const userClaims = (exp.claims || []).filter((claim: any) => claim.user_id === userId)
          const claimTotal = userClaims.reduce((claimSum: number, claim: any) => {
            const amountInOriginalCurrency = claim.amount_owed || 0
            // Convert to GBP using expense's fx_rate (if available, otherwise assume 1:1)
            const fxRate = exp.fx_rate || 1
            return claimSum + (amountInOriginalCurrency * fxRate)
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

  // Handle real-time claim changes (targeted refetch)
  const handleClaimChange = async (payload: any) => {
    console.log('🔔 Claim change detected:', payload)

    // Extract expense_id from payload (works for INSERT, UPDATE, DELETE)
    const expenseId = payload.new?.expense_id || payload.old?.expense_id
    if (!expenseId) return

    // Check if this expense belongs to current trip (fast O(n) lookup)
    const expense = expenses.find(e => e.id === expenseId)
    if (!expense) {
      console.log('⏭️  Change not for this trip, ignoring')
      return
    }

    console.log('✅ Change is for our trip, refetching expense:', expense.description)

    // Refetch ONLY this expense's claims (targeted)
    await refetchExpenseClaims(expenseId)
  }

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
            <Button variant="primary" size="sm" onClick={() => setAddExpenseModalOpen(true)}>
              + Add Expense
            </Button>
          </div>

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
                onDelete={fetchExpenses}
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
          onOpenSettlementHistory={() => setSettlementHistoryModalOpen(true)}
          onOpenRecordPayment={() => setRecordSettlementModalOpen(true)}
        />
      </div>
    </div>

    {/* Add Expense Modal */}
    <AddExpenseModal
      isOpen={addExpenseModalOpen}
      onClose={() => setAddExpenseModalOpen(false)}
      tripId={tripId}
      participants={participants}
      onSuccess={fetchExpenses}
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
  onDelete
}: {
  expense: ExpenseWithDetails
  currentUserId: string
  isAdmin: boolean
  onDelete: () => void
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
    const userTotal = userClaims.reduce((sum: number, claim: any) => sum + Number(claim.amount_owed), 0)

    itemizedStats = {
      totalItems: lineItems.length,
      percentClaimed,
      fullyAllocated: percentClaimed >= 99.9,
      userHasClaimed: userClaims.length > 0,
      userTotal,
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
                {(isAdmin || expense.paid_by === currentUserId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete()
                    }}
                    className="text-[10px] text-red-600 hover:text-red-700 hover:bg-red-50 px-1 py-px rounded transition-colors flex-shrink-0 leading-none"
                    title="Delete expense"
                  >
                    Del
                  </button>
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
                          You: {formatCurrency(itemizedStats.userTotal, 'GBP')}
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
                          Owe {formatCurrency(currentUserSplit.base_currency_amount || currentUserSplit.amount, 'GBP')}
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
                        acc[claim.user_id].total += Number(claim.amount_owed)
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
                          {formatCurrency(data.total, 'GBP')}
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
                    {formatCurrency(split.base_currency_amount || split.amount, 'GBP')}
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
  onOpenSettlementHistory,
  onOpenRecordPayment
}: {
  balances: BalanceData[]
  currentUserId: string
  onOpenSettlementHistory: () => void
  onOpenRecordPayment: () => void
}) {
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
          <Card.Description>Minimum transactions to settle all debts</Card.Description>
        </Card.Header>
        <Card.Content>
          {(() => {
            // Convert balances to Person format
            const people: Person[] = balances.map(b => ({
              userId: b.userId,
              name: b.user.full_name || b.user.email || 'Unknown',
              netBalance: b.netBalance
            }))

            // Debug logging
            console.log('People with balances:', people.map(p => ({ name: p.name, balance: p.netBalance })))

            // Calculate minimized transactions
            const allTransactions = minimizeTransactions(people)

            console.log('Minimized transactions:', allTransactions)

            const { toPay, toReceive } = getUserTransactions(allTransactions, currentUserId)

            // Check if everyone is settled (all balances near zero)
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
                {/* What you need to pay */}
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

                {/* What you will receive */}
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

                {/* Summary note */}
                <div className="pt-3 border-t border-gray-200">
                  <div className="text-xs text-gray-600">
                    💡 This shows the <strong>minimum {allTransactions.length} transaction{allTransactions.length !== 1 ? 's' : ''}</strong> needed to settle all debts in the group.
                  </div>
                </div>
              </div>
            )
          })()}
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

