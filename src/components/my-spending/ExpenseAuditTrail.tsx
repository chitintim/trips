import { useState } from 'react'
import { formatCurrency } from '../../lib/currency'
import { SpendingExpenseRow } from './SpendingExpenseRow'
import type { SpendingExpense } from './MySpendingTab'

interface ExpenseAuditTrailProps {
  expenses: SpendingExpense[]
  userId: string
  categoryFilter: string | null
}

export function ExpenseAuditTrail({ expenses, userId, categoryFilter }: ExpenseAuditTrailProps) {
  const [paidExpanded, setPaidExpanded] = useState(true)
  const [owedExpanded, setOwedExpanded] = useState(true)

  const filtered = categoryFilter
    ? expenses.filter(e => e.category === categoryFilter)
    : expenses

  // Expenses I paid
  const expensesIPaid = filtered.filter(e => e.paid_by === userId)

  // Expenses assigned to me (I have a split or claim, but didn't pay)
  const expensesAssignedToMe = filtered.filter(e => {
    if (e.paid_by === userId) return false
    const hasSplit = (e.splits || []).some(s => s.user_id === userId)
    const hasClaim = e.ai_parsed && (e.claims || []).some((c: any) => c.user_id === userId)
    return hasSplit || hasClaim
  })

  // Calculate totals
  const getExpenseGBP = (exp: SpendingExpense): number => {
    if (exp.base_currency_amount) return exp.base_currency_amount
    if (!exp.currency || exp.currency === 'GBP') return exp.amount
    return exp.fx_rate ? exp.amount * exp.fx_rate : 0
  }

  const getMyShareGBP = (exp: SpendingExpense): number => {
    let total = 0
    const mySplits = (exp.splits || []).filter(s => s.user_id === userId)
    for (const split of mySplits) {
      total += split.base_currency_amount
        || ((!exp.currency || exp.currency === 'GBP') ? split.amount : (exp.fx_rate ? split.amount * exp.fx_rate : 0))
    }
    if (exp.ai_parsed && exp.claims) {
      const myClaims = (exp.claims || []).filter((c: any) => c.user_id === userId)
      const rate = exp.fx_rate || (exp.currency === 'GBP' ? 1 : 0)
      total += myClaims.reduce((sum: number, c: any) => sum + (c.amount_owed || 0) * rate, 0)
    }
    return total
  }

  const totalIPaid = expensesIPaid.reduce((sum, e) => sum + getExpenseGBP(e), 0)
  const totalAssignedToMe = expensesAssignedToMe.reduce((sum, e) => sum + getMyShareGBP(e), 0)

  if (expensesIPaid.length === 0 && expensesAssignedToMe.length === 0) return null

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-3">Expense Audit</h2>

      {/* Expenses I Paid */}
      {expensesIPaid.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setPaidExpanded(!paidExpanded)}
            className="w-full flex items-center justify-between mb-2"
          >
            <div className="flex items-center gap-2">
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${paidExpanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <h3 className="text-sm font-semibold text-gray-700">
                Expenses I Paid ({expensesIPaid.length})
              </h3>
            </div>
            <span className="text-sm font-bold text-green-600">
              {formatCurrency(totalIPaid, 'GBP')}
            </span>
          </button>

          {paidExpanded && (
            <div className="space-y-1">
              {expensesIPaid.map(expense => (
                <SpendingExpenseRow
                  key={expense.id}
                  expense={expense}
                  userId={userId}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expenses Assigned to Me */}
      {expensesAssignedToMe.length > 0 && (
        <div>
          <button
            onClick={() => setOwedExpanded(!owedExpanded)}
            className="w-full flex items-center justify-between mb-2"
          >
            <div className="flex items-center gap-2">
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${owedExpanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <h3 className="text-sm font-semibold text-gray-700">
                Expenses Assigned to Me ({expensesAssignedToMe.length})
              </h3>
            </div>
            <span className="text-sm font-bold text-orange-600">
              {formatCurrency(totalAssignedToMe, 'GBP')}
            </span>
          </button>

          {owedExpanded && (
            <div className="space-y-1">
              {expensesAssignedToMe.map(expense => (
                <SpendingExpenseRow
                  key={expense.id}
                  expense={expense}
                  userId={userId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
