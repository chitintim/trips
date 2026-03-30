import { Card } from '../ui'
import { formatCurrency } from '../../lib/currency'
import type { SpendingExpense } from './MySpendingTab'

interface CategoryBreakdownProps {
  expenses: SpendingExpense[]
  userId: string
  participantCount: number
  activeCategory: string | null
  onCategorySelect: (category: string | null) => void
}

const CATEGORY_ICONS: Record<string, string> = {
  accommodation: '🏠',
  transport: '🚗',
  food: '🍽️',
  activities: '⛷️',
  equipment: '🎿',
  other: '📦',
}

const CATEGORY_COLORS: Record<string, string> = {
  accommodation: 'bg-blue-500',
  transport: 'bg-amber-500',
  food: 'bg-orange-500',
  activities: 'bg-emerald-500',
  equipment: 'bg-purple-500',
  other: 'bg-gray-500',
}

export function CategoryBreakdown({ expenses, userId, participantCount, activeCategory, onCategorySelect }: CategoryBreakdownProps) {
  // Calculate per-category spending for the user and for the trip
  const categories = new Map<string, { myTotal: number; tripTotal: number }>()

  for (const expense of expenses) {
    const category = expense.category || 'other'
    const entry = categories.get(category) || { myTotal: 0, tripTotal: 0 }

    // Trip total for this expense (in GBP)
    const expenseGBP = expense.base_currency_amount
      || ((!expense.currency || expense.currency === 'GBP') ? expense.amount : (expense.fx_rate ? expense.amount * expense.fx_rate : 0))
    entry.tripTotal += expenseGBP

    // My share from splits
    const mySplits = (expense.splits || []).filter(s => s.user_id === userId)
    for (const split of mySplits) {
      const splitGBP = split.base_currency_amount
        || ((!expense.currency || expense.currency === 'GBP') ? split.amount : (expense.fx_rate ? split.amount * expense.fx_rate : 0))
      entry.myTotal += splitGBP
    }

    // My share from itemized claims
    if (expense.ai_parsed && expense.claims) {
      const myClaims = (expense.claims || []).filter((c: any) => c.user_id === userId)
      for (const claim of myClaims) {
        const rate = expense.fx_rate || (expense.currency === 'GBP' ? 1 : 0)
        entry.myTotal += (claim.amount_owed || 0) * rate
      }
    }

    categories.set(category, entry)
  }

  // Sort by my total descending
  const sorted = [...categories.entries()]
    .filter(([, data]) => data.myTotal > 0 || data.tripTotal > 0)
    .sort((a, b) => b[1].myTotal - a[1].myTotal)

  const myGrandTotal = sorted.reduce((sum, [, data]) => sum + data.myTotal, 0)
  const maxMyTotal = sorted.length > 0 ? sorted[0][1].myTotal : 0

  if (sorted.length === 0) return null

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-3">Spending by Category</h2>
      <Card className="!p-4">
        <div className="space-y-3">
          {sorted.map(([category, data]) => {
            const pct = myGrandTotal > 0 ? (data.myTotal / myGrandTotal) * 100 : 0
            const barWidth = maxMyTotal > 0 ? (data.myTotal / maxMyTotal) * 100 : 0
            const tripAvgPerPerson = data.tripTotal / participantCount
            const diffFromAvg = tripAvgPerPerson > 0
              ? ((data.myTotal - tripAvgPerPerson) / tripAvgPerPerson) * 100
              : 0
            const isActive = activeCategory === category

            return (
              <button
                key={category}
                onClick={() => onCategorySelect(isActive ? null : category)}
                className={`w-full text-left p-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-sky-50 ring-2 ring-sky-500'
                    : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{CATEGORY_ICONS[category] || '📦'}</span>
                    <span className="text-sm font-medium text-gray-900 capitalize">{category}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-gray-900">
                      {formatCurrency(data.myTotal, 'GBP')}
                    </span>
                    <span className="text-xs text-gray-500 w-10 text-right">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </div>

                {/* Bar */}
                <div className="w-full bg-gray-100 rounded-full h-2 mb-1.5">
                  <div
                    className={`h-2 rounded-full transition-all ${CATEGORY_COLORS[category] || 'bg-gray-500'}`}
                    style={{ width: `${Math.max(barWidth, 2)}%` }}
                  />
                </div>

                {/* Trip average comparison */}
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Trip avg: {formatCurrency(tripAvgPerPerson, 'GBP')}/person</span>
                  {Math.abs(diffFromAvg) > 1 && (
                    <span className={diffFromAvg > 0 ? 'text-red-500' : 'text-green-600'}>
                      {diffFromAvg > 0 ? '↑' : '↓'} {Math.abs(diffFromAvg).toFixed(0)}% {diffFromAvg > 0 ? 'above' : 'below'} avg
                    </span>
                  )}
                  {Math.abs(diffFromAvg) <= 1 && (
                    <span className="text-gray-400">~ average</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* Grand total */}
        <div className="mt-4 pt-3 border-t border-gray-200 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700">Total my spending</span>
          <span className="text-sm font-bold text-gray-900">{formatCurrency(myGrandTotal, 'GBP')}</span>
        </div>

        {activeCategory && (
          <div className="mt-2 text-xs text-sky-600 text-center">
            Filtering by {CATEGORY_ICONS[activeCategory]} {activeCategory} — tap again to clear
          </div>
        )}
      </Card>
    </div>
  )
}
