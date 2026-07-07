import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, Button, Badge, Spinner, EmptyState, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useSaveItemClaims } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { formatMoney } from '../lib/formatMoney'
import { useClaimLink, useClaimRealtime } from './useClaimData'
import { summarizeLineClaims, summarizeOverallProgress, maxClaimableQuantity, amountOwedForQuantity } from './claimMath'
import { ClaimMatrix } from './ClaimMatrix'
import { ReceiptLightbox } from '../components/ReceiptLightbox'

/**
 * Claims v2 (plan §10 #4): tap items you had, quantity steppers (decimal --
 * shared dishes), live "unclaimed remainder" bar, organizer per-receipt
 * claim matrix, one-tap "split remainder equally among tagged
 * non-claimants". Works both as the public /claim/:code page and embedded
 * in-app from the Needs-attention strip.
 */
export function ClaimPage() {
  const { code } = useParams<{ code: string }>()
  const { user } = useAuth()
  const { data: resolution, isLoading, error } = useClaimLink(code)
  const { data: participants = [] } = useParticipants(resolution?.tripId)
  const saveClaims = useSaveItemClaims()
  const { showToast } = useToast()

  const currentUserName = participants.find((p) => p.user_id === user?.id)?.user.full_name || user?.email || 'Someone'
  const { broadcastSelection } = useClaimRealtime(resolution?.expense.id, user?.id, currentUserName)

  const [localSelections, setLocalSelections] = useState<Record<string, number>>({})
  const [initialized, setInitialized] = useState(false)
  const [organizerView, setOrganizerView] = useState(false)
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)

  useEffect(() => {
    if (!resolution || !user || initialized) return
    const mine: Record<string, number> = {}
    for (const claim of resolution.claims) {
      if (claim.user_id === user.id) mine[claim.line_item_id] = claim.quantity_claimed
    }
    setLocalSelections(mine)
    setInitialized(true)
  }, [resolution, user, initialized])

  const claimsByLine = useMemo(() => {
    const map = new Map<string, typeof resolution extends null ? never : NonNullable<typeof resolution>['claims']>()
    if (!resolution) return map
    for (const claim of resolution.claims) {
      const list = map.get(claim.line_item_id) || []
      list.push(claim)
      map.set(claim.line_item_id, list)
    }
    return map
  }, [resolution])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error || !resolution) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md">
          <EmptyState icon="🔗" title="Link not found" description="This claim link may have expired or is invalid." />
        </Card>
      </div>
    )
  }

  const { expense, lineItems } = resolution
  const isPayer = user?.id === expense.paid_by
  const overallProgress = summarizeOverallProgress(lineItems, resolution.claims)
  const isReadOnly = expense.status === 'allocated'

  const updateQuantity = (lineItemId: string, quantity: number) => {
    const next = { ...localSelections, [lineItemId]: quantity }
    setLocalSelections(next)

    const payload: Record<string, { lineItemId: string; quantity: number; amount: number }> = {}
    for (const [id, qty] of Object.entries(next)) {
      const li = lineItems.find((l) => l.id === id)
      if (li && qty > 0) payload[id] = { lineItemId: id, quantity: qty, amount: amountOwedForQuantity(li, qty, expense.currency) }
    }
    broadcastSelection(payload)
  }

  const handleSave = async () => {
    if (!user) return
    const claims = Object.entries(localSelections)
      .filter(([, qty]) => qty > 0)
      .map(([lineItemId, qty]) => {
        const li = lineItems.find((l) => l.id === lineItemId)!
        return { line_item_id: lineItemId, quantity_claimed: qty, amount_owed: amountOwedForQuantity(li, qty, expense.currency) }
      })
    try {
      await saveClaims.mutateAsync({ expenseId: expense.id, userId: user.id, claims })
      showToast({ type: 'success', message: 'Your claims are saved' })
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save your claims', description: err instanceof Error ? err.message : undefined })
    }
  }

  const myTotal = Object.entries(localSelections).reduce((sum, [lineItemId, qty]) => {
    const li = lineItems.find((l) => l.id === lineItemId)
    return li ? sum + amountOwedForQuantity(li, qty, expense.currency) : sum
  }, 0)

  return (
    <div className="min-h-screen bg-[var(--surface-page)] pb-24">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">{expense.vendor_name || expense.description}</h1>
            <p className="text-sm text-[var(--text-secondary)]">{expense.payment_date} · Total {formatMoney(expense.amount, expense.currency)}</p>
          </div>
          {expense.receipt_url && (
            <Button variant="ghost" size="sm" onClick={() => setShowReceiptLightbox(true)} className="shrink-0">
              📄 View receipt
            </Button>
          )}
        </div>

        {overallProgress.isFullyAllocated && (
          <Badge variant="success">✓ Fully claimed</Badge>
        )}

        {isPayer && (
          <Button variant="secondary" size="sm" onClick={() => setOrganizerView((v) => !v)}>
            {organizerView ? 'Back to my claims' : 'View claim matrix'}
          </Button>
        )}

        {organizerView && isPayer ? (
          <ClaimMatrix expense={expense} lineItems={lineItems} claims={resolution.claims} participants={participants} />
        ) : (
          <>
            <div className="space-y-2">
              {lineItems.map((li) => {
                const claimsForLine = claimsByLine.get(li.id) || []
                const summary = summarizeLineClaims(li, claimsForLine, user?.id)
                const myQty = localSelections[li.id] ?? 0
                const maxQty = maxClaimableQuantity(summary)

                return (
                  <Card key={li.id} noPadding className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-[var(--text-primary)] truncate">
                          <span className="text-[var(--text-muted)] font-normal tabular-nums">{li.line_number}.</span>{' '}
                          {li.name_english || li.name_original}
                        </p>
                        {li.name_english && li.name_original && li.name_original !== li.name_english && (
                          // Original receipt text so people can match the app
                          // against the paper bill (any language).
                          <p className="text-xs text-[var(--text-secondary)] truncate">{li.name_original}</p>
                        )}
                        <p className="text-xs text-[var(--text-muted)]">
                          {formatMoney(li.total_amount, expense.currency)} · Available: {summary.available.toFixed(2)} / {li.quantity}
                        </p>
                      </div>

                      {!isReadOnly && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateQuantity(li.id, Math.max(0, myQty - 1))}
                            disabled={myQty <= 0}
                            className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="w-8 text-center text-sm tabular-nums">{myQty}</span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(li.id, Math.min(maxQty, myQty + 1))}
                            disabled={myQty >= maxQty}
                            className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                    {myQty > 0 && (
                      <p className="text-xs text-accent-700 dark:text-accent-400 font-medium mt-1.5">
                        You: {myQty}/{li.quantity} — {formatMoney(amountOwedForQuantity(li, myQty, expense.currency), expense.currency)}
                      </p>
                    )}
                  </Card>
                )
              })}
            </div>

            {!isReadOnly && (
              <div className="fixed bottom-0 left-0 right-0 bg-[var(--surface-raised)] border-t border-[var(--border-subtle)] p-4 pb-safe">
                <div className="max-w-lg mx-auto flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-xs text-[var(--text-muted)]">Your total</p>
                    <p className="font-semibold text-[var(--text-primary)]">{formatMoney(myTotal, expense.currency)}</p>
                  </div>
                  <Button variant="primary" onClick={handleSave} isLoading={saveClaims.isPending}>
                    Save my claims
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showReceiptLightbox && expense.receipt_url && (
        <ReceiptLightbox path={expense.receipt_url} title={expense.vendor_name || expense.description} onClose={() => setShowReceiptLightbox(false)} />
      )}
    </div>
  )
}
