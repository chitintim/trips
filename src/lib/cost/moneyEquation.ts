/**
 * The money position explains itself (redesign proposal 4.6, R5): a pure
 * function that turns a person's ledger into an explained equation and a
 * headline that never calls money "owed" when it has already been sent.
 *
 *   You paid £11,563.80 − your share £5,719.28 − paid back to you £10,543.13
 *   = you owe £4,698.61
 *
 * Reuses `computeBalances` / `splitOwedAmounts` (balances.ts) for every
 * figure and `computeMoneyPosition` (moneyPosition.ts) for the headline kind
 * and amount; the maths of those files is untouched. This file only
 * arranges their results and splits payments by status:
 *
 *   suggested     a proposed payment; not money yet
 *   marked_paid   the payer says they paid; waiting for the receiver to confirm
 *                 (NOT in the balance, so the balance still shows the debt)
 *   confirmed     counted in the balance (also folded carryovers)
 *
 * Headline rule: money already marked paid is never in a "You owe £X"
 * headline. owe £A with £S marked paid: remaining = max(A − S, 0).
 *   remaining > 0  -> "You owe £remaining" (+ a note: "£S sent — waiting for <name> to confirm")
 *   remaining = 0  -> "£S sent — waiting for <name> to confirm"
 * and symmetrically for money owed to you: "<name> says they've paid you £X
 * — confirm receipt".
 *
 * Three honesty rules (phase 3 review):
 *  - Carryovers are described as what they are ("carried over from <trip>"),
 *    never as a payment sent or received. They reach the ledger as reversed
 *    pseudo-settlements, so they are split back out of sent / received here.
 *  - Frozen trips: the pay to-dos come from the 'suggested' settlement rows
 *    (lib/todos/computeTodos moneyTodos). If rows from you still exist and
 *    their sum is not what the live ledger says you owe (a direct payment
 *    landed after the freeze), the header cannot say "square": it says the
 *    balances changed and the organizer should refresh.
 *  - Marked-paid money in another currency is never read 1:1 as base units.
 *    With a rate it is converted (marked ≈); without one it is left out of the
 *    arithmetic (as the to-dos engine does) and listed in `excludedForeign`.
 */
import { computeBalances, partitionCarryovers, splitOwedAmounts } from '../../features/expenses/lib/balances'
import { computeMoneyPosition, type MoneyPositionKind } from '../../features/expenses/money-space/moneyPosition'
import { withMoneyParticipants } from '../../features/expenses/lib/balances'
import { findDuplicatePayments } from '../../features/expenses/settle-up/settleUpLogic'
import { formatMoney } from '../money/format'
import { fromMinorUnits, toMinorUnits } from '../money/minorUnits'
import type { ExpenseWithDetails } from '../queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../queries/useSettlements'

export type PaymentStatus = 'suggested' | 'marked_paid' | 'confirmed'

export interface PositionPayment {
  id: string
  /** The other person. */
  counterpartyId: string
  counterpartyName: string
  amount: number
  currency: string
  status: PaymentStatus
  /** Marked paid and the receiver has said it hasn't arrived (receipt_disputed_at). */
  disputed?: boolean
}

export interface EquationTerm {
  key: 'paid' | 'share' | 'sent' | 'received' | 'carried'
  /** Unique within `terms` (carryovers each get their own). */
  id: string
  label: string
  /** Always a positive amount; `sign` says how it enters the sum. */
  amount: number
  sign: '+' | '−'
}

export type PositionHeadlineKind =
  | 'owe' // you still owe
  | 'sent_waiting' // everything you owe has been sent; waiting for confirmation
  | 'overpaid' // what you have sent (waiting for confirmation) is MORE than you owe
  | 'owed' // you're still owed
  | 'confirm_receipt' // others say they've paid you; confirm
  | 'settled'
  | 'stale' // frozen: suggested payments from you still exist but the live ledger no longer matches them

export const STALE_BALANCES_NOTE = 'Balances changed since they were frozen — ask the organizer to refresh'

/** A debt or credit brought in from another trip (settlement_carryovers). */
export interface CarriedOver {
  id: string
  /** "Sicily" or "another trip". */
  tripLabel: string
  amount: number
  /** 'owed_by_you': you owe it; 'owed_to_you': you are owed it. */
  direction: 'owed_by_you' | 'owed_to_you'
  otherPartyName: string
}

export interface PositionHeadline {
  kind: PositionHeadlineKind
  /** The amount in the headline (0 for settled). */
  amount: number
  /** "You owe £120" | "£120 sent — waiting for Sam to confirm" | "You're owed £84" | "Sam says they've paid you £84 — confirm receipt" | "All square". */
  text: string
  /** Second line when something is also waiting ("£50 sent — waiting for Sam to confirm"), else null. */
  note: string | null
}

/** A receipt you paid for that has value nobody has claimed yet (counted as yours until it is shared). */
export interface UnclaimedReceiptRef {
  expenseId: string
  description: string
  /** Unclaimed value in the receipt's own currency. */
  amount: number
  /** The receipt's own currency. */
  currency: string
  /** The claim page is /claim/<claimCode>; null when the receipt has no claim link. */
  claimCode: string | null
}

/**
 * Unclaimed value on receipts YOU paid for. It sits inside `share` (the payer's
 * own share, never a second cost), so `paid − share` already reflects it.
 */
export interface UnclaimedForYou {
  /** Real unclaimed value, base currency. > 0 whenever this object exists. */
  amount: number
  /** Everything in your share that is pending rather than claimed (unclaimed value plus rounding dust), base currency. */
  pendingInShare: number
  receipts: UnclaimedReceiptRef[]
}

export interface MoneyEquation {
  currency: string
  /** What you paid out of pocket (confirmed expenses, base currency). */
  paid: number
  /** Your share of all expenses. */
  share: number
  /** Payments you sent / received that are confirmed. Carryovers are NOT included (see `carriedOver`). */
  sentConfirmed: number
  receivedConfirmed: number
  /** Net from the ledger: positive = owed to you, negative = you owe. Confirmed payments only. */
  net: number
  kind: MoneyPositionKind
  /** What the ledger says before pending payments are considered (amount for 'owe' / 'owed', else 0). */
  ledgerAmount: number
  /** Debts / credits carried in from other trips, described as such. */
  carriedOver: CarriedOver[]
  /** Marked-paid / suggested payments in another currency that have no rate: not in any figure above. */
  excludedForeign: PositionPayment[]
  /** Some waiting amounts were converted from another currency with the rates given (print ≈). */
  waitingConverted: boolean
  /** The trip's balances are frozen (echo of the input). */
  frozen: boolean
  /** Frozen trip whose suggested payments from you no longer match the live ledger. */
  stale: boolean
  /** Payments by status, from your side. Carryovers are not listed here. */
  sentPayments: PositionPayment[]
  receivedPayments: PositionPayment[]
  /** Totals of marked-paid money waiting for confirmation. */
  sentWaiting: number
  receivedWaiting: number
  /** Suggested (not yet paid) totals. */
  sentSuggested: number
  receivedSuggested: number
  /** Sent (marked paid, base currency) beyond what the ledger says you owe; 0 when not overpaying. */
  overpaid: number
  /** Payments involving you that look recorded twice (same pair, amount, currency; see findDuplicatePayments). */
  hasDuplicatePayments: boolean
  /** After taking marked-paid money into account. */
  remainingToPay: number
  remainingToReceive: number
  headline: PositionHeadline
  /** The terms of "paid − share + sent − received = net", zero terms of sent/received omitted. */
  terms: EquationTerm[]
  /** "You paid £11,563.80 − your share £5,719.28 − paid back to you £10,543.13 = you owe £4,698.61". */
  equationText: string
  expensesMissingRate: string[]
  /** Set only when you paid for itemised receipts with unclaimed value; others never see it. */
  unclaimed: UnclaimedForYou | null
}

export interface ExplainMoneyInput {
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  /** Active participant user ids (the ledger adds anyone else who appears in the money). */
  participantUserIds: string[]
  currentUserId: string
  baseCurrency: string
  carryovers?: SettlementCarryover[]
  /** The trip's balances are frozen (trips.settlement_snapshot is set): the pay to-dos come from the suggested rows. */
  frozen?: boolean
  /** Base units per 1 unit of the key currency, to convert marked-paid money in other currencies. Without a rate such a payment is excluded and listed. */
  fxRates?: Readonly<Record<string, number>>
  /** carryover.source_trip_id -> trip name, for "carried over from Sicily". */
  carryoverTripNames?: Readonly<Record<string, string | null | undefined>>
  /** user id -> display name; unknown ids print as "someone". */
  names?: Readonly<Record<string, string | null | undefined>>
}

function nameList(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length === 0) return 'them'
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} other${unique.length - 2 === 1 ? '' : 's'}`
}

export function explainMoneyPosition(input: ExplainMoneyInput): MoneyEquation {
  const { expenses, settlements, participantUserIds, currentUserId, baseCurrency } = input
  const carryovers = input.carryovers ?? []
  const money = (v: number) => formatMoney(v, baseCurrency, { mode: 'exact' })
  const nameOf = (id: string) => input.names?.[id]?.trim() || 'someone'

  const ledgerIds = withMoneyParticipants(participantUserIds, expenses, settlements, baseCurrency, carryovers)
  const { balances, expensesMissingRate, receipts } = computeBalances(expenses, settlements, ledgerIds, baseCurrency, carryovers)
  const mine = balances.find((b) => b.userId === currentUserId)
  const position = computeMoneyPosition(expenses, settlements, participantUserIds, currentUserId, baseCurrency, carryovers)

  const myUnclaimed = receipts.filter((r) => r.paidBy === currentUserId && r.unclaimedMinor > 0)
  const unclaimed: UnclaimedForYou | null =
    myUnclaimed.length === 0
      ? null
      : {
          amount: fromMinorUnits(
            myUnclaimed.reduce((acc, r) => acc + r.unclaimedMinor, 0),
            baseCurrency
          ),
          pendingInShare: fromMinorUnits(mine?.pendingUnclaimedMinor ?? 0, baseCurrency),
          receipts: myUnclaimed.map((r) => ({
            expenseId: r.expenseId,
            description: r.description,
            amount: fromMinorUnits(r.unclaimedOwnMinor, r.currency),
            currency: r.currency,
            claimCode: r.claimCode,
          })),
        }

  const paid = fromMinorUnits(mine?.totalPaidMinor ?? 0, baseCurrency)
  const share = fromMinorUnits(mine?.totalOwedMinor ?? 0, baseCurrency)

  // Carryovers arrive as reversed pseudo-settlements: the creditor "sent", the debtor "received".
  // Split them back out so they are never described as payments.
  const usableCarryovers = partitionCarryovers(carryovers, baseCurrency, ledgerIds).usable
  const carriedOver: CarriedOver[] = usableCarryovers
    .filter((c) => c.from_user_id === currentUserId || c.to_user_id === currentUserId)
    .map((c) => ({
      id: c.id,
      tripLabel: input.carryoverTripNames?.[c.source_trip_id]?.trim() || 'another trip',
      amount: c.amount,
      direction: c.from_user_id === currentUserId ? ('owed_by_you' as const) : ('owed_to_you' as const),
      otherPartyName: nameOf(c.from_user_id === currentUserId ? c.to_user_id : c.from_user_id),
    }))
  const carryCreditMinor = usableCarryovers.filter((c) => c.to_user_id === currentUserId).reduce((acc, c) => acc + toMinorUnits(c.amount, baseCurrency), 0)
  const carryDebtMinor = usableCarryovers.filter((c) => c.from_user_id === currentUserId).reduce((acc, c) => acc + toMinorUnits(c.amount, baseCurrency), 0)
  const sentConfirmed = fromMinorUnits((mine?.settlementsPaidMinor ?? 0) - carryCreditMinor, baseCurrency)
  const receivedConfirmed = fromMinorUnits((mine?.settlementsReceivedMinor ?? 0) - carryDebtMinor, baseCurrency)
  const netMinor = mine?.netBalanceMinor ?? 0
  const { youOwe, owedToYou } = splitOwedAmounts(netMinor, baseCurrency)
  const net = owedToYou > 0 ? owedToYou : youOwe > 0 ? -youOwe : 0 // never -0

  // Payments by status (real settlements only; carryovers are described separately).
  const toPayment = (s: Settlement, counterpartyId: string): PositionPayment => ({
    id: s.id,
    counterpartyId,
    counterpartyName: nameOf(counterpartyId),
    amount: s.amount,
    currency: s.currency || baseCurrency,
    status: s.status === 'suggested' ? 'suggested' : s.status === 'marked_paid' ? 'marked_paid' : 'confirmed',
    // Only meaningful while marked paid; a stale flag on any other status is ignored.
    disputed: s.status === 'marked_paid' && !!s.receipt_disputed_at,
  })
  const sentPayments = settlements.filter((s) => s.from_user_id === currentUserId).map((s) => toPayment(s, s.to_user_id))
  const receivedPayments = settlements.filter((s) => s.to_user_id === currentUserId).map((s) => toPayment(s, s.from_user_id))

  // Base-currency minor units of a payment: base as-is, other currencies only with a rate, else null (excluded).
  let waitingConverted = false
  const baseMinorOf = (p: PositionPayment): number | null => {
    if (p.currency === baseCurrency) return toMinorUnits(p.amount, baseCurrency)
    const rate = input.fxRates?.[p.currency]
    if (rate == null || !Number.isFinite(rate) || rate <= 0) return null
    if (p.status === 'marked_paid') waitingConverted = true
    return toMinorUnits(p.amount * rate, baseCurrency)
  }
  const totalOf = (list: PositionPayment[], status: PaymentStatus): number =>
    fromMinorUnits(
      list.filter((p) => p.status === status).reduce((acc, p) => acc + (baseMinorOf(p) ?? 0), 0),
      baseCurrency
    )
  const excludedForeign = [...sentPayments, ...receivedPayments].filter((p) => p.status !== 'confirmed' && baseMinorOf(p) == null)
  const sentWaiting = totalOf(sentPayments, 'marked_paid')
  const receivedWaiting = totalOf(receivedPayments, 'marked_paid')
  const sentSuggested = totalOf(sentPayments, 'suggested')
  const receivedSuggested = totalOf(receivedPayments, 'suggested')

  const kind = position.kind
  const ledgerAmount = position.amount
  const remainingToPay = kind === 'owe' ? Math.max(fromMinorUnits(toMinorUnits(ledgerAmount, baseCurrency) - toMinorUnits(sentWaiting, baseCurrency), baseCurrency), 0) : 0
  const remainingToReceive = kind === 'owed' ? Math.max(fromMinorUnits(toMinorUnits(ledgerAmount, baseCurrency) - toMinorUnits(receivedWaiting, baseCurrency), baseCurrency), 0) : 0

  const waitingOn = sentPayments.filter((p) => p.status === 'marked_paid' && baseMinorOf(p) != null).map((p) => p.counterpartyName)
  const approx = waitingConverted ? '≈' : ''
  // A payment the receiver has said hasn't arrived still counts as sent/waiting; only the wording changes.
  const disputedOf = (list: PositionPayment[]) => list.filter((p) => p.status === 'marked_paid' && p.disputed && baseMinorOf(p) != null)
  const sumOf = (list: PositionPayment[]) => fromMinorUnits(list.reduce((acc, p) => acc + (baseMinorOf(p) ?? 0), 0), baseCurrency)
  const sentDisputed = disputedOf(sentPayments)
  const receivedDisputed = disputedOf(receivedPayments)
  const sentDisputedNote = sentDisputed.length > 0 ? `${nameList(sentDisputed.map((p) => p.counterpartyName))} says ${approx}${money(sumOf(sentDisputed))} hasn't arrived` : null
  const sentNote =
    sentWaiting > 0 ? `${approx}${money(sentWaiting)} sent — waiting for ${nameList(waitingOn)} to confirm${sentDisputedNote ? ` · ${sentDisputedNote}` : ''}` : null
  const receivedOpen = receivedPayments.filter((p) => p.status === 'marked_paid' && !p.disputed && baseMinorOf(p) != null)
  const receivedOpenNames = receivedOpen.map((p) => p.counterpartyName)
  const receivedOpenNote =
    receivedOpen.length > 0
      ? `${nameList(receivedOpenNames)} ${new Set(receivedOpenNames).size > 1 ? 'say' : 'says'} they've paid you ${approx}${money(sumOf(receivedOpen))} — confirm receipt`
      : null
  const receivedDisputedNote =
    receivedDisputed.length > 0
      ? `You said ${approx}${money(sumOf(receivedDisputed))} from ${nameList(receivedDisputed.map((p) => p.counterpartyName))} hasn't arrived — waiting for ${nameList(receivedDisputed.map((p) => p.counterpartyName))}`
      : null
  const receivedNote = receivedWaiting > 0 ? [receivedOpenNote, receivedDisputedNote].filter(Boolean).join(' · ') || null : null

  // Money sent beyond the debt (typically payments recorded twice): never "nothing more to pay".
  const overpaidMinor =
    kind === 'owe' || kind === 'settled' ? Math.max(toMinorUnits(sentWaiting, baseCurrency) - toMinorUnits(kind === 'owe' ? ledgerAmount : 0, baseCurrency), 0) : 0
  const overpaid = fromMinorUnits(overpaidMinor, baseCurrency)
  const hasDuplicatePayments = findDuplicatePayments(settlements, baseCurrency).some((g) => g.from === currentUserId || g.to === currentUserId)

  let headline: PositionHeadline
  if (overpaid > 0) {
    const but = kind === 'owe' ? ` but you only owe ${money(ledgerAmount)}` : ''
    headline = {
      kind: 'overpaid',
      amount: overpaid,
      text: `You've sent ${approx}${money(overpaid)} more than you owe`,
      note: `${approx}${money(sentWaiting)} sent, waiting for ${nameList(waitingOn)} to confirm${but}`,
    }
  } else if (kind === 'owe') {
    if (remainingToPay > 0) {
      headline = { kind: 'owe', amount: remainingToPay, text: `You owe ${money(remainingToPay)}`, note: sentNote }
    } else if (sentWaiting > 0) {
      headline = { kind: 'sent_waiting', amount: sentWaiting, text: sentNote as string, note: null }
    } else {
      headline = { kind: 'owe', amount: ledgerAmount, text: `You owe ${money(ledgerAmount)}`, note: null }
    }
  } else if (kind === 'owed') {
    if (remainingToReceive > 0) {
      headline = { kind: 'owed', amount: remainingToReceive, text: `You're owed ${money(remainingToReceive)}`, note: receivedNote }
    } else if (receivedWaiting > 0) {
      headline = { kind: 'confirm_receipt', amount: receivedWaiting, text: receivedNote as string, note: null }
    } else {
      headline = { kind: 'owed', amount: ledgerAmount, text: `You're owed ${money(ledgerAmount)}`, note: null }
    }
  } else if (sentWaiting > 0) {
    headline = { kind: 'sent_waiting', amount: sentWaiting, text: sentNote as string, note: receivedNote }
  } else if (receivedWaiting > 0) {
    headline = { kind: 'confirm_receipt', amount: receivedWaiting, text: receivedNote as string, note: null }
  } else {
    headline = { kind: 'settled', amount: 0, text: 'All square', note: null }
  }

  // Frozen: the pay to-dos are the suggested rows from you. If they no longer add up to what the live
  // ledger says you still owe, the headline must not contradict them (and never says "square").
  const suggestedMinor = sentPayments
    .filter((p) => p.status === 'suggested' && p.currency === baseCurrency)
    .reduce((acc, p) => acc + toMinorUnits(p.amount, baseCurrency), 0)
  const remainingMinor = toMinorUnits(remainingToPay, baseCurrency)
  const stale = !!input.frozen && suggestedMinor > 0 && suggestedMinor !== remainingMinor
  if (stale) {
    if (headline.kind === 'settled') {
      headline = { kind: 'stale', amount: fromMinorUnits(suggestedMinor, baseCurrency), text: STALE_BALANCES_NOTE, note: null }
    } else {
      headline = { ...headline, note: headline.note ? `${headline.note} · ${STALE_BALANCES_NOTE}` : STALE_BALANCES_NOTE }
    }
  }

  const terms: EquationTerm[] = [
    { key: 'paid', id: 'paid', label: 'You paid', amount: paid, sign: '+' },
    { key: 'share', id: 'share', label: 'your share', amount: share, sign: '−' },
  ]
  if (sentConfirmed > 0) terms.push({ key: 'sent', id: 'sent', label: 'you paid back', amount: sentConfirmed, sign: '+' })
  if (receivedConfirmed > 0) terms.push({ key: 'received', id: 'received', label: 'paid back to you', amount: receivedConfirmed, sign: '−' })
  for (const c of carriedOver) {
    terms.push({
      key: 'carried',
      id: `carried:${c.id}`,
      label: `carried over from ${c.tripLabel}`,
      amount: c.amount,
      sign: c.direction === 'owed_to_you' ? '+' : '−',
    })
  }

  const result = kind === 'owe' ? `you owe ${money(ledgerAmount)}` : kind === 'owed' ? `you're owed ${money(ledgerAmount)}` : 'all square'
  const equationText =
    terms
      .map((t, i) => (i === 0 ? `${t.label} ${money(t.amount)}` : `${t.sign} ${t.label} ${money(t.amount)}`))
      .join(' ') + ` = ${result}`

  return {
    currency: baseCurrency,
    paid,
    share,
    sentConfirmed,
    receivedConfirmed,
    net,
    kind,
    ledgerAmount,
    carriedOver,
    excludedForeign,
    waitingConverted,
    stale,
    frozen: !!input.frozen,
    sentPayments,
    receivedPayments,
    sentWaiting,
    receivedWaiting,
    sentSuggested,
    receivedSuggested,
    overpaid,
    hasDuplicatePayments,
    remainingToPay,
    remainingToReceive,
    headline,
    terms,
    equationText,
    expensesMissingRate,
    unclaimed,
  }
}
