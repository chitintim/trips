import { useState } from 'react'
import { Card } from '../ui'
import { formatCurrency, type Currency } from '../../lib/currency'
import { ReceiptDisplay } from '../ReceiptDisplay'
import type { SpendingExpense } from './MySpendingTab'

interface SpendingExpenseRowProps {
  expense: SpendingExpense
  userId: string
  showDate?: boolean
}

const CATEGORY_ICONS: Record<string, string> = {
  accommodation: '🏠',
  transport: '🚗',
  food: '🍽️',
  activities: '⛷️',
  equipment: '🎿',
  other: '📦',
}

export function SpendingExpenseRow({ expense, userId, showDate = true }: SpendingExpenseRowProps) {
  const [expanded, setExpanded] = useState(false)

  const isPayer = expense.paid_by === userId
  const isItemized = expense.ai_parsed && expense.claims
  const currency = (expense.currency as Currency) || 'GBP'

  // Calculate my share
  let myShare = 0
  if (isItemized) {
    const myClaims = (expense.claims || []).filter((c: any) => c.user_id === userId)
    const rate = expense.fx_rate || (expense.currency === 'GBP' ? 1 : 0)
    myShare = myClaims.reduce((sum: number, c: any) => sum + (c.amount_owed || 0) * rate, 0)
  } else {
    const mySplit = (expense.splits || []).find(s => s.user_id === userId)
    if (mySplit) {
      myShare = mySplit.base_currency_amount
        || ((!expense.currency || expense.currency === 'GBP') ? mySplit.amount : (expense.fx_rate ? mySplit.amount * expense.fx_rate : 0))
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  // Border color: green if I paid, orange if I owe
  const borderColor = isPayer ? 'border-l-4 border-l-green-500' : myShare > 0 ? 'border-l-4 border-l-orange-500' : ''

  return (
    <Card
      noPadding
      className={`cursor-pointer transition-all hover:shadow-md ${borderColor}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="py-2 px-3">
        {/* Collapsed row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-base flex-shrink-0">{CATEGORY_ICONS[expense.category] || '📦'}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-gray-900 truncate">{expense.description}</div>
              <div className="flex items-center gap-1 text-[11px] text-gray-500">
                {isPayer ? (
                  <span className="text-green-600 font-medium">You paid</span>
                ) : (
                  <span className="truncate">{expense.payer.full_name || expense.payer.email}</span>
                )}
                {showDate && (
                  <>
                    <span>·</span>
                    <span className="whitespace-nowrap">{formatDate(expense.payment_date)}</span>
                  </>
                )}
                {expense.vendor_name && (
                  <>
                    <span>·</span>
                    <span className="truncate">{expense.vendor_name}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="text-right flex-shrink-0">
            <div className="text-sm font-bold text-gray-900">
              {formatCurrency(expense.amount, currency)}
            </div>
            {myShare > 0 && (
              <div className={`text-[11px] font-medium ${isPayer ? 'text-green-600' : 'text-orange-600'}`}>
                {isPayer ? 'Paid' : 'Owe'} {formatCurrency(myShare, 'GBP')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-gray-200 space-y-3">
          {/* Expense info */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {expense.vendor_name && (
              <div>
                <span className="text-gray-500">Vendor: </span>
                <span className="text-gray-900">{expense.vendor_name}</span>
              </div>
            )}
            {expense.location && (
              <div>
                <span className="text-gray-500">Location: </span>
                <span className="text-gray-900">{expense.location}</span>
              </div>
            )}
            <div>
              <span className="text-gray-500">Date: </span>
              <span className="text-gray-900">{formatDate(expense.payment_date)}</span>
            </div>
            <div>
              <span className="text-gray-500">Category: </span>
              <span className="text-gray-900 capitalize">{expense.category}</span>
            </div>
            {expense.currency !== 'GBP' && expense.base_currency_amount && (
              <div>
                <span className="text-gray-500">In GBP: </span>
                <span className="text-gray-900">{formatCurrency(expense.base_currency_amount, 'GBP')}</span>
              </div>
            )}
          </div>

          {/* Split details */}
          {!isItemized && expense.splits.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1.5">Split Details</h4>
              <div className="space-y-1">
                {expense.splits.map(split => {
                  const isMe = split.user_id === userId
                  return (
                    <div key={split.id} className={`flex items-center justify-between text-sm ${isMe ? 'font-medium' : ''}`}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-xs"
                          style={{ backgroundColor: (split.user.avatar_data as any)?.bgColor || '#0ea5e9' }}
                        >
                          <span>{(split.user.avatar_data as any)?.emoji || '😊'}</span>
                        </div>
                        <span className={isMe ? 'text-gray-900' : 'text-gray-700'}>
                          {isMe ? 'You' : (split.user.full_name || split.user.email)}
                        </span>
                      </div>
                      <span className={isMe ? 'text-orange-600' : 'text-gray-600'}>
                        {formatCurrency(
                          split.base_currency_amount || split.amount,
                          split.base_currency_amount ? 'GBP' : currency
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Itemized claims - show what I claimed */}
          {isItemized && (
            <div>
              <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1.5">My Claimed Items</h4>
              {(() => {
                const myClaims = (expense.claims || []).filter((c: any) => c.user_id === userId)
                if (myClaims.length === 0) {
                  return <p className="text-sm text-gray-500">No items claimed</p>
                }

                const lineItemsMap = new Map<string, any>()
                for (const item of (expense.line_items || [])) {
                  lineItemsMap.set(item.id, item)
                }

                return (
                  <div className="space-y-1">
                    {myClaims.map((claim: any) => {
                      const lineItem = lineItemsMap.get(claim.line_item_id)
                      const rate = expense.fx_rate || (expense.currency === 'GBP' ? 1 : 0)
                      return (
                        <div key={claim.id} className="flex items-center justify-between text-sm">
                          <span className="text-gray-900">
                            {lineItem?.name_english || lineItem?.name_original || 'Item'}
                            {claim.quantity_claimed > 1 && ` x${claim.quantity_claimed}`}
                          </span>
                          <span className="text-orange-600 font-medium">
                            {formatCurrency((claim.amount_owed || 0) * rate, 'GBP')}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Receipt image */}
          {expense.receipt_url && <ReceiptDisplay receiptPath={expense.receipt_url} />}
        </div>
      )}
    </Card>
  )
}
