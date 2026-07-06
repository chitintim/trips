import { useMemo, useState } from 'react'
import { Card, Button, Badge, EmptyState, Skeleton, UserAvatar, useToast, SegmentedControl } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants, useCurrentUserRow } from '../../../lib/queries/useTrip'
import {
  useSettlements,
  useRecordSettlement,
  useUpdateSettlementStatus,
  useFinalizeSettlementSnapshot,
  useCreateSettlementCarryover,
} from '../../../lib/queries/useSettlements'
import { useLogActivity } from '../../../lib/queries/useActivityFeed'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { formatMoney } from '../lib/formatMoney'
import { computeSuggestedPayments, readLegacySnapshot, buildSnapshot } from './settleUpLogic'
import { computeBalances } from '../lib/balances'
import { useCarryoverCandidates } from './useCarryoverCandidates'
import { PaymentDetailsSheet } from './PaymentDetailsSheet'
import { parsePaymentDetails, formatPaymentDetailsForCopy } from './paymentDetails'
import { buildExpenseLedgerCsv, buildSettlementSummaryCsv, downloadCsv } from '../lib/csvExport'
import type { Trip } from '../../../types'

export interface SettleUpTabProps {
  trip: Trip
}

/**
 * Settle Up v2 (plan §12): freeze flow, min-cash-flow suggestions (opt-in),
 * suggested -> marked_paid -> confirmed status flow, recipient payment
 * details card, CSV export, cross-trip carryover.
 */
export function SettleUpTab({ trip }: SettleUpTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: expensesData, isLoading } = useExpenses(trip.id)
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: settlements = [] } = useSettlements(trip.id)
  const { data: currentUserRow } = useCurrentUserRow(user?.id)

  const recordSettlement = useRecordSettlement(trip.id)
  const updateStatus = useUpdateSettlementStatus(trip.id)
  const finalizeSnapshot = useFinalizeSettlementSnapshot(trip.id)
  const createCarryover = useCreateSettlementCarryover(trip.id)
  const logActivity = useLogActivity(trip.id)
  const logTypedActivity = useTripActivityLog(trip.id)

  const [simplify, setSimplify] = useState(true)
  const [paymentDetailsOpen, setPaymentDetailsOpen] = useState(false)
  const { data: carryoverCandidates = [] } = useCarryoverCandidates(trip.id, user?.id)

  const expenses = expensesData?.expenses ?? []
  const people = participants.map((p) => ({ userId: p.user_id, name: p.user.full_name || p.user.email }))

  const isFrozen = !!trip.settlement_snapshot
  const legacySnapshot = useMemo(() => readLegacySnapshot(trip.settlement_snapshot), [trip.settlement_snapshot])

  const suggested = useMemo(
    () => (isFrozen ? [] : computeSuggestedPayments(expenses, settlements, people, trip.base_currency, simplify)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expenses, settlements, people, trip.base_currency, simplify, isFrozen]
  )

  const nameById = Object.fromEntries(people.map((p) => [p.userId, p.name]))

  const handleFreeze = async () => {
    if (!user) return
    const { balances } = computeBalances(expenses, settlements, people.map((p) => p.userId), trip.base_currency)
    const balancesMinor = new Map(balances.map((b) => [b.userId, b.netBalanceMinor]))
    const snapshot = buildSnapshot(suggested, people, balancesMinor, trip.base_currency)

    await finalizeSnapshot.mutateAsync({ snapshotData: snapshot, snapshotBy: user.id })
    await logActivity.mutateAsync({ actor: user.id, verb: 'froze_settlement', entity: { trip_id: trip.id }, metadata: { transaction_count: snapshot.transactions.length } })

    for (const t of suggested) {
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
  }

  const handleUnfreeze = async () => {
    if (!user) return
    await finalizeSnapshot.mutateAsync({ snapshotData: null, snapshotBy: user.id })
    await logActivity.mutateAsync({ actor: user.id, verb: 'unfroze_settlement', entity: { trip_id: trip.id } })
    showToast({ type: 'info', message: 'Settlement unfrozen — expenses can be edited again' })
  }

  const handleExportCsv = () => {
    const ledgerCsv = buildExpenseLedgerCsv(expenses, (id) => nameById[id] ?? id)
    const settlementCsv = buildSettlementSummaryCsv(settlements, (id) => nameById[id] ?? id)
    downloadCsv(`${trip.name.replace(/\s+/g, '_')}_expense_ledger.csv`, ledgerCsv)
    downloadCsv(`${trip.name.replace(/\s+/g, '_')}_settlement_summary.csv`, settlementCsv)
  }

  const handleFoldInCarryover = async (candidate: (typeof carryoverCandidates)[number]) => {
    if (!user) return
    const isOwedByOther = candidate.netAmount > 0
    await createCarryover.mutateAsync({
      source_trip_id: candidate.sourceTripId,
      from_user_id: isOwedByOther ? candidate.otherUserId : user.id,
      to_user_id: isOwedByOther ? user.id : candidate.otherUserId,
      amount: Math.abs(candidate.netAmount),
      currency: candidate.currency,
      created_by: user.id,
    })
    showToast({ type: 'success', message: 'Folded into this settlement' })
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
            <Button variant="ghost" size="sm" onClick={handleUnfreeze}>
              Unfreeze
            </Button>
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
          <Button variant="primary" fullWidth onClick={handleFreeze} disabled={suggested.length === 0}>
            Freeze balances & suggest payments
          </Button>
        </Card>
      )}

      {suggested.length === 0 && !isFrozen && (
        <EmptyState icon="✅" title="All settled up" description="Nobody owes anybody anything right now." />
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

          return (
            <Card key={s.id} noPadding className="p-3.5 space-y-2">
              <div className="flex items-center gap-3">
                <UserAvatar avatarData={recipient?.user.avatar_data} size="xs" alt={nameById[s.to_user_id] ?? ''} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {nameById[s.from_user_id] ?? 'Someone'} → {nameById[s.to_user_id] ?? 'someone'}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">{formatMoney(s.amount, s.currency ?? trip.base_currency)}</p>
                </div>

                <Badge variant={s.status === 'confirmed' ? 'success' : s.status === 'marked_paid' ? 'warning' : 'neutral'} size="sm">
                  {s.status}
                </Badge>

                {isMePaying && s.status === 'suggested' && (
                  <Button variant="secondary" size="sm" onClick={() => updateStatus.mutate({ settlementId: s.id, status: 'marked_paid' })}>
                    Mark paid
                  </Button>
                )}
                {isMeReceiving && s.status === 'marked_paid' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      updateStatus.mutate({ settlementId: s.id, status: 'confirmed' })
                      logTypedActivity({
                        verb: 'settlement_confirmed',
                        entity: { type: 'settlement', id: s.id, label: `${nameById[s.from_user_id] ?? 'Someone'} → ${nameById[s.to_user_id] ?? 'you'}` },
                      })
                    }}
                  >
                    Confirm received
                  </Button>
                )}
              </div>

              {isMePaying && s.status !== 'confirmed' && recipientDetails.rails.length > 0 && (
                <div className="pl-9 flex items-center gap-2 flex-wrap">
                  {recipientDetails.rails.map((r, i) => (
                    <span key={i} className="text-xs text-[var(--text-secondary)] bg-[var(--surface-sunken)] rounded-[var(--radius-full)] px-2 py-1">
                      {r.label}: {r.value}
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(formatPaymentDetailsForCopy(recipientDetails))}
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
              <Button variant="secondary" size="sm" onClick={() => handleFoldInCarryover(c)} className="shrink-0">
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
              onClick={() => navigator.clipboard.writeText(formatPaymentDetailsForCopy(myPaymentDetails))}
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
    </div>
  )
}
