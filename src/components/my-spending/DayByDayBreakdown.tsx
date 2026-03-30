import { useState } from 'react'
import { formatCurrency } from '../../lib/currency'
import { SpendingExpenseRow } from './SpendingExpenseRow'
import type { SpendingExpense } from './MySpendingTab'
import { Trip } from '../../types'

interface DayByDayBreakdownProps {
  expenses: SpendingExpense[]
  trip: Trip
  userId: string
  categoryFilter: string | null
}

interface DayGroup {
  label: string
  sublabel: string
  dateKey: string
  expenses: SpendingExpense[]
  tripTotal: number
  myTotal: number
}

export function DayByDayBreakdown({ expenses, trip, userId, categoryFilter }: DayByDayBreakdownProps) {
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [showEmptyDays, setShowEmptyDays] = useState(false)

  const filtered = categoryFilter
    ? expenses.filter(e => e.category === categoryFilter)
    : expenses

  const tripStart = new Date(trip.start_date)
  const tripEnd = new Date(trip.end_date)

  // Helper: get GBP amount for expense
  const getExpenseGBP = (exp: SpendingExpense): number => {
    if (exp.base_currency_amount) return exp.base_currency_amount
    if (!exp.currency || exp.currency === 'GBP') return exp.amount
    return exp.fx_rate ? exp.amount * exp.fx_rate : 0
  }

  // Helper: get user's share of an expense in GBP
  const getMyShareGBP = (exp: SpendingExpense): number => {
    let total = 0
    // From splits
    const mySplits = (exp.splits || []).filter(s => s.user_id === userId)
    for (const split of mySplits) {
      total += split.base_currency_amount
        || ((!exp.currency || exp.currency === 'GBP') ? split.amount : (exp.fx_rate ? split.amount * exp.fx_rate : 0))
    }
    // From itemized claims
    if (exp.ai_parsed && exp.claims) {
      const myClaims = (exp.claims || []).filter((c: any) => c.user_id === userId)
      const rate = exp.fx_rate || (exp.currency === 'GBP' ? 1 : 0)
      total += myClaims.reduce((sum: number, c: any) => sum + (c.amount_owed || 0) * rate, 0)
    }
    return total
  }

  // Group expenses by date
  const expensesByDate = new Map<string, SpendingExpense[]>()
  for (const exp of filtered) {
    const dateKey = exp.payment_date
    const list = expensesByDate.get(dateKey) || []
    list.push(exp)
    expensesByDate.set(dateKey, list)
  }

  // Build day groups
  const preTripExpenses: SpendingExpense[] = []
  const postTripExpenses: SpendingExpense[] = []
  const dayGroups: DayGroup[] = []

  // Generate all trip days
  const tripDays: Date[] = []
  const current = new Date(tripStart)
  while (current <= tripEnd) {
    tripDays.push(new Date(current))
    current.setDate(current.getDate() + 1)
  }

  // Categorize expenses
  for (const [dateKey, exps] of expensesByDate) {
    const date = new Date(dateKey)
    if (date < tripStart) {
      preTripExpenses.push(...exps)
    } else if (date > tripEnd) {
      postTripExpenses.push(...exps)
    }
    // Trip-day expenses are picked up in the day loop below
  }

  // Build trip day groups
  for (let i = 0; i < tripDays.length; i++) {
    const day = tripDays[i]
    const dateKey = day.toISOString().split('T')[0]
    const dayExpenses = expensesByDate.get(dateKey) || []

    dayGroups.push({
      label: `Day ${i + 1}`,
      sublabel: day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
      dateKey,
      expenses: dayExpenses,
      tripTotal: dayExpenses.reduce((sum, exp) => sum + getExpenseGBP(exp), 0),
      myTotal: dayExpenses.reduce((sum, exp) => sum + getMyShareGBP(exp), 0),
    })
  }

  const toggleDay = (dateKey: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev)
      if (next.has(dateKey)) next.delete(dateKey)
      else next.add(dateKey)
      return next
    })
  }

  const hasEmptyDays = dayGroups.some(g => g.expenses.length === 0)
  const longTrip = tripDays.length > 10

  // Pre/post trip totals
  const preTripTotal = preTripExpenses.reduce((sum, exp) => sum + getMyShareGBP(exp), 0)
  const postTripTotal = postTripExpenses.reduce((sum, exp) => sum + getMyShareGBP(exp), 0)
  const preTripTripTotal = preTripExpenses.reduce((sum, exp) => sum + getExpenseGBP(exp), 0)
  const postTripTripTotal = postTripExpenses.reduce((sum, exp) => sum + getExpenseGBP(exp), 0)

  if (filtered.length === 0) return null

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-3">Day by Day</h2>
      <div className="space-y-1">
        {/* Pre-trip */}
        {preTripExpenses.length > 0 && (
          <DayRow
            label="Pre-Trip"
            sublabel={`${preTripExpenses.length} expense${preTripExpenses.length !== 1 ? 's' : ''}`}
            tripTotal={preTripTripTotal}
            myTotal={preTripTotal}
            expenses={preTripExpenses}
            userId={userId}
            expanded={expandedDays.has('pre-trip')}
            onToggle={() => toggleDay('pre-trip')}
          />
        )}

        {/* Trip days */}
        {dayGroups.map(group => {
          if (!showEmptyDays && longTrip && group.expenses.length === 0) return null
          return (
            <DayRow
              key={group.dateKey}
              label={group.label}
              sublabel={group.sublabel}
              tripTotal={group.tripTotal}
              myTotal={group.myTotal}
              expenses={group.expenses}
              userId={userId}
              expanded={expandedDays.has(group.dateKey)}
              onToggle={() => toggleDay(group.dateKey)}
            />
          )
        })}

        {/* Show empty days toggle */}
        {longTrip && hasEmptyDays && (
          <button
            onClick={() => setShowEmptyDays(!showEmptyDays)}
            className="w-full text-center py-2 text-xs text-sky-600 hover:text-sky-700 font-medium"
          >
            {showEmptyDays ? 'Hide empty days' : 'Show all days'}
          </button>
        )}

        {/* Post-trip */}
        {postTripExpenses.length > 0 && (
          <DayRow
            label="Post-Trip"
            sublabel={`${postTripExpenses.length} expense${postTripExpenses.length !== 1 ? 's' : ''}`}
            tripTotal={postTripTripTotal}
            myTotal={postTripTotal}
            expenses={postTripExpenses}
            userId={userId}
            expanded={expandedDays.has('post-trip')}
            onToggle={() => toggleDay('post-trip')}
          />
        )}
      </div>
    </div>
  )
}

function DayRow({
  label,
  sublabel,
  tripTotal,
  myTotal,
  expenses,
  userId,
  expanded,
  onToggle,
}: {
  label: string
  sublabel: string
  tripTotal: number
  myTotal: number
  expenses: SpendingExpense[]
  userId: string
  expanded: boolean
  onToggle: () => void
}) {
  const hasExpenses = expenses.length > 0

  return (
    <div>
      <button
        onClick={hasExpenses ? onToggle : undefined}
        className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors ${
          hasExpenses
            ? 'bg-white border border-gray-200 hover:border-gray-300 cursor-pointer'
            : 'bg-gray-50 border border-gray-100 cursor-default'
        }`}
      >
        <div className="flex items-center gap-3">
          {hasExpenses && (
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
          {!hasExpenses && <div className="w-4" />}
          <div className="text-left">
            <span className="text-sm font-semibold text-gray-900">{label}</span>
            <span className="text-xs text-gray-500 ml-2">{sublabel}</span>
          </div>
        </div>

        {hasExpenses ? (
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <div className="text-xs text-gray-500">Trip</div>
              <div className="font-medium text-gray-700">{formatCurrency(tripTotal, 'GBP')}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">My share</div>
              <div className="font-bold text-gray-900">{formatCurrency(myTotal, 'GBP')}</div>
            </div>
          </div>
        ) : (
          <span className="text-xs text-gray-400">No expenses</span>
        )}
      </button>

      {expanded && hasExpenses && (
        <div className="ml-7 mt-1 space-y-1 mb-2">
          {expenses.map(expense => (
            <SpendingExpenseRow
              key={expense.id}
              expense={expense}
              userId={userId}
              showDate={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}
