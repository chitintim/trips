/**
 * Money position (UX_REDESIGN.md Part 4 "Money: balance-first, no inner
 * tabs" #1): the pure logic behind MoneySpace's position header — "You're
 * owed £84" / "You owe £42 → Settle" / "All square ✓" plus the per-person
 * breakdown expander. Built on the SAME `computeBalances`/`splitOwedAmounts`
 * functions the legacy BalanceHeader/SettleUpTab use, so the figures always
 * agree across every surface that shows money.
 */
import { computeBalances, splitOwedAmounts, BALANCE_EPSILON_MINOR, carryoversToPseudoSettlements, partitionCarryovers } from '../lib/balances'
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
 * Real settlements merged with the trip's USABLE folded carryovers (as
 * pseudo-settlements), filtered by the SAME partitionCarryovers rules
 * computeBalances applies internally. This is the settlement-shaped list
 * every pairwise computation must be fed to agree with the headline —
 * extracted so computeMoneyPosition AND the position header's per-pair
 * ledger expander build it identically instead of duplicating the merge.
 */
export function mergeSettlementsWithUsableCarryovers(
  settlements: Settlement[],
  carryovers: SettlementCarryover[],
  baseCurrency: string,
  participantUserIds: string[]
): Settlement[] {
  const { usable } = partitionCarryovers(carryovers, baseCurrency, participantUserIds)
  return usable.length > 0 ? [...settlements, ...carryoversToPseudoSettlements(usable)] : settlements
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
  // settlements + USABLE folded carryovers, filtered by the SAME
  // partitionCarryovers rules computeBalances applies internally) --
  // computePairwiseBreakdown has its own independent settlements loop (not
  // routed through computeBalances), so it needs the merged list passed
  // explicitly to stay in sync with the headline figure.
  const settlementsWithCarryovers = mergeSettlementsWithUsableCarryovers(settlements, carryovers, baseCurrency, participantUserIds)
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

export interface PairwiseLedgerEntry {
  /** Expense id, settlement id, or `carryover:<id>` (a folded pseudo-settlement -- see carryoversToPseudoSettlements). */
  id: string
  kind: 'expense' | 'payment' | 'carryover'
  /** Date-only (YYYY-MM-DD): expense payment_date / settlement settled_at. */
  date: string
  /** Expense description; empty for payments/carryovers (the UI derives their direction sentence from the sign + counterparty name). */
  label: string
  /** Settlement notes (e.g. "Pre-payment for the boat") -- payments only. */
  note: string | null
  /**
   * Signed base-currency minor units from the CURRENT USER's perspective:
   * positive raises what the counterparty owes them (their expense share on
   * something the user paid; a payment the user made to them), negative
   * lowers it. Sums (over non-pending entries) to the pair's
   * computePairwiseBreakdown netMinor exactly.
   */
  amountMinor: number
  /** True for 'marked_paid' payments: shown so nobody pays twice, but NOT counted in the pair's net (matches computeBalances). */
  pending: boolean
}

/**
 * The transactions COMPOSING one per-person balance ("why do I owe Salim
 * £120?"): every expense share between the pair plus every P2P payment
 * between them, newest first — the tappable detail behind
 * computePairwiseBreakdown's single net figure. Applies the exact same
 * per-expense/per-settlement rules as computePairwiseBreakdown (rate
 * resolution, itemized claims vs splits, payer-owing-self exclusion,
 * suggested rows skipped), so the non-pending entries always sum to the
 * netMinor the breakdown row shows — tested as an invariant.
 *
 * Callers that fold carryovers into balances must pass the SAME merged list
 * (mergeSettlementsWithUsableCarryovers) here; pseudo-settlement rows come
 * back as kind 'carryover' so the UI can label them as brought-forward debt
 * rather than an on-trip payment.
 */
export function computePairwiseLedger(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  currentUserId: string | undefined,
  otherUserId: string,
  baseCurrency: string
): PairwiseLedgerEntry[] {
  if (!currentUserId || currentUserId === otherUserId) return []

  const resolveRate = (e: ExpenseWithDetails): number | null => {
    if (e.currency === baseCurrency) return 1
    return e.fx_rate ?? null
  }

  const entries: PairwiseLedgerEntry[] = []

  for (const expense of expenses) {
    const rate = resolveRate(expense)
    if (rate == null) continue // missing FX rate: excluded from balances, so excluded here too (surfaced by the header's warning chip)
    if (expense.paid_by !== currentUserId && expense.paid_by !== otherUserId) continue

    const isItemized = !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0
    const contributions: Array<{ userId: string; amountOwnCurrency: number }> = isItemized
      ? expense.claims.map((c) => ({ userId: c.user_id, amountOwnCurrency: c.amount_owed }))
      : expense.splits.map((s) => ({ userId: s.user_id, amountOwnCurrency: s.amount }))

    // One entry per expense (a pair's stake in a single bill is one line,
    // even if the counterparty has several split/claim rows on it).
    let expenseNetMinor = 0
    for (const { userId, amountOwnCurrency } of contributions) {
      if (userId === expense.paid_by) continue // payer owing themselves nets to zero
      const amountMinor = toMinorUnits(amountOwnCurrency * rate, baseCurrency)
      if (expense.paid_by === currentUserId && userId === otherUserId) {
        expenseNetMinor += amountMinor // their share of something I paid
      } else if (expense.paid_by === otherUserId && userId === currentUserId) {
        expenseNetMinor -= amountMinor // my share of something they paid
      }
    }
    if (expenseNetMinor !== 0) {
      entries.push({
        id: expense.id,
        kind: 'expense',
        date: expense.payment_date,
        label: expense.description,
        note: null,
        amountMinor: expenseNetMinor,
        pending: false,
      })
    }
  }

  for (const s of settlements) {
    if (s.status === 'suggested') continue // proposals, not payments -- never part of a balance's composition
    const betweenPair =
      (s.from_user_id === currentUserId && s.to_user_id === otherUserId) ||
      (s.from_user_id === otherUserId && s.to_user_id === currentUserId)
    if (!betweenPair) continue
    const amountMinor = toMinorUnits(s.amount, s.currency || baseCurrency)
    entries.push({
      id: s.id,
      kind: s.id.startsWith('carryover:') ? 'carryover' : 'payment',
      date: (s.settled_at || s.created_at || '').slice(0, 10),
      label: '',
      note: s.notes,
      // Paying someone always moves the payer's net vs them UP -- identical
      // sign convention to computePairwiseBreakdown's settlement loop.
      amountMinor: s.from_user_id === currentUserId ? amountMinor : -amountMinor,
      pending: s.status === 'marked_paid',
    })
  }

  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
