/**
 * Money reads: get_my_money, get_balances, and the digest one-liner.
 *
 * Every figure comes from `computeBalances` (_shared/money/balances.ts, a byte
 * mirror of the client), over the SAME id set Settle up uses
 * (`withMoneyParticipants`). Suggested settlements are NOT paid, "marked paid"
 * waits for the receiver and is not in the balance: the client's rules, not a
 * re-derivation. The headline wording follows explainMoneyPosition
 * (src/lib/cost/moneyEquation.ts); see `myMoneyHeadline` for what is left out.
 */
import type { ToolCtx, ToolModule } from '../types.ts'
import {
  BALANCE_EPSILON_MINOR,
  computeBalances,
  carryoversToPseudoSettlements,
  partitionCarryovers,
  splitOwedAmounts,
  withMoneyParticipants,
  type BalanceComputationResult,
} from '../../../_shared/money/balances.ts'
import { fromMinorUnits, toMinorUnits } from '../../../_shared/money/minorUnits.ts'
import type { ExpenseWithDetails, Settlement } from '../../../_shared/money/balanceTypes.ts'
import type { SnapshotData } from '../../../_shared/todos/snapshot.ts'
import { S, dateWords, failed, loadData, moneyExact, nameOf, personName, readTool, settlementStatusWords, z } from './shared.ts'
import { wrap } from './questions.ts'

export interface MoneyComputation {
  data: SnapshotData
  base: string
  ledgerIds: string[]
  result: BalanceComputationResult
}

export function computeMoney(data: SnapshotData): MoneyComputation {
  const base = data.trip.base_currency
  const ledgerIds = withMoneyParticipants(
    data.participants.map((p) => p.user_id),
    data.expenses,
    data.settlements,
    base,
    data.carryovers
  )
  const result = computeBalances(data.expenses, data.settlements, ledgerIds, base, data.carryovers)
  return { data, base, ledgerIds, result }
}

// ---------------------------------------------------------------------------
// Per-person breakdown (port of computePairwiseBreakdown, moneyPosition.ts)
// ---------------------------------------------------------------------------

/** For each other person: minor units they owe ME (negative = I owe them). Same rules as the Money header's expander. */
export function pairwiseBreakdown(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  participantUserIds: string[],
  currentUserId: string,
  baseCurrency: string
): Array<{ userId: string; netMinor: number }> {
  const net = new Map<string, number>()
  for (const id of participantUserIds) if (id !== currentUserId) net.set(id, 0)

  for (const expense of expenses) {
    const rate = expense.currency === baseCurrency ? 1 : expense.fx_rate ?? null
    if (rate == null) continue
    const isItemized = !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0
    const contributions = isItemized
      ? expense.claims.map((c) => ({ userId: c.user_id, amountOwnCurrency: c.amount_owed }))
      : expense.splits.map((s) => ({ userId: s.user_id, amountOwnCurrency: s.amount }))
    for (const { userId, amountOwnCurrency } of contributions) {
      if (userId === expense.paid_by) continue
      const amountMinor = toMinorUnits(amountOwnCurrency * rate, baseCurrency)
      if (expense.paid_by === currentUserId && net.has(userId)) net.set(userId, (net.get(userId) ?? 0) + amountMinor)
      else if (userId === currentUserId && net.has(expense.paid_by)) net.set(expense.paid_by, (net.get(expense.paid_by) ?? 0) - amountMinor)
    }
  }

  for (const s of settlements) {
    if (s.status === 'suggested' || s.status === 'marked_paid') continue
    const amountMinor = toMinorUnits(s.amount, s.currency || baseCurrency)
    if (s.from_user_id === currentUserId && net.has(s.to_user_id)) net.set(s.to_user_id, (net.get(s.to_user_id) ?? 0) + amountMinor)
    else if (s.to_user_id === currentUserId && net.has(s.from_user_id)) net.set(s.from_user_id, (net.get(s.from_user_id) ?? 0) - amountMinor)
  }

  return Array.from(net.entries())
    .filter(([, m]) => Math.abs(m) >= BALANCE_EPSILON_MINOR)
    .map(([userId, netMinor]) => ({ userId, netMinor }))
    .sort((a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor))
}

// ---------------------------------------------------------------------------
// Headline (compact port of explainMoneyPosition's headline rules)
// ---------------------------------------------------------------------------

export type HeadlineKind = 'owe' | 'owed' | 'settled' | 'sent_waiting' | 'confirm_receipt' | 'overpaid'

export interface MyMoneyHeadline {
  kind: HeadlineKind
  /** Major units in the headline. */
  amount: number
  text: string
  note: string | null
  ledgerKind: 'owe' | 'owed' | 'settled'
  ledgerAmount: number
  paid: number
  share: number
  sentConfirmed: number
  receivedConfirmed: number
  sentWaiting: number
  receivedWaiting: number
  waitingFor: string[]
  /** Marked-paid money in another currency: not in any figure above (no exchange rate in the ledger). */
  excludedForeign: number
}

function nameList(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length === 0) return 'them'
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} other${unique.length - 2 === 1 ? '' : 's'}`
}

/**
 * The Money header's headline for one person. Follows explainMoneyPosition:
 * money already marked paid is never in a "You owe" figure, the maths is the
 * ledger's (computeBalances). Left out on purpose (the full UI covers them):
 * foreign-currency marked-paid money (counted in `excludedForeign` instead of
 * converted), the "hasn't arrived" dispute wording and the frozen "balances
 * changed" warning.
 */
export function myMoneyHeadline(m: MoneyComputation, ctx: Pick<ToolCtx, 'userId' | 'roster'>): MyMoneyHeadline {
  const { base, result, data } = m
  const money = (v: number) => moneyExact(v, base)
  const nameFor = (id: string) => ctx.roster.find((p) => p.userId === id)?.name?.trim() || 'someone'
  const mine = result.balances.find((b) => b.userId === ctx.userId)
  const net = mine?.netBalanceMinor ?? 0
  const { youOwe, owedToYou } = splitOwedAmounts(net, base)
  const ledgerKind: 'owe' | 'owed' | 'settled' = !mine || mine.isBalanced ? 'settled' : net > 0 ? 'owed' : 'owe'
  const ledgerAmount = ledgerKind === 'owed' ? owedToYou : ledgerKind === 'owe' ? youOwe : 0

  const sentMarked = data.settlements.filter((s) => s.from_user_id === ctx.userId && s.status === 'marked_paid')
  const receivedMarked = data.settlements.filter((s) => s.to_user_id === ctx.userId && s.status === 'marked_paid')
  const inBase = (s: Settlement) => (s.currency || base) === base
  const sumMinor = (list: Settlement[]) => list.filter(inBase).reduce((acc, s) => acc + toMinorUnits(s.amount, base), 0)
  const sentWaiting = fromMinorUnits(sumMinor(sentMarked), base)
  const receivedWaiting = fromMinorUnits(sumMinor(receivedMarked), base)
  const excludedForeign = [...sentMarked, ...receivedMarked].filter((s) => !inBase(s)).length
  const waitingFor = sentMarked.filter(inBase).map((s) => nameFor(s.to_user_id))

  const usable = partitionCarryovers(data.carryovers, base, m.ledgerIds).usable
  const carryCredit = usable.filter((c) => c.to_user_id === ctx.userId).reduce((a, c) => a + toMinorUnits(c.amount, base), 0)
  const carryDebt = usable.filter((c) => c.from_user_id === ctx.userId).reduce((a, c) => a + toMinorUnits(c.amount, base), 0)
  const sentConfirmed = fromMinorUnits((mine?.settlementsPaidMinor ?? 0) - carryCredit, base)
  const receivedConfirmed = fromMinorUnits((mine?.settlementsReceivedMinor ?? 0) - carryDebt, base)

  const remainingToPay = ledgerKind === 'owe' ? Math.max(fromMinorUnits(toMinorUnits(ledgerAmount, base) - toMinorUnits(sentWaiting, base), base), 0) : 0
  const remainingToReceive = ledgerKind === 'owed' ? Math.max(fromMinorUnits(toMinorUnits(ledgerAmount, base) - toMinorUnits(receivedWaiting, base), base), 0) : 0
  const sentNote = sentWaiting > 0 ? `${money(sentWaiting)} sent — waiting for ${nameList(waitingFor)} to confirm` : null
  const receivedNames = receivedMarked.filter(inBase).map((s) => nameFor(s.from_user_id))
  const receivedNote =
    receivedWaiting > 0
      ? `${nameList(receivedNames)} ${new Set(receivedNames).size > 1 ? 'say' : 'says'} they've paid you ${money(receivedWaiting)} — confirm receipt`
      : null
  const overpaidMinor =
    ledgerKind === 'owe' || ledgerKind === 'settled'
      ? Math.max(toMinorUnits(sentWaiting, base) - toMinorUnits(ledgerKind === 'owe' ? ledgerAmount : 0, base), 0)
      : 0
  const overpaid = fromMinorUnits(overpaidMinor, base)

  let kind: HeadlineKind
  let amount: number
  let text: string
  let note: string | null
  if (overpaid > 0) {
    kind = 'overpaid'
    amount = overpaid
    text = `You've sent ${money(overpaid)} more than you owe`
    note = `${money(sentWaiting)} sent, waiting for ${nameList(waitingFor)} to confirm${ledgerKind === 'owe' ? ` but you only owe ${money(ledgerAmount)}` : ''}`
  } else if (ledgerKind === 'owe') {
    if (remainingToPay > 0) {
      kind = 'owe'
      amount = remainingToPay
      text = `You owe ${money(remainingToPay)}`
      note = sentNote
    } else if (sentWaiting > 0) {
      kind = 'sent_waiting'
      amount = sentWaiting
      text = sentNote as string
      note = null
    } else {
      kind = 'owe'
      amount = ledgerAmount
      text = `You owe ${money(ledgerAmount)}`
      note = null
    }
  } else if (ledgerKind === 'owed') {
    if (remainingToReceive > 0) {
      kind = 'owed'
      amount = remainingToReceive
      text = `You're owed ${money(remainingToReceive)}`
      note = receivedNote
    } else if (receivedWaiting > 0) {
      kind = 'confirm_receipt'
      amount = receivedWaiting
      text = receivedNote as string
      note = null
    } else {
      kind = 'owed'
      amount = ledgerAmount
      text = `You're owed ${money(ledgerAmount)}`
      note = null
    }
  } else if (sentWaiting > 0) {
    kind = 'sent_waiting'
    amount = sentWaiting
    text = sentNote as string
    note = receivedNote
  } else if (receivedWaiting > 0) {
    kind = 'confirm_receipt'
    amount = receivedWaiting
    text = receivedNote as string
    note = null
  } else {
    kind = 'settled'
    amount = 0
    text = 'All square'
    note = null
  }

  return {
    kind,
    amount,
    text,
    note,
    ledgerKind,
    ledgerAmount,
    paid: fromMinorUnits(mine?.totalPaidMinor ?? 0, base),
    share: fromMinorUnits(mine?.totalOwedMinor ?? 0, base),
    sentConfirmed,
    receivedConfirmed,
    sentWaiting,
    receivedWaiting,
    waitingFor,
    excludedForeign,
  }
}

/** Short plain-words money line for the per-turn digest, e.g. "You owe £12.50 overall". null on any failure. Never throws. */
export async function computeMyMoneyLine(ctx: ToolCtx): Promise<string | null> {
  try {
    const data = await loadData(ctx)
    if (!data) return null
    const h = myMoneyHeadline(computeMoney(data), ctx)
    if (h.kind === 'owe' || h.kind === 'owed') return `${h.text} overall`
    return h.text
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Shared bits of money output
// ---------------------------------------------------------------------------

const FROZEN_NOTE = 'Balances are frozen: expenses are locked and the payments to make have been suggested. Suggested payments are not paid until the payer marks them paid and the receiver confirms.'

function frozen(data: SnapshotData): boolean {
  return data.trip.settlement_snapshot != null
}

function unclaimedNotes(m: MoneyComputation, onlyPaidBy?: string): Array<Record<string, unknown>> {
  return m.result.unclaimedReceipts
    .filter((r) => !onlyPaidBy || r.paidBy === onlyPaidBy)
    .map((r) => ({
      receipt: wrap(r.description),
      unclaimed: moneyExact(fromMinorUnits(r.unclaimedOwnMinor, r.currency), r.currency),
      note: "Nobody has claimed this yet. Until it's shared it counts as the payer's own share.",
    }))
}

// ---------------------------------------------------------------------------
// get_my_money
// ---------------------------------------------------------------------------

export const getMyMoneyTool: ToolModule = readTool({
  name: 'get_my_money',
  description:
    'What the signed-in person owes or is owed on this trip: the same headline as the Money page ("You owe £12.50", "£5.00 sent, waiting for Sam to confirm", "All square"), how it adds up (paid, share, payments sent and received), who they owe or are owed by, payments waiting to be confirmed, and receipts they paid for that nobody has claimed. Payments marked as sent are NOT in the balance until the receiver confirms. Suggested payments are not paid.',
  statusLabel: 'Checking your money…',
  access: 'money',
  inputSchema: S.object({}),
  schema: z.object({}).passthrough(),
  run: async (_args, ctx) => {
    const data = await loadData(ctx)
    if (!data) return failed()
    const m = computeMoney(data)
    const h = myMoneyHeadline(m, ctx)
    const base = m.base
    const money = (v: number) => moneyExact(v, base)
    const rows: string[] = []
    if (h.paid > 0 || h.share > 0 || h.sentConfirmed > 0 || h.receivedConfirmed > 0) {
      rows.push(`You paid for the group: ${money(h.paid)}`)
      rows.push(`Your share of everything: ${money(h.share)}`)
      if (h.sentConfirmed > 0) rows.push(`Payments you sent (confirmed): ${money(h.sentConfirmed)}`)
      if (h.receivedConfirmed > 0) rows.push(`Payments you received (confirmed): ${money(h.receivedConfirmed)}`)
    }
    const perPerson = pairwiseBreakdown(data.expenses, mergeSettlements(data, m), m.ledgerIds, ctx.userId, base).map((p) =>
      p.netMinor > 0 ? `${personName(ctx, p.userId)} owes you ${money(fromMinorUnits(p.netMinor, base))}` : `You owe ${personName(ctx, p.userId)} ${money(fromMinorUnits(-p.netMinor, base))}`
    )
    const waiting = data.settlements
      .filter((s) => (s.from_user_id === ctx.userId || s.to_user_id === ctx.userId) && s.status !== 'confirmed')
      .map((s) => ({
        payment: s.from_user_id === ctx.userId ? `You to ${personName(ctx, s.to_user_id)}` : `${personName(ctx, s.from_user_id)} to you`,
        amount: moneyExact(s.amount, s.currency || base),
        state: settlementStatusWords(s.status),
        ...(s.status === 'marked_paid' && s.receipt_disputed_at ? { note: 'The receiver says it has not arrived yet.' } : {}),
      }))
    return {
      content: {
        headline: h.text,
        ...(h.note ? { also: h.note } : {}),
        currency: base,
        how_it_adds_up: rows,
        per_person: perPerson,
        payments: waiting,
        unclaimed_receipts_you_paid_for: unclaimedNotes(m, ctx.userId),
        ...(h.excludedForeign > 0 ? { not_counted: `${h.excludedForeign} payment(s) in another currency are not included in these figures.` } : {}),
        ...(m.result.expensesMissingRate.length > 0 ? { warning: `${m.result.expensesMissingRate.length} expense(s) have no exchange rate yet and are left out of the figures.` } : {}),
        ...(frozen(data) ? { frozen: FROZEN_NOTE } : {}),
      },
    }
  },
})

export function mergeSettlements(data: SnapshotData, m: MoneyComputation): Settlement[] {
  const { usable } = partitionCarryovers(data.carryovers, m.base, m.ledgerIds)
  return usable.length > 0 ? [...data.settlements, ...carryoversToPseudoSettlements(usable)] : data.settlements
}

// ---------------------------------------------------------------------------
// get_balances (group view = Settle up)
// ---------------------------------------------------------------------------

export const getBalancesTool: ToolModule = readTool({
  name: 'get_balances',
  description:
    'Everyone\'s balance on this trip: the same numbers as the Settle up page. For each person what they paid, their share, payments sent and received, and whether they owe money or are owed. Payments that are only suggested, or marked as sent but not yet confirmed, are not counted in a balance. Also lists receipts nobody has claimed yet (counted as the payer\'s own share until shared).',
  statusLabel: 'Checking the balances…',
  access: 'money',
  inputSchema: S.object({}),
  schema: z.object({}).passthrough(),
  run: async (_args, ctx) => {
    const data = await loadData(ctx)
    if (!data) return failed()
    const m = computeMoney(data)
    const base = m.base
    const money = (v: number) => moneyExact(v, base)
    const balances = [...m.result.balances]
      .sort((a, b) => b.netBalanceMinor - a.netBalanceMinor)
      .map((b) => {
        const net = fromMinorUnits(Math.abs(b.netBalanceMinor), base)
        const left = !data.participants.some((p) => p.user_id === b.userId)
        return {
          person: nameOf(ctx, b.userId),
          ...(left ? { left_the_trip: true } : {}),
          paid: money(fromMinorUnits(b.totalPaidMinor, base)),
          share: money(fromMinorUnits(b.totalOwedMinor, base)),
          payments_sent: money(fromMinorUnits(b.settlementsPaidMinor, base)),
          payments_received: money(fromMinorUnits(b.settlementsReceivedMinor, base)),
          balance: b.isBalanced ? 'All square' : b.netBalanceMinor > 0 ? `Is owed ${money(net)}` : `Owes ${money(net)}`,
        }
      })
    const payments = data.settlements.map((s) => ({
      from: personName(ctx, s.from_user_id),
      to: personName(ctx, s.to_user_id),
      amount: moneyExact(s.amount, s.currency || base),
      state: settlementStatusWords(s.status),
      ...(s.settled_at && s.status === 'confirmed' ? { on: dateWords(s.settled_at.slice(0, 10)) } : {}),
    }))
    return {
      content: {
        currency: base,
        group_total_spent: money(fromMinorUnits(m.result.groupTotalMinor, base)),
        balances,
        payments,
        unclaimed_receipts: unclaimedNotes(m),
        ...(m.result.expensesMissingRate.length > 0 ? { warning: `${m.result.expensesMissingRate.length} expense(s) have no exchange rate yet and are left out of these numbers.` } : {}),
        ...(frozen(data) ? { frozen: FROZEN_NOTE } : {}),
      },
    }
  },
})
