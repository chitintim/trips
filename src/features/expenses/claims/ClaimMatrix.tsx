import { useState } from 'react'
import { Button, EmptyState, UserAvatar, useToast } from '../../../components/ui'
import { useSaveItemClaims } from '../../../lib/queries/useExpenses'
import { formatMoney } from '../lib/formatMoney'
import { largestRemainderDistribute } from '../../../lib/money'
import { summarizeLineClaims, amountOwedForQuantity } from './claimMath'
import type { ExpenseLineItem, ExpenseItemClaim } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'

export interface ClaimMatrixProps {
  expense: Expense
  lineItems: ExpenseLineItem[]
  claims: Array<ExpenseItemClaim & { user: { id: string; full_name: string | null } }>
  participants: ParticipantWithUser[]
}

/**
 * Organizer per-receipt claim matrix (who x items), plan §10 #4, with
 * one-tap "split remainder equally among tagged non-claimants" for
 * whatever's left unclaimed once everyone's had a chance.
 */
export function ClaimMatrix({ expense, lineItems, claims, participants }: ClaimMatrixProps) {
  const { showToast } = useToast()
  const saveClaims = useSaveItemClaims()
  const [isSplitting, setIsSplitting] = useState(false)

  const taggedParticipants = expense.participant_ids
    ? participants.filter((p) => expense.participant_ids!.includes(p.user_id))
    : participants

  const claimsByLineAndUser = new Map<string, Map<string, ExpenseItemClaim>>()
  for (const c of claims) {
    const map = claimsByLineAndUser.get(c.line_item_id) || new Map()
    map.set(c.user_id, c)
    claimsByLineAndUser.set(c.line_item_id, map)
  }

  const nonClaimantIds = taggedParticipants
    .map((p) => p.user_id)
    .filter((userId) => !claims.some((c) => c.user_id === userId))

  const handleSplitRemainder = async () => {
    if (nonClaimantIds.length === 0) {
      showToast({ type: 'info', message: 'Everyone tagged has already claimed something' })
      return
    }

    setIsSplitting(true)
    try {
      const claimsByUser = new Map<string, Array<{ line_item_id: string; quantity_claimed: number; amount_owed: number }>>()
      for (const userId of nonClaimantIds) claimsByUser.set(userId, [])

      for (const li of lineItems) {
        const claimsForLine = claims.filter((c) => c.line_item_id === li.id)
        const summary = summarizeLineClaims(li, claimsForLine, undefined)
        if (summary.available <= 0) continue

        // Distribute the remainder across non-claimants via
        // largestRemainderDistribute (hundredths of a unit, since
        // quantity_claimed is numeric(10,2)) so the shares sum EXACTLY to
        // what's available -- plain `available / N` float division could
        // leave a fractional unit unaccounted for once each independently-
        // rounded share lands in the DB column.
        const availableHundredths = Math.round(summary.available * 100)
        const shareHundredths = largestRemainderDistribute(availableHundredths, nonClaimantIds.map(() => 1))

        nonClaimantIds.forEach((userId, i) => {
          const share = shareHundredths[i] / 100
          if (share > 0) {
            claimsByUser.get(userId)!.push({ line_item_id: li.id, quantity_claimed: share, amount_owed: amountOwedForQuantity(li, share, expense.currency) })
          }
        })
      }

      for (const userId of nonClaimantIds) {
        const claimsForUser = claimsByUser.get(userId) ?? []
        if (claimsForUser.length > 0) {
          await saveClaims.mutateAsync({ expenseId: expense.id, userId, claims: claimsForUser })
        }
      }
      showToast({ type: 'success', message: 'Remainder split among non-claimants' })
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to split remainder', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsSplitting(false)
    }
  }

  // Audit finding #10: with zero tagged participants the table below would
  // render a header-only, body-only-item-rows grid with no person columns
  // at all -- reads as broken, not as "nothing to show here yet".
  if (taggedParticipants.length === 0) {
    return (
      <EmptyState
        compact
        icon="🧾"
        title="No one's tagged on this expense"
        description="Tag participants on the expense itself before claims can be split or matched against them."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left py-2 pr-3 font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--surface-page)]">Item</th>
              {taggedParticipants.map((p) => (
                <th key={p.user_id} className="px-2 py-2 font-medium text-[var(--text-secondary)]">
                  <div className="flex flex-col items-center gap-1">
                    <UserAvatar avatarData={p.user} size="xs" alt={p.user.full_name ?? p.user.email} />
                    <span className="text-[10px] max-w-14 truncate">{p.user.full_name?.split(' ')[0] || p.user.email}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li) => (
              <tr key={li.id} className="border-t border-[var(--border-subtle)]">
                <td
                  className="py-2 pr-3 sticky left-0 bg-[var(--surface-page)] max-w-32"
                  title={li.name_original !== li.name_english ? `${li.name_original}` : undefined}
                >
                  <span className="block truncate">
                    <span className="text-[var(--text-muted)] tabular-nums">{li.line_number}.</span>{' '}
                    {li.name_english || li.name_original}
                  </span>
                  {li.name_english && li.name_original && li.name_original !== li.name_english && (
                    <span className="block truncate text-xs text-[var(--text-secondary)]">{li.name_original}</span>
                  )}
                </td>
                {taggedParticipants.map((p) => {
                  const claim = claimsByLineAndUser.get(li.id)?.get(p.user_id)
                  return (
                    <td key={p.user_id} className="px-2 py-2 text-center tabular-nums text-xs">
                      {claim ? claim.quantity_claimed : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2.5">
        <p className="text-sm text-[var(--text-secondary)]">
          {nonClaimantIds.length > 0
            ? `${nonClaimantIds.length} tagged ${nonClaimantIds.length === 1 ? 'person hasn\'t' : 'people haven\'t'} claimed anything yet.`
            : 'Everyone tagged has claimed at least something.'}
        </p>
      </div>

      <Button
        variant="secondary"
        size="sm"
        onClick={handleSplitRemainder}
        disabled={nonClaimantIds.length === 0 || isSplitting}
        isLoading={isSplitting}
      >
        Split remainder equally among non-claimants
      </Button>

      <p className="text-xs text-[var(--text-muted)]">
        Amounts shown are quantities claimed per item; totals owed reflect the line's price × claimed quantity, before tax/service proration.{' '}
        {formatMoney(expense.amount, expense.currency)} total.
      </p>
    </div>
  )
}
