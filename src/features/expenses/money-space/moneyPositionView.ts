/**
 * Presentation for the Money header (proposal 4.6): turns the frozen
 * `explainMoneyPosition` result into the lines the header prints, so the
 * headline never says "You owe" for money already marked paid and the
 * arithmetic is visible. Pure; no maths beyond arranging the engine's figures.
 */
import { formatMoney } from '../../../lib/money/format'
import type { MoneyEquation } from '../../../lib/cost/moneyEquation'

export type PositionTone = 'owe' | 'owed' | 'waiting' | 'settled'

export interface EquationRowView {
  key: string
  /** "You paid", "Your share", ... */
  label: string
  /** Exact ledger amount, "£11,563.80". Null for text-only rows. */
  amount: string | null
  /** How it enters the sum; '=' marks a result row. */
  sign: '' | '+' | '−' | '='
  strong?: boolean
}

export interface MoneyPositionView {
  headline: string
  note: string | null
  tone: PositionTone
  rows: EquationRowView[]
  /** Small print under the rows (suggested-but-unpaid payments, frozen trips only). */
  footnote: string | null
  /** Payments in another currency that are not part of the sums above (no exchange rate): "¥5,000 marked paid to Sam isn't counted above (different currency)". */
  foreignNote: string | null
  /** "Some payments look recorded twice — check Settle up" when duplicate-looking payments involve you, else null. */
  settleHint: string | null
  /** Where the hint points (the Settle up deep link). */
  settleHintLink: string
  /** True only when truly settled (nothing owed either way, nothing waiting). */
  square: boolean
}

function who(names: string[]): string {
  const unique = [...new Set(names)]
  return unique.length === 1 ? unique[0] : `${unique.length} people`
}

export const DUPLICATE_PAYMENTS_HINT = 'Some payments look recorded twice — check Settle up'
export const SETTLE_UP_LINK = '?open=settle'

export function buildMoneyPositionView(eq: MoneyEquation): MoneyPositionView {
  const cur = eq.currency
  const money = (v: number) => formatMoney(v, cur, { mode: 'exact' })
  const h = eq.headline
  const square = h.kind === 'settled' && !eq.stale
  const tone: PositionTone = square ? 'settled' : h.kind === 'owe' || h.kind === 'overpaid' ? 'owe' : h.kind === 'owed' ? 'owed' : 'waiting'

  const rows: EquationRowView[] = []
  if (eq.paid > 0 || eq.share > 0 || eq.sentConfirmed > 0 || eq.receivedConfirmed > 0 || eq.carriedOver.length > 0) {
    rows.push({ key: 'paid', label: 'You paid for the group', amount: money(eq.paid), sign: '' })
    rows.push({ key: 'share', label: 'Your share of everything', amount: money(eq.share), sign: '−' })
    if (eq.sentConfirmed > 0) rows.push({ key: 'sent', label: 'Payments you sent (confirmed)', amount: money(eq.sentConfirmed), sign: '+' })
    if (eq.receivedConfirmed > 0) rows.push({ key: 'received', label: 'Payments you received (confirmed)', amount: money(eq.receivedConfirmed), sign: '−' })

    for (const c of eq.carriedOver) {
      rows.push({
        key: `carried:${c.id}`,
        label: c.direction === 'owed_by_you' ? `Carried over from ${c.tripLabel} (you owe ${c.otherPartyName})` : `Carried over from ${c.tripLabel} (${c.otherPartyName} owes you)`,
        amount: money(c.amount),
        sign: c.direction === 'owed_by_you' ? '−' : '+',
      })
    }

    // With unconfirmed payments below, this row is only the middle of the sum, so it must not read as the conclusion.
    const hasWaiting = eq.sentWaiting > 0 || eq.receivedWaiting > 0
    if (eq.kind === 'owe') rows.push({ key: 'ledger', label: hasWaiting ? 'Before the payments still to confirm, you owed' : 'So far you owe', amount: money(eq.ledgerAmount), sign: '=', strong: true })
    else if (eq.kind === 'owed') rows.push({ key: 'ledger', label: hasWaiting ? 'Before the payments still to confirm, you were owed' : "So far you're owed", amount: money(eq.ledgerAmount), sign: '=', strong: true })
    else rows.push({ key: 'ledger', label: 'Square on confirmed payments', amount: null, sign: '=', strong: true })
  }

  const waitingOn = eq.sentPayments.filter((p) => p.status === 'marked_paid').map((p) => p.counterpartyName)
  if (eq.sentWaiting > 0) {
    rows.push({ key: 'sent-waiting', label: `Sent, waiting for ${who(waitingOn)} to confirm`, amount: money(eq.sentWaiting), sign: '−' })
  }
  const waitingFrom = eq.receivedPayments.filter((p) => p.status === 'marked_paid').map((p) => p.counterpartyName)
  if (eq.receivedWaiting > 0) {
    rows.push({ key: 'received-waiting', label: `${who(waitingFrom)} say they've paid you, confirm receipt`, amount: money(eq.receivedWaiting), sign: '−' })
  }

  if (eq.sentWaiting > 0 || eq.receivedWaiting > 0) {
    if (eq.overpaid > 0) rows.push({ key: 'left', label: `You've sent ${money(eq.overpaid)} too much`, amount: null, sign: '=', strong: true })
    else if (eq.kind === 'owe') rows.push({ key: 'left', label: eq.remainingToPay > 0 ? 'Still to pay' : 'Nothing more to pay once confirmed', amount: eq.remainingToPay > 0 ? money(eq.remainingToPay) : null, sign: '=', strong: true })
    else if (eq.kind === 'owed') rows.push({ key: 'left', label: eq.remainingToReceive > 0 ? `You're owed ${money(eq.remainingToReceive)}` : 'Nothing more due once you confirm', amount: null, sign: '=', strong: true })
  }

  // Suggested rows only mean something while balances are frozen (computeTodos). Never printed next to "square".
  const suggested = eq.sentSuggested > 0 && !square && !eq.stale && eq.frozen ? `${money(eq.sentSuggested)} of suggested payments from you not paid yet` : null
  const foreign = eq.excludedForeign.map((p) => {
    const amount = formatMoney(p.amount, p.currency, { mode: 'exact' })
    const verb = p.status === 'suggested' ? 'suggested' : 'marked paid'
    return `${amount} ${verb} ${eq.sentPayments.some((x) => x.id === p.id) ? 'to' : 'by'} ${p.counterpartyName}`
  })
  const foreignNote = foreign.length > 0 ? `${foreign.join(', ')} ${foreign.length === 1 ? "isn't" : "aren't"} counted above (different currency)` : null
  return {
    headline: square ? "You're square ✓" : h.text,
    note: h.note,
    tone,
    rows,
    footnote: suggested,
    foreignNote,
    settleHint: eq.hasDuplicatePayments ? DUPLICATE_PAYMENTS_HINT : null,
    settleHintLink: SETTLE_UP_LINK,
    square,
  }
}
