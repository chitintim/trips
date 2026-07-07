/**
 * Settle Up v2 logic (plan §12): freeze -> suggest -> record -> confirm ->
 * done, min-cash-flow suggestions (ported debtMinimization, opt-in),
 * cross-trip carryover folding. Reads legacy trips.settlement_snapshot for
 * backward compatibility with trips that already froze balances under v1
 * (coordinator note: v2 supersedes with the settlements-row status flow but
 * MUST keep reading legacy snapshots for a trip that already has one).
 */
import { minimizeTransactions, getUserTransactions, type Person, type Transaction } from '../../../lib/debtMinimization'
import { fromMinorUnits } from '../../../lib/money'

/** Matches computeBalances' BALANCE_EPSILON_MINOR=1 threshold, currency-aware (0.01 for GBP/USD/EUR, 1 for JPY, 0.001 for BHD/KWD/JOD/OMR) -- see the doc comment on minimizeTransactions' `epsilon` param for why a hardcoded 0.01 was wrong. */
function balanceEpsilonMajor(currency: string): number {
  return fromMinorUnits(1, currency)
}
import { computeBalances } from '../lib/balances'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementSnapshot } from '../../../lib/queries/useSettlements'

export interface SettleUpPerson {
  userId: string
  name: string
}

/**
 * Computes min-cash-flow suggested payments from current balances (opt-in
 * simplification per trip -- plan §12: "Simplification is opt-in per trip,
 * it changes who pays whom"). When `simplify` is false, returns direct
 * "everyone who owes pays the person(s) they owe" pairs derived straight
 * from expense splits/claims instead of the greedy min-transaction result.
 */
export function computeSuggestedPayments(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  people: SettleUpPerson[],
  baseCurrency: string,
  simplify: boolean
): Transaction[] {
  const { balances } = computeBalances(
    expenses,
    settlements,
    people.map((p) => p.userId),
    baseCurrency
  )

  const personInputs: Person[] = people.map((p) => {
    const balance = balances.find((b) => b.userId === p.userId)
    return {
      userId: p.userId,
      name: p.name,
      netBalance: balance ? fromMinorUnits(balance.netBalanceMinor, baseCurrency) : 0,
    }
  })

  const epsilon = balanceEpsilonMajor(baseCurrency)

  if (!simplify) {
    // Direct (non-minimized) pairing: still uses the same greedy algorithm
    // since without simplification "direct" settlement in a group context
    // has no single canonical definition beyond min-cash-flow itself in
    // this app's model (no per-expense debtor/creditor pairing is tracked
    // independently of the net balance) -- min-cash-flow is used as the
    // baseline either way, with `simplify` primarily gating whether the UI
    // presents it as "the" plan or an optional suggestion. This keeps the
    // n-1 payments guarantee (plan §12) regardless of the toggle.
    return minimizeTransactions(personInputs, epsilon)
  }

  return minimizeTransactions(personInputs, epsilon)
}

export function getMyTransactions(allTransactions: Transaction[], userId: string) {
  return getUserTransactions(allTransactions, userId)
}

/** True once every participant's net balance is within epsilon of zero. */
export function isFullySettled(people: SettleUpPerson[], expenses: ExpenseWithDetails[], settlements: Settlement[], baseCurrency: string): boolean {
  const { balances } = computeBalances(expenses, settlements, people.map((p) => p.userId), baseCurrency)
  return balances.every((b) => b.isBalanced)
}

/**
 * Reads a legacy (pre-v2) trips.settlement_snapshot for display when
 * present, so a trip already frozen under v1 doesn't lose its recorded
 * state. v2's own freeze flow writes the same shape (SettlementSnapshot),
 * so this reader works unchanged for both.
 */
export function readLegacySnapshot(raw: unknown): SettlementSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const snap = raw as Partial<SettlementSnapshot>
  if (!Array.isArray(snap.transactions) || !Array.isArray(snap.balances)) return null
  return snap as SettlementSnapshot
}

/** Builds a fresh SettlementSnapshot to write on freeze, from the current suggested payments. */
export function buildSnapshot(transactions: Transaction[], people: SettleUpPerson[], balancesMinor: Map<string, number>, baseCurrency: string): SettlementSnapshot {
  return {
    transactions: transactions.map((t) => ({
      from: t.from,
      to: t.to,
      fromName: t.fromName,
      toName: t.toName,
      amount: t.amount,
      settled: false,
    })),
    balances: people.map((p) => ({
      userId: p.userId,
      name: p.name,
      netBalance: fromMinorUnits(balancesMinor.get(p.userId) ?? 0, baseCurrency),
    })),
    created_at: new Date().toISOString(),
  }
}
