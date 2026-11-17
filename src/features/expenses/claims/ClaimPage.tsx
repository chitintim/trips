import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Card, Button, Badge, Spinner, EmptyState, Modal, SegmentedControl, ConfirmDiscardSheet, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useSaveItemClaims, useSetReceiptClaims, useShareLeftovers } from '../../../lib/queries/useExpenses'
import { useClaimResponses } from '../../../lib/queries/useClaimResponses'
import { useParticipants, useTrip } from '../../../lib/queries/useTrip'
import { useUnsavedChangesGuard } from '../../../lib/forms'
import { toMinorUnits } from '../../../lib/money'
import { formatMoney, formatMoneyMinor } from '../lib/formatMoney'
import { claimLeftoverAmount, claimOwnAmount, claimOwnQuantity, hasOwnClaim } from '../lib/balances'
import { useClaimLink, useClaimRealtime } from './useClaimData'
import { summarizeLineClaims, summarizeOverallProgress, maxClaimableQuantity, claimAmount, isStepperClaim, shareLineMinor, unclaimedMinor, hasDirectUnitClaims, sharePickProblem, lockedSharePeople, lineIsEqualSplit, selfTogglePick, REPLACES_OWN_ENTRIES_WARNING } from './claimMath'
import { describeClaimError, describeOwnClaimError } from './claimErrors'
import { leftoverFollowUp, everythingSharedOut } from './leftoverReshare'
import type { ClaimRow, LineRow } from './claimMath'
import { describeMyShare, formatClaimQuantity } from './claimFractions'
import { labelOfUser, peopleOnReceipt } from './claimPeople'
import { moneySpaceUrl } from './claimDone'
import { ClaimMatrix } from './ClaimMatrix'
import { WhoHadWhat } from './WhoHadWhat'
import { resyncSelections } from './claimSelections'
import { LeftoversSheet } from './LeftoversSheet'
import { ShareClaimLink } from './ShareClaimLink'
import { ClaimReplyBar } from './ClaimReplyBar'
import { receiptTableSupport } from './receiptTable'
import { ReceiptLightbox } from '../components/ReceiptLightbox'

type View = 'mine' | 'who' | 'overview'

/**
 * The receipt's claim screen (/claim/:code). Everyone on the trip can tap the
 * items they had (whole units with the steppers) and see what the payer put
 * them down for. The payer and people who manage the trip also get "Who had
 * what" (record it for everyone, e.g. at the table), a read-only overview, the
 * leftovers sheet and a share link. It never locks because the receipt is
 * fully claimed: a person can always fix their own claim (which re-opens the
 * leftovers); it only locks while balances are frozen.
 */
export function ClaimPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const { data: resolution, isLoading, error, refetch } = useClaimLink(code)
  const { data: participants = [] } = useParticipants(resolution?.tripId)
  // ClaimPage is a standalone route (/claim/:code), not a child of MoneySpace,
  // so it fetches the trip's freeze state directly -- same isFrozen source
  // (trip.settlement_snapshot) MoneySpace/SettleUpTab already use.
  const { data: trip } = useTrip(resolution?.tripId)
  const { canManageTrip } = useTripPermissions(trip)
  const isFrozen = !!trip?.settlement_snapshot
  const responses = useClaimResponses(resolution?.tripId)
  const saveClaims = useSaveItemClaims()
  const setClaims = useSetReceiptClaims()
  const shareLeftovers = useShareLeftovers()
  const { showToast } = useToast()

  const currentUserName = participants.find((p) => p.user_id === user?.id)?.user.full_name || user?.email || 'Someone'
  const { broadcastSelection } = useClaimRealtime(resolution?.expense.id, user?.id, currentUserName)

  const [localSelections, setLocalSelections] = useState<Record<string, number>>({})
  const [initialized, setInitialized] = useState(false)
  const [view, setView] = useState<View>(searchParams.get('assign') === '1' ? 'who' : 'mine')
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)
  const [showLeftovers, setShowLeftovers] = useState(false)
  const [shareLineId, setShareLineId] = useState<string | null>(null)
  const [sharePick, setSharePick] = useState<string[]>([])

  /** My whole-unit claims per line (what the steppers edit; the own part of the row). Shared, leftover-only and legacy-fraction rows are not in here. */
  const stepperSelections = (claims: ClaimRow[]): Record<string, number> => {
    const mine: Record<string, number> = {}
    for (const claim of claims) {
      if (claim.user_id === user?.id && isStepperClaim(claim)) mine[claim.line_item_id] = (mine[claim.line_item_id] ?? 0) + claimOwnQuantity(claim)
    }
    return mine
  }

  useEffect(() => {
    if (!resolution || !user || initialized) return
    setLocalSelections(stepperSelections(resolution.claims))
    setInitialized(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution, user, initialized])

  const claimsByLine = useMemo(() => {
    const map = new Map<string, ClaimRow[]>()
    if (!resolution) return map
    for (const claim of resolution.claims) {
      const list = map.get(claim.line_item_id) || []
      list.push(claim)
      map.set(claim.line_item_id, list)
    }
    return map
  }, [resolution])

  // localSelections diverging from the caller's last SAVED claims is exactly
  // the "unsaved changes" state -- compare the two rather than tracking a
  // separate dirty flag, so it's right whether the divergence came from a tap
  // here or a realtime update elsewhere.
  const savedSelections = useMemo(() => (resolution && user ? stepperSelections(resolution.claims) : {}), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolution, user])

  // Follow claims that change elsewhere (Who had what, a re-itemise, another phone), keeping this person's own unsaved taps.
  const prevSavedRef = useRef(savedSelections)
  useEffect(() => {
    const prev = prevSavedRef.current
    prevSavedRef.current = savedSelections
    if (prev === savedSelections) return
    setLocalSelections((cur) => resyncSelections(cur, prev, savedSelections))
  }, [savedSelections])

  // Balances froze (here, or found out after a refused save): nothing can be saved any more, so the taps go back to what the server holds.
  // Otherwise the page would look unsaved forever and keep asking before it lets you leave.
  useEffect(() => {
    if (isFrozen) setLocalSelections(savedSelections)
  }, [isFrozen, savedSelections])

  const changedLineIds = useMemo(() => {
    const keys = new Set([...Object.keys(localSelections), ...Object.keys(savedSelections)])
    return [...keys].filter((key) => (localSelections[key] ?? 0) !== (savedSelections[key] ?? 0))
  }, [localSelections, savedSelections])
  const isDirty = changedLineIds.length > 0

  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error || !resolution) {
    // A Postgres/PostgREST "no rows" (PGRST116, from the .single() lookup by
    // code) is genuinely a bad/expired link; anything else is a generic fetch
    // failure and gets a retry instead.
    const errorCode = (error as { code?: string } | null)?.code
    const isNotFound = !error || errorCode === 'PGRST116'
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md">
          {isNotFound ? (
            <EmptyState icon="🔗" title="Link not found" description="This claim link may have expired or is invalid." />
          ) : (
            <EmptyState
              icon="⚠️"
              title="Couldn't load this claim link"
              description="Something went wrong. Check your connection and try again."
              action={
                <Button variant="primary" onClick={() => refetch()}>
                  Try again
                </Button>
              }
            />
          )}
        </Card>
      </div>
    )
  }

  const { expense, lineItems, claims } = resolution
  const currency = expense.currency
  const isPayer = user?.id === expense.paid_by
  const canRecord = isPayer || canManageTrip
  const canWho = canRecord
  const canLeftovers = canRecord
  // The one shared "who is on this receipt" rule (RSVP switch and "I wasn't there" replies included).
  const people = peopleOnReceipt(expense, participants, claims, {
    confirmationEnabled: trip?.confirmation_enabled === true,
    responses: responses.rows.filter((r) => r.expense_id === expense.id),
    lineItems,
  })
  const isTagged = !!user && people.some((p) => p.id === user.id)
  // Payer and managers have full power (they pick anyone). A tagged person can only toggle THEMSELVES on an item
  // ("I had some of this too" / "Not mine"), within the server's rules (sharePickProblem).
  const canSharePick = canRecord || isTagged
  const activeView: View = view === 'who' && !canWho ? 'mine' : view === 'overview' && !canRecord ? 'mine' : view
  const overallProgress = summarizeOverallProgress(lineItems, claims)
  const unclaimed = unclaimedMinor(lineItems, claims, currency)
  const payerName = isPayer ? 'You' : labelOfUser(expense.paid_by, people, participants)
  // Receipts phase 2: reply buttons and the deadline line.
  const tableSupport = receiptTableSupport({ expense, responsesAvailable: responses.available })
  // Frozen balances lock the page. So does a CLOSED receipt (leftovers shared): its claims are final for everyone, the payer included, until
  // the payer reopens it. A fully claimed receipt otherwise stays open so a person can still fix their own claim.
  const isClosed = tableSupport.phase === 'closed'
  const isReadOnly = isFrozen || isClosed
  const myResponse = (responses.rows.find((r) => r.expense_id === expense.id && r.user_id === user?.id)?.response ?? null) as 'done' | 'not_there' | null
  const showReplyBar = !!tableSupport.columns && (tableSupport.phase === 'open' || tableSupport.phase === 'closed') && (isTagged || isPayer)

  const otherRowsOnLine = (lineId: string) => (claimsByLine.get(lineId) ?? []).filter((c) => !(c.user_id === user?.id && isStepperClaim(c)))
  const myAmount = (li: LineRow, qty: number) => claimAmount(li, qty, otherRowsOnLine(li.id), currency)

  const updateQuantity = (lineItemId: string, quantity: number) => {
    const next = { ...localSelections, [lineItemId]: quantity }
    setLocalSelections(next)

    const payload: Record<string, { lineItemId: string; quantity: number; amount: number }> = {}
    for (const [id, qty] of Object.entries(next)) {
      const li = lineItems.find((l) => l.id === id)
      if (li && qty > 0) payload[id] = { lineItemId: id, quantity: qty, amount: myAmount(li, qty) }
    }
    broadcastSelection(payload)
  }

  const afterOwnChange = async () => {
    // The leftover share inside my row on a line I edit goes with the row; if leftovers had been shared on the receipt (any line), they
    // need sharing again (payer / managers only). For anyone else the removed value returns to "unclaimed" for the payer, who is told.
    const followUp = leftoverFollowUp({ expense, claims, canShare: canLeftovers })
    if (followUp === 'none') return
    if (followUp === 'reshare') {
      try {
        await shareLeftovers.mutateAsync({ expenseId: expense.id, mode: 'same', currency })
      } catch {
        showToast({ type: 'info', message: 'The shared leftovers need sharing again' })
      }
    } else {
      showToast({ type: 'info', message: `Leftovers were already shared on this receipt`, description: `${payerName === 'You' ? 'You' : payerName} may need to share them again after your change.` })
    }
  }

  const handleSave = async () => {
    if (!user) return
    const toSave = changedLineIds
      .filter((id) => (localSelections[id] ?? 0) > 0)
      .map((lineItemId) => {
        const li = lineItems.find((l) => l.id === lineItemId)!
        const qty = localSelections[lineItemId]
        return { line_item_id: lineItemId, quantity_claimed: qty, amount_owed: myAmount(li, qty) }
      })
    try {
      // Only the lines that changed are replaced, so shared and leftover rows
      // on other lines are never touched.
      const saved = await saveClaims.mutateAsync({ expenseId: expense.id, userId: user.id, claims: toSave, lineItemIds: changedLineIds })
      showToast({ type: 'success', message: 'Your claims are saved' })
      // set_my_receipt_claims already rebuilds the leftovers on the server; only the old direct-write fallback needs the follow-up.
      if (!saved.viaRpc) void afterOwnChange()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save your claims', description: describeOwnClaimError(err) })
    }
  }

  /**
   * "Not mine" on a shared item. Everyone, the payer and managers included, goes through the shared-line function (a shared or fractional
   * share is not a whole-unit claim, so the own-claims function refuses it). Where taking me off would also re-split other people's amounts
   * (an item shared by everyone, or others holding unequal parts) the payer / manager gets the share picker instead of a silent re-split.
   */
  const takeMeOff = (li: LineRow) => {
    const rows = claimsByLine.get(li.id) ?? []
    const others = [...new Set(rows.filter(hasOwnClaim).map((c) => c.user_id))].filter((id) => id !== user?.id)
    if (canRecord && (li.shared_by_all || (others.length > 0 && !lineIsEqualSplit(li, rows, currency)))) {
      openSharePicker(li)
      return
    }
    void toggleSelf(li, false)
  }

  /** An ordinary tagged person: put myself on a line someone else holds, or take myself off it. One call, nobody else is touched. */
  const toggleSelf = async (li: LineRow, on: boolean) => {
    if (!user) return
    const rows = claimsByLine.get(li.id) ?? []
    const existing = [...new Set(rows.filter(hasOwnClaim).map((c) => c.user_id))]
    const pick = selfTogglePick(existing, user.id, on)
    // The payer and managers may take themselves off anything (takeMeOff sends the cases that would re-split others to the picker).
    const problem = canRecord ? null : sharePickProblem({
      fullPower: false,
      me: user.id,
      pick,
      existing,
      lineSharedByAll: !!li.shared_by_all,
      othersSplitUnequal: !lineIsEqualSplit(li, rows, currency),
    })
    if (problem) {
      showToast({ type: 'info', message: problem })
      return
    }
    try {
      await setClaims.mutateAsync({ expenseId: expense.id, claims: [{ line_item_id: li.id, user_ids: pick }] })
      setLocalSelections((prev) => {
        const next = { ...prev }
        delete next[li.id]
        return next
      })
      showToast({ type: 'success', message: on ? 'Added to your items' : 'Taken off your items' })
      void afterOwnChange()
    } catch (err) {
      showToast({ type: 'error', message: on ? "Couldn't add it" : "Couldn't take that off", description: describeClaimError(err) })
    }
  }

  const openSharePicker = (li: LineRow) => {
    const current = (claimsByLine.get(li.id) ?? []).filter(hasOwnClaim).map((c) => c.user_id)
    // "I shared this" starts with me and everyone already on the item switched on.
    setSharePick([...new Set([...(user ? [user.id] : []), ...current])])
    setShareLineId(li.id)
  }

  const confirmShare = async () => {
    if (!shareLineId) return
    try {
      await setClaims.mutateAsync({ expenseId: expense.id, claims: [{ line_item_id: shareLineId, user_ids: sharePick }] })
      setLocalSelections((prev) => {
        const next = { ...prev }
        delete next[shareLineId]
        return next
      })
      showToast({ type: 'success', message: sharePick.length > 1 ? `Shared between ${sharePick.length}` : 'Saved' })
      setShareLineId(null)
      void afterOwnChange()
    } catch (err) {
      showToast({ type: 'error', message: "Couldn't save how it was shared", description: describeClaimError(err) })
    }
  }

  const myTotalMinor = lineItems.reduce((sum, li) => {
    // Fixed shares count in full; a stepper row counts only its leftover share (its own part is the stepper value below).
    const mineHere = (claimsByLine.get(li.id) ?? []).filter((c) => c.user_id === user?.id)
    const fixed = mineHere.reduce((s, c) => s + toMinorUnits(isStepperClaim(c) ? claimLeftoverAmount(c) : c.amount_owed, currency), 0)
    const qty = localSelections[li.id] ?? 0
    return sum + fixed + (qty > 0 ? toMinorUnits(myAmount(li, qty), currency) : 0)
  }, 0)

  // Rows someone else recorded for me (whole-unit, so the steppers can change them).
  const putDownByOthers = claims.filter((c) => c.user_id === user?.id && c.source === 'on_behalf' && c.created_by && c.created_by !== user.id)
  const putDownByNames = [...new Set(putDownByOthers.map((c) => labelOfUser(c.created_by, people, participants)))]
  const putDownMinor = putDownByOthers.reduce((sum, c) => sum + toMinorUnits(Math.max(0, c.amount_owed - claimLeftoverAmount(c)), currency), 0)
  const putDownLine = putDownByOthers.length > 0 ? `${putDownByNames.join(' and ')} put you down for ${formatMoneyMinor(putDownMinor, currency)}` : null
  const shareLine = shareLineId ? lineItems.find((l) => l.id === shareLineId) : null
  const shareExisting = shareLine ? [...new Set((claimsByLine.get(shareLine.id) ?? []).filter(hasOwnClaim).map((c) => c.user_id))] : []
  const shareProblem = shareLine && user ? sharePickProblem({ fullPower: canRecord, me: user.id, pick: sharePick, existing: shareExisting, lineSharedByAll: !!shareLine.shared_by_all }) : null
  const shareLocked = user ? lockedSharePeople({ fullPower: canRecord, me: user.id, people: people.map((p) => p.id) }) : new Set<string>()
  const shareReplaces = !!shareLine && hasDirectUnitClaims(shareLine, claimsByLine.get(shareLine.id) ?? [])
  const shareEach = shareLine && sharePick.length > 0 ? shareLineMinor(toMinorUnits(shareLine.total_amount, currency), sharePick) : null

  // Once the leftovers are shared every line is full: an own claim would be refused, so say so plainly instead of offering steppers.
  const payerFirstName = isPayer ? 'the person who paid' : labelOfUser(expense.paid_by, people, participants)
  const sharedOutNotice = !isReadOnly && !canRecord && everythingSharedOut(lineItems, claims, currency)

  const goBack = () => (window.history.length > 1 ? navigate(-1) : navigate(`/${resolution.tripId}`))
  // "Done" on Who had what: everything pending is already saved by the time this runs. Leave for the trip's Money (the trip page does
  // not remember a space, so going "back" would land on Today); unsaved taps on My items are guarded like any other leave.
  const leaveToMoney = () => confirmClose(() => navigate(moneySpaceUrl(resolution.tripId), { replace: true }))

  const viewOptions: Array<{ value: View; label: string }> = [
    { value: 'mine', label: 'My items' },
    ...(canWho ? [{ value: 'who' as View, label: 'Who had what' }] : []),
    ...(canRecord ? [{ value: 'overview' as View, label: 'Overview' }] : []),
  ]

  return (
    <div className="min-h-screen bg-[var(--surface-page)] pb-24">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <button type="button" onClick={goBack} className="min-h-11 -ml-2 px-2 text-sm font-medium text-accent-700 dark:text-accent-400">
          ← Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">{expense.vendor_name || expense.description}</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              {expense.payment_date} · Total {formatMoney(expense.amount, currency)} · paid by {payerName.toLowerCase() === 'you' ? 'you' : payerName}
            </p>
          </div>
          {expense.receipt_url && (
            <Button variant="ghost" size="sm" onClick={() => setShowReceiptLightbox(true)} className="shrink-0">
              📄 View receipt
            </Button>
          )}
        </div>

        {overallProgress.isFullyAllocated && unclaimed === 0 && <Badge variant="success">✓ Fully claimed</Badge>}

        {isFrozen && <Badge variant="neutral">🔒 Claiming is locked while balances are frozen</Badge>}
        {!isFrozen && isClosed && (
          <Card noPadding className="p-3">
            <p className="text-sm text-[var(--text-primary)]" role="status">
              This receipt's claims are closed, so nothing can be changed.{' '}
              {canRecord ? 'Open Who had what and tap Reopen to change it.' : `Ask ${isPayer ? 'an organizer' : payerName} to reopen it if something is wrong.`}
            </p>
          </Card>
        )}

        {canRecord && !isReadOnly && unclaimed > 0 && (
          <Card noPadding className="p-3 flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-[var(--text-primary)]">{formatMoneyMinor(unclaimed, currency)} isn't claimed</p>
              <p className="text-xs text-[var(--text-secondary)]">Until it is placed, it stays with {payerName === 'You' ? 'you' : payerName}.</p>
            </div>
            {canLeftovers && (
              <Button variant="secondary" size="sm" onClick={() => setShowLeftovers(true)} className="shrink-0 min-h-11">
                Sort out the rest
              </Button>
            )}
          </Card>
        )}

        {canRecord && resolution.code && <ShareClaimLink code={resolution.code} title={expense.vendor_name || expense.description} />}

        {viewOptions.length > 1 && <SegmentedControl options={viewOptions} value={activeView} onChange={setView} fullWidth aria-label="View" />}

        {activeView === 'overview' && canRecord && <ClaimMatrix expense={expense} lineItems={lineItems} claims={claims} participants={participants} />}

        {activeView === 'who' && canWho && (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              You're setting what <strong>other people</strong> had. Each change is recorded as made by you
              {isPayer ? '' : ` (not ${payerName})`}.
            </p>
            <WhoHadWhat
              expense={expense}
              lineItems={lineItems}
              claims={claims}
              participants={participants}
              disabled={isFrozen}
              onOpenLeftovers={canLeftovers ? () => setShowLeftovers(true) : undefined}
              onDone={leaveToMoney}
            />
          </>
        )}

        {activeView === 'mine' && (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              {canRecord ? (
                <>
                  These are <strong>your own</strong> items, {currentUserName.split(' ')[0]}.{canWho ? ' To set what other people had, use Who had what.' : ''}
                </>
              ) : (
                <>Tap the items you had.</>
              )}
            </p>

            {showReplyBar && user && tableSupport.columns && (
              <ClaimReplyBar
                tripId={resolution.tripId}
                expenseId={expense.id}
                userId={user.id}
                columns={tableSupport.columns}
                response={myResponse}
                isPayer={isPayer}
                hasOwnItems={claims.some((c) => c.user_id === user.id && hasOwnClaim(c) && !lineItems.find((l) => l.id === c.line_item_id)?.shared_by_all)}
                putDownLine={null}
                canReply={tableSupport.canReply}
                deadlinePassed={tableSupport.replyClosedReason === 'deadline_passed'}
                frozen={isFrozen}
                payerName={isPayer ? undefined : payerName}
              />
            )}

            {putDownByOthers.length > 0 && (
              <Card noPadding className="p-3 space-y-2 border-accent-300">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {tableSupport.canReply ? `${putDownLine}. Change anything that's wrong.` : `${putDownByNames.join(' and ')} put you down for these. Change anything that's wrong.`}
                </p>
                <ul className="space-y-1">
                  {putDownByOthers.map((c) => {
                    const li = lineItems.find((l) => l.id === c.line_item_id)
                    if (!li) return null
                    const gone = (localSelections[li.id] ?? 0) === 0
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className={`min-w-0 truncate ${gone ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                          {formatClaimQuantity(c.quantity_claimed)} × {li.name_english || li.name_original} · {formatMoney(c.amount_owed, currency)}
                        </span>
                        {!isReadOnly && !gone && (
                          <button type="button" onClick={() => updateQuantity(li.id, 0)} className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400 shrink-0">
                            Not mine
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Card>
            )}

            {sharedOutNotice && (
              <Card noPadding className="p-3">
                <p className="text-sm text-[var(--text-primary)]">
                  Everything on this receipt has been shared out — ask {payerFirstName} if something&apos;s wrong.
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">You can still take yourself off an item you are on with “Not mine”.</p>
              </Card>
            )}

            <div className="space-y-2">
              {lineItems.map((li) => {
                const claimsForLine = claimsByLine.get(li.id) || []
                const summary = summarizeLineClaims(li, claimsForLine, user?.id)
                const myQty = localSelections[li.id] ?? 0
                const maxQty = maxClaimableQuantity(summary)
                const name = li.name_english || li.name_original
                const myFixed = claimsForLine.filter((c) => c.user_id === user?.id && !isStepperClaim(c))
                const myShared = myFixed.filter(hasOwnClaim)
                // ONE row per person and line: the leftover share is a part of it (any of my rows on this line may carry one).
                const myLeftoverAmount = claimsForLine.filter((c) => c.user_id === user?.id).reduce((s, c) => s + claimLeftoverAmount(c), 0)
                const sharers = claimsForLine.filter(hasOwnClaim)
                const sharerQuantities = [...new Set(sharers.map((c) => c.user_id))].map((id) => sharers.filter((c) => c.user_id === id).reduce((s, c) => s + claimOwnQuantity(c), 0))
                const othersText = claimsForLine
                  .filter((c) => c.user_id !== user?.id && hasOwnClaim(c))
                  .map((c) => `${labelOfUser(c.user_id, people, participants)} ${formatClaimQuantity(claimOwnQuantity(c))}`)
                  .join(' · ')

                return (
                  <Card key={li.id} noPadding className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-[var(--text-primary)] truncate">
                          <span className="text-[var(--text-muted)] font-normal tabular-nums">{li.line_number}.</span> {name}
                        </p>
                        {li.name_english && li.name_original && li.name_original !== li.name_english && (
                          // Original receipt text so people can match the app
                          // against the paper bill (any language).
                          <p className="text-xs text-[var(--text-secondary)] truncate">{li.name_original}</p>
                        )}
                        <p className="text-xs text-[var(--text-muted)]">
                          {formatMoney(li.total_amount, currency)} · {summary.available > 0 ? `${formatClaimQuantity(summary.available)} of ${formatClaimQuantity(li.quantity)} left` : 'all claimed'}
                        </p>
                        {othersText && <p className="text-xs text-[var(--text-muted)] truncate">{othersText}</p>}
                      </div>

                      {!isReadOnly && li.quantity > 0 && myShared.length === 0 && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateQuantity(li.id, Math.max(0, myQty - 1))}
                            disabled={myQty <= 0}
                            aria-label={`Decrease claimed quantity for ${name}`}
                            className="w-11 h-11 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="w-8 text-center text-sm tabular-nums">{myQty}</span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(li.id, Math.min(Math.floor(maxQty + 0.005), myQty + 1))}
                            disabled={myQty + 1 > maxQty + 0.005}
                            aria-label={`Increase claimed quantity for ${name}`}
                            className="w-11 h-11 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>

                    {myQty > 0 && (
                      <p className="text-xs text-accent-700 dark:text-accent-400 font-medium mt-1.5">
                        You: {myQty}/{formatClaimQuantity(li.quantity)} — {formatMoney(myAmount(li, myQty), currency)}
                      </p>
                    )}

                    {myShared.length > 0 && (
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <p className="text-xs text-accent-700 dark:text-accent-400 font-medium">
                          You: {describeMyShare({ myQuantity: myShared.reduce((s, c) => s + claimOwnQuantity(c), 0), lineQuantity: li.quantity, allQuantities: sharerQuantities })} —{' '}
                          {formatMoney(myShared.reduce((s, c) => s + claimOwnAmount(c), 0), currency)}
                          {myShared[0].created_by && myShared[0].created_by !== user?.id && ` · put down by ${labelOfUser(myShared[0].created_by, people, participants)}`}
                        </p>
                        {!isReadOnly && (
                          <div className="flex shrink-0">
                            {canSharePick && canRecord && (
                              <button type="button" onClick={() => openSharePicker(li)} className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400">
                                Change
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => takeMeOff(li)}
                              className="min-h-11 px-3 text-sm font-medium text-accent-700 dark:text-accent-400"
                            >
                              Not mine
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {myLeftoverAmount > 0 && (
                      <p className="text-xs text-[var(--text-secondary)] mt-1.5">
                        {formatMoney(myLeftoverAmount, currency)} added to you from the leftovers
                      </p>
                    )}

                    {!isReadOnly && canSharePick && canRecord && myShared.length === 0 && (
                      <button type="button" onClick={() => openSharePicker(li)} className="mt-1 min-h-11 text-sm font-medium text-accent-700 dark:text-accent-400">
                        I shared this
                      </button>
                    )}
                    {!isReadOnly && canSharePick && !canRecord && isTagged && myShared.length === 0 && myQty === 0 && !li.shared_by_all && sharers.some((c) => c.user_id !== user?.id) && (
                      <button type="button" onClick={() => toggleSelf(li, true)} className="mt-1 min-h-11 text-sm font-medium text-accent-700 dark:text-accent-400">
                        I had some of this too
                      </button>
                    )}
                  </Card>
                )
              })}
            </div>

            {!isReadOnly && (
              <div className="fixed bottom-0 left-0 right-0 z-20 bg-[var(--surface-raised)] border-t border-[var(--border-subtle)] p-4 pb-safe">
                <div className="max-w-lg mx-auto flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-xs text-[var(--text-muted)]">Your total</p>
                    <p className="font-semibold text-[var(--text-primary)]">{formatMoneyMinor(myTotalMinor, currency)}</p>
                  </div>
                  <Button variant="primary" className="min-h-11" onClick={handleSave} isLoading={saveClaims.isPending} disabled={!isDirty}>
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

      {canLeftovers && (
        <LeftoversSheet isOpen={showLeftovers} onClose={() => setShowLeftovers(false)} expense={expense} participants={participants} unclaimedMinor={unclaimed} />
      )}

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />

      <Modal isOpen={!!shareLine} onClose={() => setShareLineId(null)} title="Who shared this?">
        {shareLine && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              {shareLine.name_english || shareLine.name_original} is split equally between the people you pick
              {shareEach && sharePick.length > 1 ? ` (${sharePick.length} ways, about ${formatMoneyMinor(Math.max(...shareEach.values()), currency)} each)` : ''}.
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Who shared it">
              {people.map((p) => {
                const on = sharePick.includes(p.id)
                const locked = shareLocked.has(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    title={p.fullName}
                    aria-label={`${p.id === user?.id ? 'Me' : p.fullName}${locked ? ', has to stay on this item' : ''}`}
                    disabled={locked || !!shareLine.shared_by_all && !canRecord}
                    onClick={() => setSharePick((prev) => (on ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                    className={`min-h-11 max-w-full px-4 py-1.5 text-left break-words rounded-[var(--radius-full)] border text-sm font-medium disabled:opacity-100 disabled:cursor-not-allowed ${
                      on ? 'bg-accent-600 border-accent-600 text-white' : 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {p.id === user?.id ? 'Me' : p.label}
                  </button>
                )
              })}
            </div>
            {shareProblem && <p className="text-sm text-[var(--text-secondary)]" role="status">{shareProblem}</p>}
            {shareReplaces && !shareProblem && <p className="text-sm text-[var(--text-secondary)]">{REPLACES_OWN_ENTRIES_WARNING} Everyone you pick gets an equal share instead.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShareLineId(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmShare} isLoading={setClaims.isPending} disabled={!!shareProblem}>
                {shareReplaces ? 'Replace and save' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
