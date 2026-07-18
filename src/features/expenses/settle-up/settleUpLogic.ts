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
import { computeBalances, carryoversToPseudoSettlements, partitionCarryovers } from '../lib/balances'
import { computePairwiseBreakdown } from '../money-space/moneyPosition'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementSnapshot, SettlementCarryover } from '../../../lib/queries/useSettlements'

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
 *
 * `carryovers` (already-folded settlement_carryovers rows for this trip)
 * are folded into the SAME computeBalances call used everywhere else, so a
 * folded cross-trip debt actually changes the suggested payment amounts --
 * not just the balances screen.
 */
export function computeSuggestedPayments(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  people: SettleUpPerson[],
  baseCurrency: string,
  simplify: boolean,
  carryovers: SettlementCarryover[] = []
): Transaction[] {
  const { balances } = computeBalances(
    expenses,
    settlements,
    people.map((p) => p.userId),
    baseCurrency,
    carryovers
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
    // Direct (non-minimized) mode: pairwise who-owes-whom straight from the
    // actual expense/settlement history, WITHOUT netting a debt through a
    // third party (previously both branches called minimizeTransactions
    // identically, making the simplify toggle a no-op). Reuses the exact
    // pairwise ledger MoneySpace's per-person breakdown is built on
    // (computePairwiseBreakdown), with usable carryovers folded in as
    // pseudo-settlements via the SAME partitionCarryovers rules
    // computeBalances applies, so figures stay in sync with the header.
    return computeDirectPayments(expenses, settlements, people, baseCurrency, carryovers)
  }

  return minimizeTransactions(personInputs, epsilon)
}

/**
 * Direct pairwise payments: for every participant, each counterparty they
 * NET owe (per computePairwiseBreakdown's ledger over expenses +
 * settlements) becomes one payment from them to that counterparty. Uses the
 * same BALANCE_EPSILON_MINOR threshold as the breakdown (1 minor unit,
 * matching balanceEpsilonMajor), so a settled pair never produces a
 * dust-amount payment.
 */
function computeDirectPayments(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  people: SettleUpPerson[],
  baseCurrency: string,
  carryovers: SettlementCarryover[]
): Transaction[] {
  const participantUserIds = people.map((p) => p.userId)
  const { usable: usableCarryovers } = partitionCarryovers(carryovers, baseCurrency, participantUserIds)
  const settlementsWithCarryovers =
    usableCarryovers.length > 0 ? [...settlements, ...carryoversToPseudoSettlements(usableCarryovers)] : settlements

  const nameOf = new Map(people.map((p) => [p.userId, p.name]))
  const transactions: Transaction[] = []
  for (const person of people) {
    const rows = computePairwiseBreakdown(expenses, settlementsWithCarryovers, participantUserIds, person.userId, baseCurrency)
    for (const row of rows) {
      // Negative netMinor = this person owes that counterparty. Only the
      // debtor side emits the payment, so each pair appears exactly once.
      if (row.netMinor < 0) {
        transactions.push({
          from: person.userId,
          to: row.userId,
          fromName: nameOf.get(person.userId) ?? person.userId,
          toName: nameOf.get(row.userId) ?? row.userId,
          amount: fromMinorUnits(-row.netMinor, baseCurrency),
        })
      }
    }
  }
  return transactions
}

export function getMyTransactions(allTransactions: Transaction[], userId: string) {
  return getUserTransactions(allTransactions, userId)
}

/** True once every participant's net balance is within epsilon of zero. */
export function isFullySettled(
  people: SettleUpPerson[],
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  baseCurrency: string,
  carryovers: SettlementCarryover[] = []
): boolean {
  const { balances } = computeBalances(expenses, settlements, people.map((p) => p.userId), baseCurrency, carryovers)
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
