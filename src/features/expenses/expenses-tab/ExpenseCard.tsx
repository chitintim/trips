import { useEffect, useState } from 'react'
import { Card, UserAvatar, Badge, Button } from '../../../components/ui'
import { getReceiptUrl } from '../../../lib/receiptUpload'
import { formatMoney } from '../lib/formatMoney'
import { CategoryIcon } from '../components/CategoryIcon'
import { FxBadge } from '../components/FxBadge'
import { ClaimStatusRing } from '../components/ClaimStatusRing'
import { isItemizedExpense } from '../types'
import { summarizeOverallProgress } from '../claims/claimMath'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ExpenseCardProps {
  expense: ExpenseWithDetails
  payer: ParticipantWithUser | undefined
  baseCurrency: string
  currentUserId: string | undefined
  onEdit: () => void
  onOpenClaim: (code: string) => void
  /** Blocks the Edit action while settlement balances are frozen (plan §12). */
  editDisabled?: boolean
}

export function ExpenseCard({ expense, payer, baseCurrency, currentUserId, onEdit, onOpenClaim, editDisabled }: ExpenseCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const itemized = isItemizedExpense(expense)
  const progress = itemized ? summarizeOverallProgress(expense.line_items, expense.claims) : null

  useEffect(() => {
    if (!expense.receipt_url) return
    let cancelled = false
    getReceiptUrl(expense.receipt_url)
      .then((url) => !cancelled && setThumbUrl(url))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [expense.receipt_url])

  const isPayer = expense.paid_by === currentUserId
  const myClaim = expense.claims.find((c) => c.user_id === currentUserId)
  const mySplit = expense.splits.find((s) => s.user_id === currentUserId)

  return (
    <Card noPadding className="p-3.5 flex items-start gap-3">
      <CategoryIcon category={expense.category} className="mt-0.5 shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-[var(--text-primary)] truncate">{expense.description}</p>
            {expense.vendor_name && <p className="text-xs text-[var(--text-muted)] truncate">{expense.vendor_name}</p>}
          </div>
          <span className="font-semibold text-[var(--text-primary)] tabular-nums shrink-0">
            {formatMoney(expense.amount, expense.currency)}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {payer && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
              <UserAvatar avatarData={payer.user.avatar_data} size="xs" alt={payer.user.full_name ?? payer.user.email} />
              {payer.user.full_name || payer.user.email}
            </span>
          )}

          <FxBadge
            currency={expense.currency}
            baseCurrency={baseCurrency}
            amount={expense.amount}
            baseCurrencyAmount={expense.base_currency_amount}
            fxRate={expense.fx_rate}
            rateSource={expense.rate_source}
          />

          {isPayer && <Badge variant="success" size="sm">✓ Paid</Badge>}
          {!isPayer && !itemized && mySplit && (
            <Badge variant="warning" size="sm">Owe {formatMoney(mySplit.amount, expense.currency)}</Badge>
          )}
          {!isPayer && itemized && myClaim && (
            <Badge variant="warning" size="sm">You: {formatMoney(myClaim.amount_owed, expense.currency)}</Badge>
          )}
        </div>

        <div className="flex items-center gap-3 mt-2">
          {thumbUrl && (
            <img src={thumbUrl} alt="Receipt thumbnail" className="w-10 h-10 rounded-[var(--radius-sm)] object-cover border border-[var(--border-subtle)]" />
          )}

          {itemized && progress && (
            <div className="flex items-center gap-1.5">
              <ClaimStatusRing percentClaimed={progress.percentClaimed} size={22} />
              <span className="text-xs text-[var(--text-secondary)]">
                {progress.isFullyAllocated ? 'Fully claimed' : `${Math.round(progress.percentClaimed)}% claimed`}
              </span>
            </div>
          )}

          <div className="flex-1" />

          {itemized && expense.allocation_link ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenClaim(expense.allocation_link!.code)}>
              {myClaim ? 'Edit claims' : 'Claim items'}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onEdit} disabled={editDisabled}>
              Edit
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
