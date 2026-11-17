import { useState } from 'react'
import { Card, Button, Modal, useToast } from '../../../components/ui'
import { useRemoveDuplicateSettlement } from '../../../lib/queries/useSettlements'
import { formatMoney } from '../lib/formatMoney'
import type { DuplicatePaymentGroup } from './settleUpLogic'
import { canRemoveAsDuplicate } from './settlementFreeze'

export interface DuplicatePaymentsNoticeProps {
  groups: DuplicatePaymentGroup[]
  /** Organizers (and the trip creator / site admin) get the Remove action; everyone else just sees the notice. */
  canRemove: boolean
  tripId: string
  /** The trip's base currency (settlements with no currency are in it). */
  baseCurrency: string
  nameOf: (userId: string) => string
}

const STATUS_LABELS: Record<string, string> = { marked_paid: 'marked paid', confirmed: 'confirmed' }

function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'unknown date'
}

/**
 * Read-only detection of payments that look recorded twice (same pair, amount
 * and currency, both past 'suggested'), with an organizer-only action that
 * deletes exactly ONE chosen row after an explicit confirm. Nothing is ever
 * removed automatically: two genuine identical payments are possible.
 *
 * Removal goes through remove_duplicate_settlement (organizer, trip creator
 * or admin; the server re-proves the duplicate and refuses confirmed rows),
 * or a direct delete before that migration is applied. Confirmed payments are
 * never offered for removal here. Errors are shown as-is.
 * The settlements query is invalidated on success, which refreshes Settle up,
 * the Money header and the "Confirm X paid you" to-dos together.
 */
export function DuplicatePaymentsNotice({ groups, canRemove, tripId, baseCurrency, nameOf }: DuplicatePaymentsNoticeProps) {
  const { showToast } = useToast()
  const deleteSettlement = useRemoveDuplicateSettlement(tripId)
  // Chosen row per group key; default is the earlier one (rows are oldest first).
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<{ group: DuplicatePaymentGroup; rowId: string } | null>(null)

  if (groups.length === 0) return null

  // Only a non-confirmed row that another non-suggested row proves a repeat of can go.
  const allRows = groups.flatMap((g) => g.rows)
  const removable = (g: DuplicatePaymentGroup, r: DuplicatePaymentGroup['rows'][number]) => canRemoveAsDuplicate(r, allRows, baseCurrency) && g.rows.length > 1

  const confirmRow = confirming ? confirming.group.rows.find((r) => r.id === confirming.rowId) : undefined

  const handleRemove = () => {
    if (!confirming || !confirmRow || deleteSettlement.isPending) return
    deleteSettlement.mutate(confirmRow.id, {
      onSuccess: () => {
        showToast({ type: 'success', message: 'Duplicate payment removed' })
        setConfirming(null)
      },
      onError: (err) =>
        showToast({ type: 'error', message: 'Could not remove the duplicate', description: err instanceof Error ? err.message : undefined }),
    })
  }

  return (
    <Card variant="sunken" noPadding className="p-4 space-y-3" id="duplicate-payments">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">These look like the same payment recorded twice</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          {canRemove
            ? 'Nothing is changed automatically. If it really is a repeat, an organizer can remove one of the two. Freezing is paused until this is sorted out.'
            : 'Nothing is changed automatically. An organizer can remove one if it is a repeat. Freezing is paused until then.'}
        </p>
      </div>

      {groups.map((g) => {
        const removableRows = g.rows.filter((r) => removable(g, r))
        // Earliest removable row by default (rows are oldest first); the organiser can pick the other.
        const selectedId = chosen[g.key] ?? removableRows[0]?.id ?? ''
        return (
          <div key={g.key} className="space-y-1.5" data-testid="duplicate-payment-group">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {nameOf(g.from)} → {nameOf(g.to)} · {formatMoney(g.amount, g.currency)}
            </p>
            <ul className="space-y-1">
              {g.rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  {canRemove && removableRows.length > 0 && (
                    <input
                      type="radio"
                      name={`dup-${g.key}`}
                      disabled={!removable(g, r)}
                      checked={selectedId === r.id}
                      onChange={() => setChosen((c) => ({ ...c, [g.key]: r.id }))}
                      aria-label={`Select the row recorded ${formatDate(r.created_at)}`}
                    />
                  )}
                  <span>
                    Recorded {formatDate(r.created_at)} · {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </li>
              ))}
            </ul>
            {canRemove && removableRows.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setConfirming({ group: g, rowId: selectedId })}>
                Remove duplicate
              </Button>
            )}
          </div>
        )
      })}

      <Modal isOpen={!!confirming && !!confirmRow} onClose={() => !deleteSettlement.isPending && setConfirming(null)} title="Remove this payment?" size="sm">
        {confirming && confirmRow && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This permanently deletes ONE payment record: {nameOf(confirming.group.from)} → {nameOf(confirming.group.to)},{' '}
              {formatMoney(confirming.group.amount, confirming.group.currency)}, {STATUS_LABELS[confirmRow.status] ?? confirmRow.status},
              recorded {formatDate(confirmRow.created_at)}. The other record is kept. This cannot be undone.
            </p>
            <p className="text-sm text-[var(--text-secondary)]">
              Two genuine payments of the same amount made within a day look identical here. Check with {nameOf(confirming.group.from)} before
              removing one. You can choose which of the two to remove; the earlier one is preselected.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" fullWidth onClick={() => setConfirming(null)} disabled={deleteSettlement.isPending}>
                Keep both
              </Button>
              <Button variant="danger" fullWidth onClick={handleRemove} isLoading={deleteSettlement.isPending} disabled={deleteSettlement.isPending}>
                Remove this one
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
