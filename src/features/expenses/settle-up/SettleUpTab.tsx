import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, Button, Badge, EmptyState, Skeleton, UserAvatar, useToast, SegmentedControl } from '../../../components/ui'
import { AllSettled } from '../../../components/ui/illustrations'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses, type ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import { useParticipants, useAllParticipants, useCurrentUserRow } from '../../../lib/queries/useTrip'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import {
  useSettlements,
  fetchSettlements,
  useSettlementCarryovers,
  useUpdateSettlementStatus,
  useFreezeSettlements,
  useUnfreezeSettlements,
  useCreateSettlementCarryover,
  useSettleOnBehalf,
} from '../../../lib/queries/useSettlements'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useActivityFeed } from '../../../lib/queries/useActivityFeed'
import { formatMoney } from '../lib/formatMoney'
import {
  computeSuggestedPayments,
  computeRemainingSuggestions,
  readLegacySnapshot,
  buildSnapshot,
  computePendingMismatches,
  dedupeTransactions,
  findDuplicatePayments,
  unresolvedDuplicateGroups,
} from './settleUpLogic'
import { DuplicatePaymentsNotice } from './DuplicatePaymentsNotice'
import { buildFreezeSuggestions, knownPaidIds, partitionStaleSuggested, PREVIOUS_FREEZE_LABEL, FREEZE_BLOCKED_BY_DUPLICATES, UNFREEZE_BLOCKED_BY_DUPLICATES } from './settlementFreeze'
import { displayNames } from '../claims/claimNames'
import { computeBalances, findFreezeBlockingReceipts, partitionCarryovers } from '../lib/balances'
import { buildSettleUpPeople, LEFT_TRIP_SUFFIX } from './settleUpPeople'
import { useCarryoverCandidates } from './useCarryoverCandidates'
import {
  onBehalfActions,
  buildSettleAllList,
  canOfferSettleAll,
  isEverythingSettled,
  onBehalfRecordsBySettlement,
  onBehalfLabel,
  summariseBatch,
  type BatchOutcome,
  type OnBehalfAction,
} from './settleOnBehalf'
import { paymentNoticeBySettlement, paymentNoticeLines } from './paymentNoticeStatus'
import { OnBehalfMenu } from './OnBehalfMenu'
import { DisputeActions } from './DisputeActions'
import { DISPUTED_PAYMENT_PAUSE, disputedPayments, disputeSupported, disputeView, reAsksUsed } from './paymentDispute'
import { SettleAllDialog } from './SettleAllDialog'
import { UnclaimedReceiptsNotice } from './UnclaimedReceiptsNotice'
import { FreezeUnclaimedDialog, type ReceiptCandidate } from './FreezeUnclaimedDialog'
import { describeWriteError } from '../../../lib/writeRefusals'
import { freezeGate, isOverclaimedReceiptsError, isUnclaimedReceiptsError, parseServerReceiptDetail, receiptsForNotice, type ServerReceiptReport } from './unclaimedReceipts'
import { PaymentDetailsSheet } from './PaymentDetailsSheet'
import { MarkPaidSheet } from './MarkPaidSheet'
import { parsePaymentDetails, formatPaymentDetailsForCopy } from './paymentDetails'
import { buildExpenseLedgerCsv, buildSettlementSummaryCsv, downloadCsv } from '../lib/csvExport'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { Trip } from '../../../types'

export interface SettleUpTabProps {
  /** `?open=payment:<id>` for the receiver: scroll to that payment and highlight its "Confirm received" row (nothing is confirmed automatically). */
  initialConfirmId?: string
  /** Scroll to the "recorded twice" notice (the Money header's hint). */
  focusDuplicates?: boolean
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
export function SettleUpTab({ trip, initialConfirmId, focusDuplicates }: SettleUpTabProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const { data: expensesData, isLoading: expensesLoading } = useExpenses(trip.id)
  const { data: participants = [], isLoading: participantsLoading } = useParticipants(trip.id)
  // Includes removed people (active=false) so anyone who left with expense history can still be named.
  const { data: allParticipants = [], isLoading: allParticipantsLoading } = useAllParticipants(trip.id)
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
  const isLoading = expensesLoading || participantsLoading || allParticipantsLoading || settlementsLoading || currentUserRowLoading

  useEffect(() => {
    if (!initialConfirmId || isLoading) return
    let off: ReturnType<typeof setTimeout> | undefined
    const el = document.getElementById(`settlement-${initialConfirmId}`)
    const ring = ['ring-2', 'ring-accent-500']
    const on = setTimeout(() => {
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add(...ring)
      off = setTimeout(() => el.classList.remove(...ring), 2200)
    }, 150)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
      el?.classList.remove(...ring)
    }
  }, [initialConfirmId, isLoading])

  useEffect(() => {
    if (!focusDuplicates || isLoading) return
    const on = setTimeout(() => document.getElementById('duplicate-payments')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150)
    return () => clearTimeout(on)
  }, [focusDuplicates, isLoading])

  const updateStatus = useUpdateSettlementStatus(trip.id)
  const freezeSettlements = useFreezeSettlements(trip.id)
  const unfreezeSettlements = useUnfreezeSettlements(trip.id)
  const createCarryover = useCreateSettlementCarryover(trip.id)
  const logTypedActivity = useTripActivityLog(trip.id)
  const settleOnBehalf = useSettleOnBehalf(trip.id)
  const { data: activityEntries = [] } = useActivityFeed(trip.id)

  const [simplify, setSimplify] = useState(true)
  const [paymentDetailsOpen, setPaymentDetailsOpen] = useState(false)
  const [markPaidTargetId, setMarkPaidTargetId] = useState<string | null>(null)
  const [isFreezing, setIsFreezing] = useState(false)
  const [unclaimedDialogOpen, setUnclaimedDialogOpen] = useState(false)
  const [serverRefusedUnclaimed, setServerRefusedUnclaimed] = useState(false)
  const [serverReport, setServerReport] = useState<ServerReceiptReport | null>(null)
  const [settleAllOpen, setSettleAllOpen] = useState(false)
  const [settleAllRunning, setSettleAllRunning] = useState(false)
  const [settleAllOutcome, setSettleAllOutcome] = useState<BatchOutcome | null>(null)
  const [isUnfreezing, setIsUnfreezing] = useState(false)
  const { data: carryoverCandidates = [] } = useCarryoverCandidates(trip.id, user?.id)

  const expenses = useMemo(() => expensesData?.expenses ?? [], [expensesData])
  // Everyone who appears in the money, not just the active roster: someone
  // removed earlier (or via the API) with expense history keeps their
  // balance and is shown as "left the trip", so the ledger always sums to zero.
  const people = useMemo(
    () => buildSettleUpPeople({ expenses, settlements, carryovers, baseCurrency: trip.base_currency, active: participants, all: allParticipants }),
    [expenses, settlements, carryovers, trip.base_currency, participants, allParticipants]
  )
  const leftPeople = people.filter((p) => p.left)
  // The live row (not a copy taken at tap time) so the sheet sees it move on.
  const markPaidTarget: Settlement | null = settlements.find((s) => s.id === markPaidTargetId) ?? null
  const duplicatePayments = useMemo(() => findDuplicatePayments(settlements, trip.base_currency), [settlements, trip.base_currency])
  // Freeze is blocked (here and in the server function) while a payment recorded twice is unresolved.
  const freezeBlockedByDuplicates = useMemo(() => unresolvedDuplicateGroups(settlements, trip.base_currency).length > 0, [settlements, trip.base_currency])

  // Freeze and Unfreeze (which leads to a refreeze) are also paused while a payment is flagged "hasn't arrived": a flagged
  // payment still counts as sent, so a refreeze would hide it (see disputedPayments). UI guard only; the freeze RPCs are unchanged.
  const disputedList = useMemo(() => disputedPayments(settlements), [settlements])
  const freezeBlockedByDisputes = disputedList.length > 0
  const showFirstDisputed = () => document.getElementById(`settlement-${disputedList[0]?.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })

  // Freeze/unfreeze: trip organiser, creator or site admin (one shared rule,
  // see useTripPermissions). The trips-row snapshot write is RLS-protected, so
  // a non-manager's click used to insert a batch of settlement rows while the
  // snapshot write silently no-op'd.
  // NOTE: the settlements UPDATE and settlement_carryovers INSERT RLS policies use
  // is_trip_organizer() only, so a site admin who is not on the roster can freeze but
  // may be rejected on those writes; we deliberately do not add UI for them.
  // Folding in is organiser-only in the database, so it follows isTripOrganizer, not canManageTrip.
  const { canManageTrip, isTripOrganizer } = useTripPermissions(trip)

  const isFrozen = !!trip.settlement_snapshot

  // Receipts with items nobody has claimed: counted as the payer's own share until shared (balances.ts), and the
  // server refuses to freeze over them (the share/assign function is live), so the freeze opens a dialog first.
  const blockingReceipts = useMemo(() => findFreezeBlockingReceipts(expenses, trip.base_currency), [expenses, trip.base_currency])
  const noticeReceipts = useMemo(() => (isFrozen ? [] : receiptsForNotice(blockingReceipts, user?.id, canManageTrip)), [isFrozen, blockingReceipts, user?.id, canManageTrip])
  const legacySnapshot = useMemo(() => readLegacySnapshot(trip.settlement_snapshot), [trip.settlement_snapshot])

  const suggested = useMemo(
    () => (isFrozen ? [] : computeRemainingSuggestions(expenses, settlements, people, trip.base_currency, simplify, carryovers)),
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

  const nameById = Object.fromEntries(people.map((p) => [p.userId, p.left ? `${p.name}${LEFT_TRIP_SUFFIX}` : p.name]))
  // Short names for the freeze dialog (first name; a bit more only when two people share one, same rule as the claim screens).
  const shortNames = useMemo(() => displayNames(people.map((p) => ({ id: p.userId, fullName: p.name }))), [people])
  const shortNameOf = (id: string) => {
    const label = shortNames.get(id)?.label
    return label ? (people.find((p) => p.userId === id)?.left ? `${label}${LEFT_TRIP_SUFFIX}` : label) : (nameById[id] ?? 'Someone')
  }
  // Unfreezing leaves the old `suggested` rows in place until the next freeze replaces them: while unfrozen they are not current.
  const { current: currentSettlements, fromLastFreeze } = useMemo(() => partitionStaleSuggested(settlements, isFrozen), [settlements, isFrozen])

  const settleAllList = useMemo(
    () => buildSettleAllList(settlements, (id) => nameById[id] ?? 'Someone', trip.base_currency),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settlements, trip.base_currency, people]
  )
  const onBehalfRecords = useMemo(() => onBehalfRecordsBySettlement(activityEntries), [activityEntries])
  // Who may legitimately have asked for a receipt: active organizers and the trip creator (the payer is checked per payment).
  const managerIds = useMemo(
    () => new Set<string>([...participants.filter((p) => p.role === 'organizer' && p.active).map((p) => p.user_id), ...(trip.created_by ? [trip.created_by] : [])]),
    [participants, trip.created_by]
  )
  const noticeInfo = useMemo(() => paymentNoticeBySettlement(activityEntries, settlements, managerIds), [activityEntries, settlements, managerIds])
  const disputeOn = disputeSupported(settlements)
  const everythingSettled = isEverythingSettled(currentSettlements) && (isFrozen || suggested.length === 0)

  const recordOnBehalf = async (s: Settlement, to: 'marked_paid' | 'confirmed', batch = false) => {
    if (!user) throw new Error('Not signed in')
    return settleOnBehalf.mutateAsync({
      settlement: s,
      to,
      actorId: user.id,
      payerName: nameById[s.from_user_id] ?? 'Someone',
      receiverName: nameById[s.to_user_id] ?? 'someone',
      batch,
    })
  }

  const handleOnBehalf = async (s: Settlement, action: OnBehalfAction) => {
    try {
      const res = await recordOnBehalf(s, action.to)
      showToast(
        res.logged
          ? { type: 'success', message: 'Payment recorded', description: 'Logged under your name.' }
          : { type: 'warning', message: 'Payment recorded', description: "It couldn't be written to the activity log." }
      )
    } catch (err) {
      showToast({ type: 'error', message: 'Could not record this payment', description: err instanceof Error ? err.message : undefined })
    }
  }

  const handleSettleAll = async () => {
    setSettleAllRunning(true)
    const outcome: BatchOutcome = { done: [], failed: [] }
    try {
      // Re-read first so the list acted on is the live one, not a stale screen.
      const fresh = await fetchSettlements(trip.id)
      queryClient.setQueryData(queryKeys.settlements(trip.id), fresh)
      if (unresolvedDuplicateGroups(fresh, trip.base_currency).length > 0) throw new Error(FREEZE_BLOCKED_BY_DUPLICATES)
      for (const s of fresh.filter((r) => r.status === 'suggested' || r.status === 'marked_paid')) {
        try {
          await recordOnBehalf(s, 'confirmed', true)
          outcome.done.push(s.id)
        } catch (err) {
          outcome.failed.push({ id: s.id, message: err instanceof Error ? err.message : 'Failed' })
        }
      }
    } catch (err) {
      showToast({ type: 'error', message: 'Could not settle the payments', description: err instanceof Error ? err.message : undefined })
      setSettleAllRunning(false)
      return
    }
    setSettleAllRunning(false)
    setSettleAllOutcome(outcome)
    const summary = summariseBatch(outcome)
    showToast({ type: summary.tone, message: summary.message })
    if (outcome.failed.length === 0) setSettleAllOpen(false)
  }

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

  /** The people a receipt's leftovers can go to: those tagged on it, else everyone currently on the trip. */
  const candidatesFor = (expenseId: string): ReceiptCandidate[] => {
    const e = expenses.find((x) => x.id === expenseId)
    const tagged = e?.participant_ids && e.participant_ids.length > 0 ? new Set(e.participant_ids) : null
    return people.filter((p) => !p.left && (!tagged || tagged.has(p.userId))).map((p) => ({ userId: p.userId, name: p.name }))
  }

  /** The Freeze button: with unclaimed receipts (and the share function live) it opens the dialog instead of freezing. */
  const handleFreezeClick = () => {
    const gate = freezeGate(blockingReceipts)
    if (gate.kind === 'dialog') {
      setServerRefusedUnclaimed(false)
      setServerReport(null)
      setUnclaimedDialogOpen(true)
      return
    }
    void handleFreeze()
  }

  /** After every receipt's leftovers were placed: re-read the expenses, then freeze on the fresh figures. */
  const handleLeftoversShared = async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.expenses(trip.id), exact: true })
    const fresh = queryClient.getQueryData<{ expenses: ExpenseWithDetails[] }>(queryKeys.expenses(trip.id))?.expenses ?? expenses
    if (findFreezeBlockingReceipts(fresh, trip.base_currency).length > 0) {
      showToast({ type: 'warning', message: 'Some receipts still have unclaimed items', description: 'Choose what happens to the rest, then try again.' })
      return
    }
    setUnclaimedDialogOpen(false)
    const freshPeople = buildSettleUpPeople({ expenses: fresh, settlements, carryovers, baseCurrency: trip.base_currency, active: participants, all: allParticipants })
    await handleFreeze(fresh, freshPeople)
  }

  /** The server report's "Refresh": reload the expenses (claims) and settlements, then let the user try again from fresh figures. */
  const handleRefreshAfterRefusal = async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: queryKeys.expenses(trip.id), exact: true }),
      queryClient.refetchQueries({ queryKey: queryKeys.settlements(trip.id), exact: true }),
    ])
    const fresh = queryClient.getQueryData<{ expenses: ExpenseWithDetails[] }>(queryKeys.expenses(trip.id))?.expenses ?? expenses
    setServerReport(null)
    if (findFreezeBlockingReceipts(fresh, trip.base_currency).length === 0) {
      setUnclaimedDialogOpen(false)
      showToast({ type: 'info', message: 'Refreshed', description: 'Try freezing again.' })
    }
  }

  const handleFreeze = async (expensesNow: ExpenseWithDetails[] = expenses, peopleNow = people) => {
    if (!user) return
    setIsFreezing(true)
    try {
      // Re-read the settlements right now rather than trusting the cached
      // list: a second organizer or tab may have just marked a payment paid
      // or frozen already, and the suggestions below must account for it.
      const freshSettlements = await fetchSettlements(trip.id)
      queryClient.setQueryData(queryKeys.settlements(trip.id), freshSettlements)
      if (unresolvedDuplicateGroups(freshSettlements, trip.base_currency).length > 0) throw new Error(FREEZE_BLOCKED_BY_DUPLICATES)
      if (disputedPayments(freshSettlements).length > 0) throw new Error(DISPUTED_PAYMENT_PAUSE)

      // Payments already marked paid (or confirmed) are taken into account:
      // only what is STILL owed is suggested, so a freeze never re-creates a
      // payment the payer has already sent.
      const toInsert = dedupeTransactions(
        computeRemainingSuggestions(expensesNow, freshSettlements, peopleNow, trip.base_currency, simplify, carryovers)
      )
      const { balances } = computeBalances(expensesNow, freshSettlements, peopleNow.map((p) => p.userId), trip.base_currency, carryovers)
      const balancesMinor = new Map(balances.map((b) => [b.userId, b.netBalanceMinor]))
      const snapshot = buildSnapshot(toInsert, peopleNow, balancesMinor, trip.base_currency)

      // One atomic write (snapshot + replace the 'suggested' rows).
      await freezeSettlements.mutateAsync({
        snapshot,
        suggestions: buildFreezeSuggestions(toInsert, trip.base_currency),
        knownPaidIds: knownPaidIds(freshSettlements),
      })
      // Settle everything before anything is shown as done: the trip's freeze state, the new payment rows and the expenses (the Money
      // header reads its payments from the expenses query) must all be of the same generation, or the header briefly claims the
      // balances changed since they were frozen.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: queryKeys.settlements(trip.id), exact: true }),
        queryClient.refetchQueries({ queryKey: queryKeys.expenses(trip.id), exact: true }),
        queryClient.refetchQueries({ queryKey: queryKeys.tripDetail(trip.id), exact: true }),
      ])
      showToast({ type: 'success', message: 'Balances frozen — suggested payments created' })
    } catch (err) {
      const overclaimed = isOverclaimedReceiptsError(err)
      if (isUnclaimedReceiptsError(err) && blockingReceipts.length > 0) {
        // The server's guard caught receipts the screen did not (or the list changed): same dialog, not an error toast.
        setServerRefusedUnclaimed(true)
        setServerReport(null)
        setUnclaimedDialogOpen(true)
      } else if (overclaimed || isUnclaimedReceiptsError(err)) {
        // The server and the screen disagree (the screen has nothing to offer): never a bare error toast. Show what the server
        // reported, from the error's DETAIL, with a Refresh that reloads the latest claims.
        setServerRefusedUnclaimed(true)
        setServerReport({ kind: overclaimed ? 'overclaimed' : 'unclaimed', items: parseServerReceiptDetail(err) })
        setUnclaimedDialogOpen(true)
      } else {
        showToast({ type: 'error', message: 'Failed to freeze balances', description: describeWriteError(err) })
      }
    } finally {
      setIsFreezing(false)
    }
  }

  const handleUnfreeze = async () => {
    if (!user || freezeBlockedByDuplicates || freezeBlockedByDisputes) return
    setIsUnfreezing(true)
    try {
      await unfreezeSettlements.mutateAsync()
      showToast({ type: 'info', message: 'Settlement unfrozen — expenses can be edited again' })
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to unfreeze balances', description: describeWriteError(err) })
    } finally {
      setIsUnfreezing(false)
    }
  }

  const handleExportCsv = () => {
    const ledgerCsv = buildExpenseLedgerCsv(expenses, (id) => nameById[id] ?? id)
    const settlementCsv = buildSettlementSummaryCsv(settlements, (id) => nameById[id] ?? id, (s) => canManageTrip || s.from_user_id === user?.id || s.to_user_id === user?.id)
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

      {leftPeople.length > 0 && (
        <Card variant="sunken" noPadding className="p-3.5">
          <p className="text-sm text-[var(--text-secondary)]">
            {leftPeople.map((p) => p.name).join(', ')} left the trip. Their expenses and payments below still
            count, so balances stay complete.
          </p>
        </Card>
      )}

      {legacySnapshot && !isFrozen && (
        <Card variant="sunken" noPadding className="p-3.5">
          <p className="text-sm text-[var(--text-secondary)]">A previous settlement was recorded for this trip (legacy).</p>
        </Card>
      )}

      {isFrozen ? (
        <Card noPadding className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Badge variant="info">🔒 Balances frozen</Badge>
            {canManageTrip ? (
              <Button variant="ghost" size="sm" onClick={handleUnfreeze} disabled={isUnfreezing || freezeBlockedByDuplicates || freezeBlockedByDisputes} isLoading={isUnfreezing}>
                Unfreeze
              </Button>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">Ask an organizer to unfreeze</span>
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Expense edits are blocked while frozen. Unfreezing is audit-logged to the activity feed.
          </p>
          {canManageTrip && freezeBlockedByDuplicates && (
            <p className="text-xs text-[var(--text-muted)]" role="status">
              {UNFREEZE_BLOCKED_BY_DUPLICATES}
            </p>
          )}
          {canManageTrip && freezeBlockedByDisputes && (
            <p className="text-xs text-[var(--text-muted)]" role="status">
              {DISPUTED_PAYMENT_PAUSE}{' '}
              <button type="button" className="underline" onClick={showFirstDisputed}>
                Show me
              </button>
            </p>
          )}
          {canOfferSettleAll({ canManageTrip, isFrozen, unfinishedCount: settleAllList.count }) && (
            <div className="pt-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={freezeBlockedByDuplicates}
                onClick={() => {
                  setSettleAllOutcome(null)
                  setSettleAllOpen(true)
                }}
              >
                Mark everything as settled…
              </Button>
              {freezeBlockedByDuplicates && (
                <p className="text-xs text-[var(--text-muted)] mt-1" role="status">
                  Sort out the payments recorded twice first (see the notice below).
                </p>
              )}
            </div>
          )}
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
          {canManageTrip ? (
            <Button variant="primary" fullWidth onClick={handleFreezeClick} disabled={suggested.length === 0 || isFreezing || freezeBlockedByDuplicates || freezeBlockedByDisputes} isLoading={isFreezing}>
              Freeze balances & suggest payments
            </Button>
          ) : (
            <p className="text-sm text-center text-[var(--text-muted)] py-2">Ask an organizer to freeze balances</p>
          )}
          {canManageTrip && freezeBlockedByDuplicates && (
            <p className="text-xs text-center text-[var(--text-muted)]" role="status">
              {FREEZE_BLOCKED_BY_DUPLICATES}
            </p>
          )}
          {canManageTrip && freezeBlockedByDisputes && (
            <p className="text-xs text-center text-[var(--text-muted)]" role="status">
              {DISPUTED_PAYMENT_PAUSE}{' '}
              <button type="button" className="underline" onClick={showFirstDisputed}>
                Show me
              </button>
            </p>
          )}
        </Card>
      )}

      <UnclaimedReceiptsNotice receipts={noticeReceipts} canManageTrip={canManageTrip} />

      {everythingSettled && (
        <Card variant="sunken" noPadding className="p-4 flex items-center gap-3">
          <AllSettled className="w-20 h-14 text-success-500 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">Everything is settled ✓</p>
            <p className="text-xs text-[var(--text-muted)]">Every payment has been paid and confirmed.</p>
          </div>
        </Card>
      )}

      {suggested.length === 0 && !isFrozen && !everythingSettled && (
        <EmptyState
          icon={<AllSettled className="w-32 h-24 text-success-500" />}
          title="All settled up"
          description={
            currentSettlements.some((s) => s.status === 'marked_paid')
              ? 'Everything owed has been paid. Some payments are waiting to be confirmed.'
              : 'Nobody owes anybody anything right now.'
          }
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

      {fromLastFreeze.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]" role="status">
          {PREVIOUS_FREEZE_LABEL}: {fromLastFreeze.length === 1 ? '1 earlier suggested payment is' : `${fromLastFreeze.length} earlier suggested payments are`} not shown until balances are frozen again.
        </p>
      )}

      <DuplicatePaymentsNotice
        groups={duplicatePayments}
        canRemove={canManageTrip}
        tripId={trip.id}
        baseCurrency={trip.base_currency}
        nameOf={(id) => nameById[id] ?? 'Someone'}
      />

      <div className="space-y-2">
        {currentSettlements.map((s) => {
          const isMePaying = s.from_user_id === user?.id
          const isMeReceiving = s.to_user_id === user?.id
          const recipient = participants.find((p) => p.user_id === s.to_user_id)
          const recipientDetails = recipient ? parsePaymentDetails(recipient.user.payment_details) : { rails: [] }
          const fromName = nameById[s.from_user_id] ?? 'Someone'
          const toName = nameById[s.to_user_id] ?? 'someone'
          const paidDate = new Date(s.settled_at).toLocaleDateString()
          const mismatchAmount = pendingMismatchByPair.get(s.id)
          const behalfActions = onBehalfActions(s, { canManageTrip, viewerId: user?.id, receiverName: toName })
          const rec = onBehalfRecords.get(s.id)
          const behalfLabel = onBehalfLabel(
            s,
            rec,
            rec?.actorId ? nameById[rec.actorId] ?? 'an organizer' : 'an organizer',
            toName,
            (iso) => new Date(iso).toLocaleDateString()
          )

          const dView = disputeView(
            s,
            { viewerId: user?.id, canManageTrip },
            { supported: disputeOn, reAsksUsed: reAsksUsed(activityEntries, s, managerIds), payerName: fromName, receiverName: toName }
          )
          const noticeLines = paymentNoticeLines(s, noticeInfo.get(s.id), { viewerId: user?.id, canManageTrip }, toName, (iso) => new Date(iso).toLocaleDateString())

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
            <Card key={s.id} id={`settlement-${s.id}`} noPadding className="p-3.5 space-y-2">
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
                  <Button variant="secondary" size="sm" onClick={() => setMarkPaidTargetId(s.id)}>
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
                <OnBehalfMenu
                  paymentLabel={`${fromName} to ${toName}`}
                  actions={behalfActions}
                  disabled={settleOnBehalf.isPending || settleAllRunning}
                  onSelect={(a) => handleOnBehalf(s, a)}
                />
              </div>

              {(s.payment_method || s.notes) && s.status !== 'suggested' && (
                <p className="text-xs text-[var(--text-muted)] pl-9">
                  Paid via {s.payment_method ?? 'an unspecified method'} on {paidDate}
                  {s.notes && (canManageTrip || s.from_user_id === user?.id || s.to_user_id === user?.id) ? ` — "${s.notes}"` : ''}
                </p>
              )}

              {behalfLabel ? (
                <p className="text-xs text-[var(--text-muted)] pl-9 pt-0.5">{behalfLabel}</p>
              ) : (
                caption && <p className="text-xs text-[var(--text-muted)] pl-9 pt-0.5">{caption}</p>
              )}

              <DisputeActions tripId={trip.id} settlementId={s.id} payerName={fromName} receiverName={toName} view={dView} recordedOnBehalf={s.status === 'marked_paid' && rec?.toStatus === 'marked_paid'} />

              {noticeLines.map((line) => (
                <p key={line} className="text-xs text-[var(--text-muted)] pl-9 pt-0.5">
                  {line}
                </p>
              ))}

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
          <p className="text-xs text-[var(--text-muted)]">
            Balances left over on earlier trips. They are not part of this trip&apos;s balances or to-dos unless you fold them in.
          </p>
          {carryoverCandidates.map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">
                  {c.otherUserName} · {c.sourceTripName}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Carried from {c.sourceTripName}: {c.netAmount >= 0 ? 'owed to you' : 'you owe'} {formatMoney(Math.abs(c.netAmount), c.currency)}, not in this trip&apos;s balances yet
                </p>
              </div>
              {isTripOrganizer ? (
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
              ) : (
                <p className="text-xs text-[var(--text-muted)] shrink-0 max-w-[40%] text-right">An organiser can fold this in.</p>
              )}
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

      <SettleAllDialog
        isOpen={settleAllOpen}
        onClose={() => setSettleAllOpen(false)}
        list={settleAllList}
        isWorking={settleAllRunning}
        outcome={settleAllOutcome}
        onConfirm={handleSettleAll}
      />

      <FreezeUnclaimedDialog
        isOpen={unclaimedDialogOpen}
        onClose={() => setUnclaimedDialogOpen(false)}
        receipts={blockingReceipts}
        viewerId={user?.id}
        nameOf={shortNameOf}
        candidatesFor={candidatesFor}
        onAllShared={handleLeftoversShared}
        serverRefused={serverRefusedUnclaimed}
        serverReport={serverReport}
        onRefresh={handleRefreshAfterRefusal}
        currencyOf={(id) => expenses.find((x) => x.id === id)?.currency ?? trip.base_currency}
      />

      <MarkPaidSheet
        isOpen={!!markPaidTarget}
        onClose={() => setMarkPaidTargetId(null)}
        settlement={markPaidTarget}
        tripId={trip.id}
        toName={markPaidTarget ? nameById[markPaidTarget.to_user_id] ?? 'them' : ''}
      />
    </div>
  )
}
