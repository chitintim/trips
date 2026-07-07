import { useEffect, useState } from 'react'
import { Card, UserAvatar, Button } from '../../../components/ui'
import { getReceiptUrl } from '../../../lib/receiptUpload'
import { formatMoney, formatMoneyMinor } from '../lib/formatMoney'
import { CategoryIcon } from '../components/CategoryIcon'
import { FxBadge } from '../components/FxBadge'
import { ClaimStatusRing } from '../components/ClaimStatusRing'
import { LiableAvatarStack } from '../components/LiableAvatarStack'
import { isItemizedExpense } from '../types'
import { summarizeOverallProgress } from '../claims/claimMath'
import { computeLiableUserIds, buildExpenseMetaSentence, computeExpenseStake } from '../lib/expenseRowInsights'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ExpenseCardProps {
  expense: ExpenseWithDetails
  /** Every trip participant keyed by user_id -- resolves the payer AND the liable-avatar stack, not just the payer (plan point 1). */
  participantsByUserId: Record<string, ParticipantWithUser>
  baseCurrency: string
  currentUserId: string | undefined
  onEdit: () => void
  onOpenClaim: (code: string) => void
  /** Blocks the Edit action while settlement balances are frozen (plan §12). */
  editDisabled?: boolean
}

/**
 * A single expense-feed row (UX_REDESIGN.md Part 4 "Money: balance-first" +
 * user feedback "not immediately clear who paid and who is liable"):
 *   line 1 -- icon · title/vendor · right-aligned amount (+ base-currency
 *            subline only when the currency differs).
 *   line 2 -- explicit meta sentence ("You paid · split 4 ways"), payer
 *            avatar (with a "paid" ring/badge) + a compact liable-avatar
 *            stack, and the personal-stake chip right-aligned ("you owe
 *            £12.50" / "you're owed £30" / "claim yours").
 *   line 3 -- receipt thumbnail, claim-status ring (itemized), edit/claim.
 * Rows the viewer has no stake in at all render muted (`stake.involved`
 * is the single source of truth for that -- see expenseRowInsights.ts) so
 * the eye skips straight to what matters.
 */
export function ExpenseCard({ expense, participantsByUserId, baseCurrency, currentUserId, onEdit, onOpenClaim, editDisabled }: ExpenseCardProps) {
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

  const payer = participantsByUserId[expense.paid_by]
  const payerName = payer?.user.full_name || payer?.user.email || 'Someone'

  const liableUserIds = computeLiableUserIds(expense)
  const liableParticipants = liableUserIds.filter((id) => id !== expense.paid_by).map((id) => participantsByUserId[id])

  const metaSentence = buildExpenseMetaSentence({
    payerName,
    payerId: expense.paid_by,
    viewerId: currentUserId,
    liableUserIds,
    isItemized: itemized,
    taggedUserIds: expense.participant_ids ?? [],
  })

  const stake = computeExpenseStake(expense, currentUserId)
  const muted = !stake.involved

  return (
    <Card noPadding className={`p-3.5 flex items-start gap-3 transition-opacity duration-200 ${muted ? 'opacity-60' : ''}`}>
      <CategoryIcon category={expense.category} className="mt-0.5 shrink-0" />

      <div className="flex-1 min-w-0">
        {/* Line 1: title/vendor · amount */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={`font-medium truncate ${muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
              {expense.description}
            </p>
            {expense.vendor_name && <p className="text-xs text-[var(--text-muted)] truncate">{expense.vendor_name}</p>}
          </div>
          <div className="text-right shrink-0">
            <p className={`font-semibold tabular-nums ${muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
              {formatMoney(expense.amount, expense.currency)}
            </p>
            <FxBadge
              className="block mt-0.5"
              currency={expense.currency}
              baseCurrency={baseCurrency}
              amount={expense.amount}
              baseCurrencyAmount={expense.base_currency_amount}
              fxRate={expense.fx_rate}
              rateSource={expense.rate_source}
            />
          </div>
        </div>

        {/* Line 2: who paid / who's liable / what it means for the viewer */}
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="relative inline-flex shrink-0">
            <UserAvatar avatarData={payer?.user} size="xs" alt={payerName} className="ring-2 ring-success-400" />
            <span
              className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success-500 text-white text-[7px] leading-none ring-1 ring-[var(--surface-raised)]"
              aria-hidden="true"
              title="Paid"
            >
              ✓
            </span>
          </span>

          <LiableAvatarStack participants={liableParticipants} />

          <span className={`min-w-0 flex-1 truncate text-xs ${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>
            {metaSentence}
          </span>

          {stake.kind === 'owe' && (
            <span className="shrink-0 text-xs font-semibold text-danger-600 tabular-nums">
              you owe {formatMoneyMinor(stake.amountMinor, stake.currency)}
            </span>
          )}
          {stake.kind === 'owed' && (
            <span className="shrink-0 text-xs font-semibold text-success-600 tabular-nums">
              you're owed {formatMoneyMinor(stake.amountMinor, stake.currency)}
            </span>
          )}
          {stake.kind === 'claim' &&
            (expense.allocation_link ? (
              <button
                type="button"
                onClick={() => onOpenClaim(expense.allocation_link!.code)}
                className="shrink-0 text-xs font-semibold text-accent-700 dark:text-accent-400 press-scale"
              >
                claim yours →
              </button>
            ) : (
              <span className="shrink-0 text-xs font-semibold text-accent-700 dark:text-accent-400">claim yours</span>
            ))}
        </div>

        {/* Line 3: receipt thumbnail, claim progress, primary action */}
        <div className="flex items-center gap-3 mt-2">
          {thumbUrl && (
            <img src={thumbUrl} alt="Receipt thumbnail" className="w-8 h-8 rounded-[var(--radius-sm)] object-cover border border-[var(--border-subtle)]" />
          )}

          {itemized && progress && (
            <div className="flex items-center gap-1.5">
              <ClaimStatusRing percentClaimed={progress.percentClaimed} size={20} />
              <span className="text-xs text-[var(--text-secondary)]">
                {progress.isFullyAllocated ? 'Fully claimed' : `${Math.round(progress.percentClaimed)}% claimed`}
              </span>
            </div>
          )}

          <div className="flex-1" />

          {itemized && expense.allocation_link ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenClaim(expense.allocation_link!.code)}>
              {stake.kind === 'owe' || (currentUserId && expense.claims.some((c) => c.user_id === currentUserId)) ? 'Edit claims' : 'Claim items'}
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
