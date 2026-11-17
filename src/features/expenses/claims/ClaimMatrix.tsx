import { EmptyState, UserAvatar } from '../../../components/ui'
import { fromMinorUnits, toMinorUnits } from '../../../lib/money'
import { formatMoney, formatMoneyMinor } from '../lib/formatMoney'
import { formatClaimQuantity } from './claimFractions'
import { nameOfUser } from './claimPeople'
import { unclaimedMinor } from './claimMath'
import type { ClaimRow, LineRow } from './claimMath'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Expense } from '../../../types'

export interface ClaimMatrixProps {
  expense: Expense
  lineItems: LineRow[]
  claims: ClaimRow[]
  participants: ParticipantWithUser[]
}

/** Marker + words for where a claim row came from. */
function sourceInfo(row: ClaimRow, participants: ParticipantWithUser[]): { mark: string; words: string } {
  switch (row.source) {
    case 'on_behalf':
      return { mark: '✎', words: row.created_by && row.created_by !== row.user_id ? `put down by ${nameOfUser(row.created_by, participants)}` : 'claimed by themselves' }
    case 'shared':
      return { mark: '÷', words: 'shared' }
    case 'leftover':
      return { mark: '↺', words: 'share of the leftovers' }
    default:
      return { mark: '', words: 'claimed by themselves' }
  }
}

/**
 * Read-only "who had what" overview for the payer and anyone who manages the
 * trip: a grid of people by item, with where each claim came from. Changing
 * who had what is done in "Who had what" (it needs the receipt-claims
 * functions); this view only reports.
 */
export function ClaimMatrix({ expense, lineItems, claims, participants }: ClaimMatrixProps) {
  const currency = expense.currency
  const tagged = expense.participant_ids && expense.participant_ids.length > 0 ? participants.filter((p) => expense.participant_ids!.includes(p.user_id)) : participants
  // Someone can have claimed without being tagged: still show them.
  const extraIds = [...new Set(claims.map((c) => c.user_id))].filter((id) => !tagged.some((p) => p.user_id === id))
  const columns = [...tagged, ...participants.filter((p) => extraIds.includes(p.user_id))]

  if (columns.length === 0) {
    return (
      <EmptyState
        compact
        icon="🧾"
        title="No one's tagged on this expense"
        description="Tag participants on the expense itself before claims can be matched against them."
      />
    )
  }

  const rowsFor = (lineId: string, userId: string) => claims.filter((c) => c.line_item_id === lineId && c.user_id === userId)
  const totalFor = (userId: string) => claims.filter((c) => c.user_id === userId).reduce((s, c) => s + toMinorUnits(c.amount_owed, currency), 0)
  // Legacy rounding dust on a fully claimed line is not "left" (see isLineReallyUnclaimed).
  const leftFor = (li: LineRow) => unclaimedMinor([li], claims.filter((c) => c.line_item_id === li.id), currency)
  const anyLeft = lineItems.some((li) => leftFor(li) > 0)
  const hasMarkers = claims.some((c) => c.source && c.source !== 'self')

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left py-2 pr-3 font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--surface-page)]">Item</th>
              {columns.map((p) => (
                <th key={p.user_id} className="px-2 py-2 font-medium text-[var(--text-secondary)]">
                  <div className="flex flex-col items-center gap-1">
                    <UserAvatar avatarData={p.user} size="xs" alt={p.user.full_name ?? p.user.email} />
                    <span className="text-[10px] max-w-14 truncate">{p.user.full_name?.split(' ')[0] || p.user.email}</span>
                  </div>
                </th>
              ))}
              {anyLeft && <th className="px-2 py-2 text-xs font-medium text-[var(--text-secondary)]">Left</th>}
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li) => (
              <tr key={li.id} className="border-t border-[var(--border-subtle)]">
                <td className="py-2 pr-3 sticky left-0 bg-[var(--surface-page)] max-w-32" title={li.name_original !== li.name_english ? `${li.name_original}` : undefined}>
                  <span className="block truncate">
                    <span className="text-[var(--text-muted)] tabular-nums">{li.line_number}.</span> {li.name_english || li.name_original}
                  </span>
                  {li.name_english && li.name_original && li.name_original !== li.name_english && (
                    <span className="block truncate text-xs text-[var(--text-secondary)]">{li.name_original}</span>
                  )}
                </td>
                {columns.map((p) => {
                  const rows = rowsFor(li.id, p.user_id)
                  if (rows.length === 0) {
                    return (
                      <td key={p.user_id} className="px-2 py-2 text-center text-xs text-[var(--text-muted)]">
                        <span aria-label="nothing">—</span>
                      </td>
                    )
                  }
                  const qty = rows.reduce((s, r) => s + r.quantity_claimed, 0)
                  const infos = rows.map((r) => sourceInfo(r, participants))
                  const words = infos.map((i) => i.words).join(', ')
                  return (
                    <td key={p.user_id} className="px-2 py-2 text-center tabular-nums text-xs" title={words} aria-label={`${formatClaimQuantity(qty)}, ${words}`}>
                      <span>{formatClaimQuantity(qty)}</span>
                      <sup className="ml-0.5 text-[var(--text-muted)]">{[...new Set(infos.map((i) => i.mark).filter(Boolean))].join('')}</sup>
                    </td>
                  )
                })}
                {anyLeft && (
                  <td className="px-2 py-2 text-center text-xs tabular-nums text-[var(--text-secondary)]">{leftFor(li) > 0 ? formatMoneyMinor(leftFor(li), currency) : ''}</td>
                )}
              </tr>
            ))}
            <tr className="border-t-2 border-[var(--border-default)] font-medium">
              <td className="py-2 pr-3 sticky left-0 bg-[var(--surface-page)]">Total</td>
              {columns.map((p) => (
                <td key={p.user_id} className="px-2 py-2 text-center text-xs tabular-nums">
                  {formatMoney(fromMinorUnits(totalFor(p.user_id), currency), currency)}
                </td>
              ))}
              {anyLeft && <td />}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Each cell is how much of the item that person had. The total row is what they owe, including their share of tax and service.
        {hasMarkers && ' ✎ put down by someone else · ÷ shared · ↺ share of the leftovers.'} {formatMoney(expense.amount, currency)} in all.
      </p>
    </div>
  )
}
