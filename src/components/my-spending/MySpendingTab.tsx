import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { Spinner, EmptyState, Card } from '../ui'
import { Database } from '../../types/database.types'
import { Trip, TripParticipant, User } from '../../types'
import { PersonalOverview } from './PersonalOverview'
import { CategoryBreakdown } from './CategoryBreakdown'
import { DayByDayBreakdown } from './DayByDayBreakdown'
import { ExpenseAuditTrail } from './ExpenseAuditTrail'
import { SettlementAudit } from './SettlementAudit'

type Expense = Database['public']['Tables']['expenses']['Row']
type ExpenseSplit = Database['public']['Tables']['expense_splits']['Row']
type Settlement = Database['public']['Tables']['settlements']['Row']

export interface SpendingExpense extends Expense {
  payer: User
  splits: Array<ExpenseSplit & { user: User }>
  line_items?: any[]
  claims?: any[]
}

export interface BalanceData {
  userId: string
  user: User
  totalPaid: number
  totalOwed: number
  settlementsReceived: number
  settlementsPaid: number
  netBalance: number
}

interface ParticipantWithUser extends TripParticipant {
  user: User
}

export function MySpendingTab({ trip, participants }: { trip: Trip; participants: ParticipantWithUser[] }) {
  const { user } = useAuth()
  const [expenses, setExpenses] = useState<SpendingExpense[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [balances, setBalances] = useState<BalanceData[]>([])
  const [loading, setLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)

  useEffect(() => {
    fetchData()
  }, [trip.id])

  const fetchData = async () => {
    setLoading(true)

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
      .eq('trip_id', trip.id)
      .order('payment_date', { ascending: false })

    if (error) {
      console.error('Error fetching expenses:', error)
      setLoading(false)
      return
    }

    // Batch-fetch itemized data + settlements in parallel
    const itemizedExpenseIds = (expensesData || [])
      .filter((e: any) => e.ai_parsed && e.status)
      .map((e: any) => e.id as string)

    const [lineItemsRes, claimsRes, settlementsRes] = await Promise.all([
      itemizedExpenseIds.length > 0
        ? supabase.from('expense_line_items').select('*').in('expense_id', itemizedExpenseIds).order('line_number')
        : Promise.resolve({ data: [] as any[], error: null }),
      itemizedExpenseIds.length > 0
        ? supabase.from('expense_item_claims').select('*, user:user_id (id, full_name, avatar_data)').in('expense_id', itemizedExpenseIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      supabase.from('settlements').select('*').eq('trip_id', trip.id),
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

    const assembled = (expensesData || []).map((expense: any) => ({
      ...expense,
      line_items: lineItemsByExpense.get(expense.id) || [],
      claims: claimsByExpense.get(expense.id) || [],
    })) as SpendingExpense[]

    setExpenses(assembled)
    setSettlements((settlementsRes.data || []) as Settlement[])
    calculateBalances(assembled, (settlementsRes.data || []) as Settlement[])
    setLoading(false)
  }

  const calculateBalances = (expensesData: SpendingExpense[], settlementsData: Settlement[]) => {
    const fxRateMap = new Map<string, number>()
    for (const exp of expensesData) {
      if (exp.fx_rate) fxRateMap.set(exp.id, exp.fx_rate)
    }

    const getExpenseGBP = (exp: SpendingExpense): number => {
      if (exp.base_currency_amount) return exp.base_currency_amount
      if (!exp.currency || exp.currency === 'GBP') return exp.amount
      const rate = fxRateMap.get(exp.id)
      return rate ? exp.amount * rate : 0
    }

    const getSplitGBP = (split: ExpenseSplit, expense: SpendingExpense): number => {
      if (split.base_currency_amount) return split.base_currency_amount
      if (!expense.currency || expense.currency === 'GBP') return split.amount
      const rate = fxRateMap.get(expense.id)
      return rate ? split.amount * rate : 0
    }

    const newBalances: BalanceData[] = participants.map(participant => {
      const userId = participant.user_id

      const totalPaid = expensesData
        .filter(exp => exp.paid_by === userId)
        .reduce((sum, exp) => sum + getExpenseGBP(exp), 0)

      const totalOwedFromSplits = expensesData.reduce((sum, exp) => {
        const userSplits = (exp.splits || []).filter(s => s.user_id === userId)
        return sum + userSplits.reduce((s, split) => s + getSplitGBP(split, exp), 0)
      }, 0)

      const totalOwedFromClaims = expensesData
        .filter(exp => exp.ai_parsed && exp.claims)
        .reduce((sum: number, exp) => {
          const userClaims = (exp.claims || []).filter((claim: any) => claim.user_id === userId)
          return sum + userClaims.reduce((claimSum: number, claim: any) => {
            const amountInOriginalCurrency = claim.amount_owed || 0
            const rate = fxRateMap.get(exp.id) || exp.fx_rate || (exp.currency === 'GBP' ? 1 : 0)
            return claimSum + (amountInOriginalCurrency * rate)
          }, 0)
        }, 0)

      const totalOwed = totalOwedFromSplits + totalOwedFromClaims

      const settlementsReceived = settlementsData
        .filter(s => s.to_user_id === userId)
        .reduce((sum, s) => sum + s.amount, 0)

      const settlementsPaid = settlementsData
        .filter(s => s.from_user_id === userId)
        .reduce((sum, s) => sum + s.amount, 0)

      const netBalance = totalPaid - totalOwed + settlementsPaid - settlementsReceived

      return {
        userId,
        user: participant.user,
        totalPaid,
        totalOwed,
        settlementsReceived,
        settlementsPaid,
        netBalance,
      }
    })

    setBalances(newBalances)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!user) return null

  const myBalance = balances.find(b => b.userId === user.id)
  if (!myBalance) {
    return (
      <Card>
        <Card.Content className="py-12">
          <EmptyState
            icon="📊"
            title="No spending data"
            description="You don't appear to be a participant in this trip."
          />
        </Card.Content>
      </Card>
    )
  }

  const totalTripSpend = balances.reduce((sum, b) => sum + b.totalOwed, 0)
  const tripStart = new Date(trip.start_date)
  const tripEnd = new Date(trip.end_date)
  const tripDurationDays = Math.max(1, Math.ceil((tripEnd.getTime() - tripStart.getTime()) / (1000 * 60 * 60 * 24)) + 1)

  if (expenses.length === 0) {
    return (
      <Card>
        <Card.Content className="py-12">
          <EmptyState
            icon="📊"
            title="No expenses yet"
            description="Once expenses are added to the trip, your personal spending summary will appear here."
          />
        </Card.Content>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <PersonalOverview
        myBalance={myBalance}
        totalTripSpend={totalTripSpend}
        tripDurationDays={tripDurationDays}
        participantCount={participants.length}
      />

      <CategoryBreakdown
        expenses={expenses}
        userId={user.id}
        participantCount={participants.length}
        activeCategory={categoryFilter}
        onCategorySelect={setCategoryFilter}
      />

      <DayByDayBreakdown
        expenses={expenses}
        trip={trip}
        userId={user.id}
        categoryFilter={categoryFilter}
      />

      <ExpenseAuditTrail
        expenses={expenses}
        userId={user.id}
        categoryFilter={categoryFilter}
      />

      <SettlementAudit
        settlements={settlements}
        userId={user.id}
        participants={participants}
      />
    </div>
  )
}
