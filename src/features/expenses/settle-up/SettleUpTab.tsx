import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, Button, Badge, EmptyState, Skeleton, UserAvatar, useToast, SegmentedControl } from '../../../components/ui'
import { AllSettled } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants, useCurrentUserRow } from '../../../lib/queries/useTrip'
import {
  useSettlements,
  useSettlementCarryovers,
  useRecordSettlement,
  useUpdateSettlementStatus,
  useFinalizeSettlementSnapshot,
  useCreateSettlementCarryover,
  useDeleteSettlement,
} from '../../../lib/queries/useSettlements'
import { useLogActivity } from '../../../lib/queries/useActivityFeed'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { formatMoney } from '../lib/formatMoney'
import {
  computeSuggestedPayments,
  readLegacySnapshot,
  buildSnapshot,
  computePendingMismatches,
  excludePendingPairs,
} from './settleUpLogic'
import { computeBalances, partitionCarryovers } from '../lib/balances'
import { useCarryoverCandidates } from './useCarryoverCandidates'
import { PaymentDetailsSheet } from './PaymentDetailsSheet'
import { MarkPaidSheet } from './MarkPaidSheet'
import { parsePaymentDetails, formatPaymentDetailsForCopy } from './paymentDetails'
import { buildExpenseLedgerCsv, buildSettlementSummaryCsv, downloadCsv } from '../lib/csvExport'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { Trip } from '../../../types'

export interface SettleUpTabProps {
  trip: Trip
}

/** Audit finding #8: the settlement status badge used to render the raw DB enum value (e.g. "marked_paid") straight into the UI -- human-readable copy for each status, falling back to the raw value for anything unrecognized. */
const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  suggested: 'Suggested',
  marked_paid: 'Marked paid',
  confirmed: 'Confirmed',
}

/**
 * Settle Up v2 (plan §12): freeze flow, min-cash-flow suggestions (opt-in),
 * suggested -> marked_paid -> confirmed status flow, recipient payment
 * details card, CSV export, cross-trip carryover.
 */
export function SettleUpTab({ trip }: SettleUpTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const { data: expensesData, isLoading: expensesLoading } = useExpenses(trip.id)
  const { data: participants = [], isLoading: participantsLoading } = useParticipants(trip.id)
  const { data: settlements = [], isLoading: settlementsLoading } = useSettlements(trip.id)
  // Already-folded cross-trip carryovers for THIS trip (as fold target) --
  // wired into computeSuggestedPayments/computeBalances below so a folded
  // debt actually changes what's owed here, not just the success toast.
  const { data: carryovers = [] } = useSettlementCarryovers(trip.id)
  const { data: currentUserRow, isLoading: currentUserRowLoading } = useCurrentUserRow(user?.id)
  // Audit finding #7: this used to gate on expenses' isLoading alone, so the
  // screen could render its balance-derived cards (which read participants/
  // settlements/currentUserRow too) with partially-loaded data on a slow
  // connection instead of the skeleton.
  const isLoading = expensesLoading || participantsLoading || settlementsLoading || currentUserRowLoading

  const recordSettlement = useRecordSettlement(trip.id)
  const updateStatus = useUpdateSettlementStatus(trip.id)
  const finalizeSnapshot = useFinalizeSettlementSnapshot(trip.id)
  const createCarryover = useCreateSettlementCarryover(trip.id)
  const deleteSettlement = useDeleteSettlement(trip.id)
  const logActivity = useLogActivity(trip.id)
  const logTypedActivity = useTripActivityLog(trip.id)

  const [simplify, setSimplify] = useState(true)
  const [paymentDetailsOpen, setPaymentDetailsOpen] = useState(false)
  const [markPaidTarget, setMarkPaidTarget] = useState<Settlement | null>(null)
  const [isFreezing, setIsFreezing] = useState(false)
  const [isUnfreezing, setIsUnfreezing] = useState(false)
  const { data: carryoverCandidates = [] } = useCarryoverCandidates(trip.id, user?.id)

  const expenses = expensesData?.expenses ?? []
  const people = participants.map((p) => ({ userId: p.user_id, name: p.user.full_name || p.user.email }))

  // Freeze/unfreeze gated to organizers (mirrors the derived-milestone
  // "Make it real" gating, commit a814b5e): a non-organizer's click used to
  // insert a full batch of settlement rows via the (organizer-unrestricted)
  // INSERT policy while the trips-row snapshot write silently no-op'd under
  // RLS, leaving the trip showing "not frozen" with duplicate-looking rows
  // underneath.
  const myParticipant = participants.find((p) => p.user_id === user?.id)
  const isOrganizer = myParticipant?.role === 'organizer'

  const isFrozen = !!trip.settlement_snapshot
  const legacySnapshot = useMemo(() => readLegacySnapshot(trip.settlement_snapshot), [trip.settlement_snapshot])

  const suggested = useMemo(
    () => (isFrozen ? [] : computeSuggestedPayments(expenses, settlements, people, trip.base_currency, simplify, carryovers)),
    [expenses, settlements, people, trip.base_currency, simplify, isFrozen, carryovers]
  )

  // Always computed (not gated by isFrozen, unlike `suggested` above) so a
  // 'marked_paid' row can be compared against what balances look like RIGHT
  // NOW, even while frozen -- expenses can still change pre-freeze and a
  // stale mark-paid amount needs to be caught either way.
  const liveSuggestedForComparison = useMemo(
    () => computeSuggestedPayments(expenses, settlements, people, trip.base_currency, simplify, carryovers),
    [expenses, settlements, people, trip.base_currency, simplify, carryovers]
  )

  // Pending (marked_paid) rows whose recorded amount no longer matches what
  // the live balances would suggest today -- e.g. an expense was edited
  // after the payer marked their payment paid. Never auto-corrected; just
  // surfaced so an organizer can review before the payee confirms.
  const pendingMismatchByPair = useMemo(
    () => computePendingMismatches(settlements, liveSuggestedForComparison, trip.base_currency),
    [settlements, liveSuggestedForComparison, trip.base_currency]
  )

  const nameById = Object.fromEntries(people.map((p) => [p.userId, p.name]))

  // Same partition computeBalances/computeSuggestedPayments apply
  // internally -- recomputed here only to tell the user when folded rows
  // were EXCLUDED from the math (different currency, or a party no longer
  // on this trip). Money is never silently dropped.
  const carryoverPartition = useMemo(
    () => partitionCarryovers(carryovers, trip.base_currency, people.map((p) => p.userId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [carryovers, trip.base_currency, participants]
  )
  const excludedCarryoverCount = carryoverPartition.excludedCurrency.length + carryoverPartition.excludedParticipant.length

  const handleFreeze = async () => {
    if (!user) return
    setIsFreezing(true)
    try {
      const { balances } = computeBalances(expenses, settlements, people.map((p) => p.userId), trip.base_currency, carryovers)
      const balancesMinor = new Map(balances.map((b) => [b.userId, b.netBalanceMinor]))
      const snapshot = buildSnapshot(suggested, people, balancesMinor, trip.base_currency)

      await finalizeSnapshot.mutateAsync({ snapshotData: snapshot, snapshotBy: user.id })
      await logActivity.mutateAsync({ actor: user.id, verb: 'froze_settlement', entity: { trip_id: trip.id }, metadata: { transaction_count: snapshot.transactions.length } })

      // Clear any previously suggested (never acted on) settlements first --
      // an unfreeze -> edit expenses -> freeze-again cycle used to insert a
      // second batch of 'suggested' rows alongside the stale first batch,
      // both rendered in the list below with no way to tell them apart.
      // marked_paid/confirmed rows are real payment history and are never
      // touched here. A delete can now fail loudly under RLS (see
      // useDeleteSettlement) instead of silently no-op'ing -- collect
      // failures and warn rather than proceeding as if cleanup succeeded.
      const staleSuggested = settlements.filter((s) => s.status === 'suggested')
      const deleteFailures: string[] = []
      for (const s of staleSuggested) {
        try {
          await deleteSettlement.mutateAsync(s.id)
        } catch {
          deleteFailures.push(s.id)
        }
      }
      if (deleteFailures.length > 0) {
        showToast({
          type: 'error',
          message: 'Could not clear some old suggested payments',
          description: 'They may still show below — try freezing again.',
        })
      }

      // Never re-suggest a pair that already has a pending 'marked_paid'
      // row -- that payment is real history awaiting confirmation, not
      // something to duplicate. pendingMismatchByPair (rendered per-card
      // below) surfaces it instead if the live amount has since drifted.
      const toInsert = excludePendingPairs(suggested, settlements)
      for (const t of toInsert) {
        await recordSettlement.mutateAsync({
          from_user_id: t.from,
          to_user_id: t.to,
          amount: t.amount,
          currency: trip.base_currency,
          status: 'suggested',
          created_by: user.id,
          settled_at: new Date().toISOString(),
        })
      }
      showToast({ type: 'success', message: 'Balances frozen — suggested payments created' })
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to freeze balances', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsFreezing(false)
    }
  }

  const handleUnfreeze = async () => {
    if (!user) return
    setIsUnfreezing(true)
    try {
      await finalizeSnapshot.mutateAsync({ snapshotData: null, snapshotBy: user.id })
      await logActivity.mutateAsync({ actor: user.id, verb: 'unfroze_settlement', entity: { trip_id: trip.id } })
      showToast({ type: 'info', message: 'Settlement unfrozen — expenses can be edited again' })
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to unfreeze balances', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsUnfreezing(false)
    }
  }

  const handleExportCsv = () => {
    const ledgerCsv = buildExpenseLedgerCsv(expenses, (id) => nameById[id] ?? id)
    const settlementCsv = buildSettlementSummaryCsv(settlements, (id) => nameById[id] ?? id)
    downloadCsv(`${trip.name.replace(/\s+/g, '_')}_expense_ledger.csv`, ledgerCsv)
    downloadCsv(`${trip.name.replace(/\s+/g, '_')}_settlement_summary.csv`, settlementCsv)
  }

  /** Audit finding #6: both payment-details "Copy" buttons called navigator.clipboard.writeText fire-and-forget, so a permission-denied/insecure-context failure just silently did nothing -- mirrors Dashboard.tsx's copyLink pattern. */
  const copyPaymentDetails = async (details: ReturnType<typeof parsePaymentDetails>) => {
    try {
      await navigator.clipboard.writeText(formatPaymentDetailsForCopy(details))
      showToast({ type: 'success', message: 'Copied to clipboard' })
    } catch {
      showToast({ type: 'error', message: 'Could not copy to clipboard' })
    }
  }

  const handleFoldInCarryover = async (candidate: (typeof carryoverCandidates)[number]) => {
    if (!user) return
    const isOwedByOther = candidate.netAmount > 0
    try {
      await createCarryover.mutateAsync({
        source_trip_id: candidate.sourceTripId,
        from_user_id: isOwedByOther ? candidate.otherUserId : user.id,
        to_user_id: isOwedByOther ? user.id : candidate.otherUserId,
        amount: Math.abs(candidate.netAmount),
        currency: candidate.currency,
        created_by: user.id,
      })
      showToast({ type: 'success', message: 'Folded into this settlement' })
    } catch (err) {
      // Postgres unique violation (23505, surfaced as PostgrestError.code)
      // on the (source_trip_id, from_user_id, to_user_id) unique index
      // means this pair's debt was ALREADY folded -- possibly into another
      // trip's settlement, or by a second organizer racing this click. The
      // candidate list is stale: refresh it so the offer disappears instead
      // of inviting endlessly-failing retries.
      const code = (err as { code?: string } | null)?.code
      if (code === '23505') {
        showToast({
          type: 'info',
          message: 'Already folded',
          description: 'This balance was already folded into a settlement — refreshing the list.',
        })
        queryClient.invalidateQueries({ queryKey: ['carryoverCandidates'] })
      } else {
        showToast({
          type: 'error',
          message: 'Could not fold in this balance',
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
  }

  if (isLoading) {
    return <Skeleton variant="list" lines={4} />
  }

  const myPaymentDetails = parsePaymentDetails(currentUserRow?.payment_details)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Settle up</h2>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPaymentDetailsOpen(true)}>
            My payment details
          </Button>
          <Button variant="secondary" size="sm" onClick={handleExportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {legacySnapshot && !isFrozen && (
        <Card variant="sunken" noPadding className="p-3.5">
          <p className="text-sm text-[var(--text-secondary)]">A previous settlement was recorded for this trip (legacy).</p>
        </Card>
      )}

      {isFrozen ? (
        <Card noPadding className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Badge variant="info">🔒 Balances frozen</Badge>
            {isOrganizer ? (
              <Button variant="ghost" size="sm" onClick={handleUnfreeze} disabled={isUnfreezing} isLoading={isUnfreezing}>
                Unfreeze
              </Button>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">Ask an organizer to unfreeze</span>
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Expense edits are blocked while frozen. Unfreezing is audit-logged to the activity feed.
          </p>
        </Card>
      ) : (
        <Card noPadding className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--text-primary)]">Minimize payments</span>
            <SegmentedControl
              size="sm"
              value={simplify ? 'on' : 'off'}
              onChange={(v) => setSimplify(v === 'on')}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </div>
          {isOrganizer ? (
            <Button variant="primary" fullWidth onClick={handleFreeze} disabled={suggested.length === 0 || isFreezing} isLoading={isFreezing}>
              Freeze balances & suggest payments
            </Button>
          ) : (
            <p className="text-sm text-center text-[var(--text-muted)] py-2">Ask an organizer to freeze balances</p>
          )}
        </Card>
      )}

      {suggested.length === 0 && !isFrozen && (
        <EmptyState
          icon={<AllSettled className="w-32 h-24 text-success-500" />}
          title="All settled up"
          description="Nobody owes anybody anything right now."
        />
      )}

      {!isFrozen && suggested.length > 0 && (
        <Card noPadding className="p-4 space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Suggested payments {simplify ? `(${suggested.length} min.)` : ''}
          </h3>
          {suggested.map((t, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-secondary)]">
                {t.fromName} → {t.toName}
              </span>
              <span className="font-medium tabular-nums">{formatMoney(t.amount, trip.base_currency)}</span>
            </div>
          ))}
          <p className="text-xs text-[var(--text-muted)] pt-1">Freeze balances to turn these into trackable payments.</p>
        </Card>
      )}

      <div className="space-y-2">
        {settlements.map((s) => {
          const isMePaying = s.from_user_id === user?.id
          const isMeReceiving = s.to_user_id === user?.id
          const recipient = participants.find((p) => p.user_id === s.to_user_id)
          const recipientDetails = recipient ? parsePaymentDetails(recipient.user.payment_details) : { rails: [] }
          const fromName = nameById[s.from_user_id] ?? 'Someone'
          const toName = nameById[s.to_user_id] ?? 'someone'
          const paidDate = new Date(s.settled_at).toLocaleDateString()
          const mismatchAmount = pendingMismatchByPair.get(s.id)

          // Bug #14: a bare status badge told nobody what it meant or whose
          // turn it was next. One caption per status/viewer, mirroring the
          // payment-details line's placement.
          let caption: string | null = null
          if (s.status === 'suggested') {
            caption = isMePaying ? "Still owed — mark it paid once you've sent the money." : isMeReceiving ? `Waiting for ${fromName} to pay.` : null
          } else if (s.status === 'marked_paid') {
            caption = isMePaying
              ? `You marked this paid on ${paidDate}${s.payment_method ? ` via ${s.payment_method}` : ''} — waiting for ${toName} to confirm.`
              : isMeReceiving
              ? `${fromName} marked this paid on ${paidDate}${s.payment_method ? ` via ${s.payment_method}` : ''} — confirm once you've received it.`
              : null
          } else if (s.status === 'confirmed') {
            caption = 'Confirmed — payment complete.'
          }

          return (
            <Card key={s.id} noPadding className="p-3.5 space-y-2">
              <div className="flex items-center gap-3">
                <UserAvatar avatarData={recipient?.user} size="xs" alt={toName} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {fromName} → {toName}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">{formatMoney(s.amount, s.currency ?? trip.base_currency)}</p>
                </div>

                <Badge variant={s.status === 'confirmed' ? 'success' : s.status === 'marked_paid' ? 'warning' : 'neutral'} size="sm">
                  {SETTLEMENT_STATUS_LABELS[s.status] ?? s.status}
                </Badge>

                {isMePaying && s.status === 'suggested' && (
                  <Button variant="secondary" size="sm" onClick={() => setMarkPaidTarget(s)}>
                    Mark paid
                  </Button>
                )}
                {isMeReceiving && s.status === 'marked_paid' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      updateStatus.mutate(
                        { settlementId: s.id, status: 'confirmed' },
                        {
                          // Bug #8: this used to fire unconditionally
                          // alongside the mutate call instead of gated on
                          // its success, so the activity feed could record
                          // "confirmed" even when the write was silently
                          // rejected by RLS. Matches the onSuccess-gated
                          // convention already used in useConfirmations.ts.
                          onSuccess: () =>
                            logTypedActivity({
                              verb: 'settlement_confirmed',
                              entity: { type: 'settlement', id: s.id, label: `${fromName} → ${toName}` },
                            }),
                          onError: (err) =>
                            showToast({ type: 'error', message: 'Failed to confirm payment', description: err instanceof Error ? err.message : undefined }),
                        }
                      )
                    }
                  >
                    Confirm received
                  </Button>
                )}
              </div>

              {(s.payment_method || s.notes) && s.status !== 'suggested' && (
                <p className="text-xs text-[var(--text-muted)] pl-9">
                  Paid via {s.payment_method ?? 'an unspecified method'} on {paidDate}
                  {s.notes ? ` — "${s.notes}"` : ''}
                </p>
              )}

              {caption && <p className="text-xs text-[var(--text-muted)] pl-9 pt-0.5">{caption}</p>}

              {s.status === 'marked_paid' && mismatchAmount !== undefined && (
                <p className="text-xs text-warn-700 dark:text-warn-300 pl-9 pt-0.5">
                  ⚠️ Expenses changed since this was marked paid — the current balance suggests{' '}
                  {formatMoney(mismatchAmount, s.currency ?? trip.base_currency)} instead of {formatMoney(s.amount, s.currency ?? trip.base_currency)}.
                  This record is kept — an organizer should review before confirming.
                </p>
              )}

              {isMePaying && s.status !== 'confirmed' && recipientDetails.rails.length > 0 && (
                <div className="pl-9 flex items-center gap-2 flex-wrap">
                  {recipientDetails.rails.map((r, i) => (
                    <span key={i} className="text-xs text-[var(--text-secondary)] bg-[var(--surface-sunken)] rounded-[var(--radius-full)] px-2 py-1">
                      {r.label}: {r.value}
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => copyPaymentDetails(recipientDetails)}
                    className="text-xs font-medium text-accent-700 dark:text-accent-400"
                  >
                    Copy
                  </button>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {carryovers.length > 0 && (
        <Card variant="sunken" noPadding className="p-4 space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Carried over from other trips</h3>
          {carryovers.map((c) => {
            const isExcluded =
              carryoverPartition.excludedCurrency.some((e) => e.id === c.id) ||
              carryoverPartition.excludedParticipant.some((e) => e.id === c.id)
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-[var(--text-secondary)] truncate">
                  {nameById[c.from_user_id] ?? 'Someone'} → {nameById[c.to_user_id] ?? 'someone'}
                  {isExcluded && (
                    <Badge variant="warning" size="sm" className="ml-2">
                      not included
                    </Badge>
                  )}
                </span>
                <span className="font-medium tabular-nums">{formatMoney(c.amount, c.currency)}</span>
              </div>
            )
          })}
          {excludedCarryoverCount > 0 ? (
            <p className="text-xs text-[var(--text-muted)] pt-1">
              ⚠️ {excludedCarryoverCount} carryover{excludedCarryoverCount === 1 ? " isn't" : "s aren't"} included in the
              balances above{carryoverPartition.excludedCurrency.length > 0 ? ' (different currency' : ' ('}
              {carryoverPartition.excludedCurrency.length > 0 && carryoverPartition.excludedParticipant.length > 0 ? '; ' : ''}
              {carryoverPartition.excludedParticipant.length > 0 ? 'a person involved is no longer on this trip' : ''})
            </p>
          ) : (
            <p className="text-xs text-[var(--text-muted)] pt-1">Included in the balances and suggested payments above.</p>
          )}
        </Card>
      )}

      {carryoverCandidates.length > 0 && (
        <Card noPadding className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Unsettled from other trips</h3>
          {carryoverCandidates.map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">
                  {c.otherUserName} · {c.sourceTripName}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {c.netAmount >= 0 ? 'Owed to you' : 'You owe'}: {formatMoney(Math.abs(c.netAmount), c.currency)}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleFoldInCarryover(c)}
                disabled={createCarryover.isPending}
                isLoading={createCarryover.isPending}
                className="shrink-0"
              >
                Fold in
              </Button>
            </div>
          ))}
        </Card>
      )}

      <Card variant="sunken" noPadding className="p-3.5">
        <p className="text-sm font-medium text-[var(--text-primary)] mb-1">Your payment details</p>
        {myPaymentDetails.rails.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Not set — add your payment methods so people know how to pay you.</p>
        ) : (
          <div className="space-y-1">
            {myPaymentDetails.rails.map((r, i) => (
              <p key={i} className="text-sm text-[var(--text-secondary)]">
                {r.label}: {r.value}
              </p>
            ))}
            <button
              type="button"
              onClick={() => copyPaymentDetails(myPaymentDetails)}
              className="text-xs font-medium text-accent-700 dark:text-accent-400 mt-1"
            >
              Copy
            </button>
          </div>
        )}
      </Card>

      <PaymentDetailsSheet
        isOpen={paymentDetailsOpen}
        onClose={() => setPaymentDetailsOpen(false)}
        currentPaymentDetails={currentUserRow?.payment_details}
      />

      <MarkPaidSheet
        isOpen={!!markPaidTarget}
        onClose={() => setMarkPaidTarget(null)}
        settlement={markPaidTarget}
        tripId={trip.id}
        toName={markPaidTarget ? nameById[markPaidTarget.to_user_id] ?? 'them' : ''}
      />
    </div>
  )
}
