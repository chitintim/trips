/**
 * Money position (UX_REDESIGN.md Part 4 "Money: balance-first, no inner
 * tabs" #1): the pure logic behind MoneySpace's position header — "You're
 * owed £84" / "You owe £42 → Settle" / "All square ✓" plus the per-person
 * breakdown expander. Built on the SAME `computeBalances`/`splitOwedAmounts`
 * functions the legacy BalanceHeader/SettleUpTab use, so the figures always
 * agree across every surface that shows money.
 */
import { computeBalances, splitOwedAmounts, BALANCE_EPSILON_MINOR, carryoversToPseudoSettlements } from '../lib/balances'
import { toMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'

export type MoneyPositionKind = 'owed' | 'owe' | 'settled'

export interface MoneyPositionPersonRow {
  userId: string
  /** Positive = they owe the current user; negative = current user owes them. */
  netMinor: number
}

export interface MoneyPosition {
  kind: MoneyPositionKind
  /** Major-unit amount matching `kind` ('settled' => 0). */
  amount: number
  currency: string
  /** Per-person breakdown, relative to the current user, sorted by absolute amount desc. Excludes the current user and settled (near-zero) pairs. */
  perPerson: MoneyPositionPersonRow[]
  expensesMissingRate: string[];
}

/**
 * Computes the current user's headline money position plus a per-person
 * breakdown of who they're net owed by / net owe, for the position header's
 * expander. Per-person figures come from a pairwise ledger over the SAME
 * expense/settlement data `computeBalances` uses (not a re-derivation), so a
 * 2-person breakdown always sums to the same net the headline shows.
 */
export function computeMoneyPosition(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  participantUserIds: string[],
  currentUserId: string | undefined,
  baseCurrency: string,
  carryovers: SettlementCarryover[] = []
): MoneyPosition {
  const { balances, expensesMissingRate } = computeBalances(expenses, settlements, participantUserIds, baseCurrency, carryovers)
  const mine = balances.find((b) => b.userId === currentUserId)
  const { youOwe, owedToYou } = splitOwedAmounts(mine?.netBalanceMinor ?? 0, baseCurrency)

  const kind: MoneyPositionKind = !mine || mine.isBalanced ? 'settled' : mine.netBalanceMinor > 0 ? 'owed' : 'owe'
  const amount = kind === 'owed' ? owedToYou : kind === 'owe' ? youOwe : 0

  // Same settlement-shaped list computeBalances just used above (real
  // settlements + folded carryovers) -- computePairwiseBreakdown has its own
  // independent settlements loop (not routed through computeBalances), so it
  // needs the merged list passed explicitly to stay in sync with the
  // headline figure.
  const settlementsWithCarryovers = carryovers.length > 0 ? [...settlements, ...carryoversToPseudoSettlements(carryovers)] : settlements
  const perPerson = computePairwiseBreakdown(expenses, settlementsWithCarryovers, participantUserIds, currentUserId, baseCurrency)

  return { kind, amount, currency: baseCurrency, perPerson, expensesMissingRate }
}

/**
 * Pairwise net breakdown between the current user and every other
 * participant: for each expense, the payer is credited and every other
 * split/claim contributor is debited against the payer specifically (not
 * just "the group"), then settlements between the two are applied the same
 * way. This mirrors computeBalances' totals exactly when summed, but keeps
 * the per-counterparty detail the position header's expander needs.
 *
 * Exported (not just used internally by computeMoneyPosition) because
 * useCarryoverCandidates reuses it to compute a TRUE pairwise net between
 * the current user and a specific other participant on a source trip,
 * instead of broadcasting that trip's group-level net balance to everyone.
 */
export function computePairwiseBreakdown(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  participantUserIds: string[],
  currentUserId: string | undefined,
  baseCurrency: string
): MoneyPositionPersonRow[] {
  if (!currentUserId) return []

  const net = new Map<string, number>() // otherUserId -> minor units they owe ME (can be negative)
  for (const id of participantUserIds) {
    if (id !== currentUserId) net.set(id, 0)
  }

  const resolveRate = (e: ExpenseWithDetails): number | null => {
    if (e.currency === baseCurrency) return 1
    return e.fx_rate ?? null
  }

  for (const expense of expenses) {
    const rate = resolveRate(expense)
    if (rate == null) continue

    const isItemized = !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0
    const contributions: Array<{ userId: string; amountOwnCurrency: number }> = isItemized
      ? expense.claims.map((c) => ({ userId: c.user_id, amountOwnCurrency: c.amount_owed }))
      : expense.splits.map((s) => ({ userId: s.user_id, amountOwnCurrency: s.amount }))

    for (const { userId, amountOwnCurrency } of contributions) {
      if (userId === expense.paid_by) continue // payer owing themselves nets to zero
      // Convert in MAJOR units first (own currency amount * rate), then to
      // base-currency minor units via the shared money module -- mirrors
      // computeBalances' toBaseMinor exactly, so this never drifts from the
      // headline total for zero/three-decimal currencies (JPY, BHD, etc).
      const amountMinor = toMinorUnits(amountOwnCurrency * rate, baseCurrency)

      if (expense.paid_by === currentUserId && net.has(userId)) {
        // They owe me for this expense.
        net.set(userId, (net.get(userId) ?? 0) + amountMinor)
      } else if (userId === currentUserId && net.has(expense.paid_by)) {
        // I owe the payer for this expense.
        net.set(expense.paid_by, (net.get(expense.paid_by) ?? 0) - amountMinor)
      }
    }
  }

  for (const s of settlements) {
    if (s.status === 'suggested' || s.status === 'marked_paid') continue
    // Settlements are recorded directly in trip base currency (see
    // computeBalances' equivalent comment) -- convert with the SAME
    // currency's exponent, not a hardcoded 2-decimal assumption.
    const amountMinor = toMinorUnits(s.amount, s.currency || baseCurrency)
    if (s.from_user_id === currentUserId && net.has(s.to_user_id)) {
      // I paid them -> mirrors computeBalances' settlement loop exactly
      // (from_user_id's netBalanceMinor is INCREASED by settlementsPaid):
      // transferring money always moves the payer's own net UP, whether
      // that means "I owe them less" (net[them] rises toward/through zero)
      // or "they now owe me more" (net[them] rises past zero). A previous
      // version of this branch SUBTRACTED here, which silently doubled a
      // debt instead of clearing it whenever the current user was the one
      // who paid a real settlement (bug fix -- no prior test exercised this
      // branch, since existing coverage only had the current user RECEIVE
      // settlements; see moneyPosition.test.ts for the regression test).
      net.set(s.to_user_id, (net.get(s.to_user_id) ?? 0) + amountMinor)
    } else if (s.to_user_id === currentUserId && net.has(s.from_user_id)) {
      // They paid me -> reduces what I'm owed by them.
      net.set(s.from_user_id, (net.get(s.from_user_id) ?? 0) - amountMinor)
    }
  }

  return Array.from(net.entries())
    .filter(([, amountMinor]) => Math.abs(amountMinor) >= BALANCE_EPSILON_MINOR)
    .map(([userId, netMinor]) => ({ userId, netMinor }))
    .sort((a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor))
}
