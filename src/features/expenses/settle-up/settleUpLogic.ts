/**
 * Settle Up v2 logic (plan §12): freeze -> suggest -> record -> confirm ->
 * done, min-cash-flow suggestions (ported debtMinimization, opt-in),
 * cross-trip carryover folding. Reads legacy trips.settlement_snapshot for
 * backward compatibility with trips that already froze balances under v1
 * (coordinator note: v2 supersedes with the settlements-row status flow but
 * MUST keep reading legacy snapshots for a trip that already has one).
 */
import { minimizeTransactions, type Person, type Transaction } from '../../../lib/debtMinimization'
import { fromMinorUnits, toMinorUnits } from '../../../lib/money'

/** Matches computeBalances' BALANCE_EPSILON_MINOR=1 threshold, currency-aware (0.01 for GBP/USD/EUR, 1 for JPY, 0.001 for BHD/KWD/JOD/OMR) -- see the doc comment on minimizeTransactions' `epsilon` param for why a hardcoded 0.01 was wrong. */
export function balanceEpsilonMajor(currency: string): number {
  return fromMinorUnits(1, currency)
}
import { computeBalances, carryoversToPseudoSettlements, partitionCarryovers } from '../lib/balances'
import { computePairwiseBreakdown } from '../money-space/moneyPosition'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementSnapshot, SettlementCarryover } from '../../../lib/queries/useSettlements'

export interface SettleUpPerson {
  userId: string
  name: string
  /** Removed from the trip (active=false) but still appears in the money. */
  left?: boolean
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

/**
 * For each 'marked_paid' settlement (payer says they paid, awaiting the
 * payee's confirmation), compares the amount recorded when it was marked
 * paid against what today's LIVE (unfrozen) suggested-payments computation
 * would say for that from/to pair. A mismatch means expenses changed after
 * the payer marked it paid -- surfaced to the payee/organizer as a warning
 * so they can review before confirming. The row itself is never auto-
 * corrected or deleted; it's real payment history.
 *
 * Returns a map of settlementId -> recomputed live amount (0 if the pair no
 * longer owes anything at all).
 */
export function computePendingMismatches(
  settlements: Settlement[],
  liveSuggested: Transaction[],
  baseCurrency: string
): Map<string, number> {
  const live = new Map(liveSuggested.map((t) => [`${t.from}:${t.to}`, t.amount]))
  const map = new Map<string, number>()
  for (const s of settlements) {
    if (s.status !== 'marked_paid') continue
    const recomputed = live.get(`${s.from_user_id}:${s.to_user_id}`) ?? 0
    if (Math.abs(recomputed - s.amount) > balanceEpsilonMajor(s.currency ?? baseCurrency)) {
      map.set(s.id, recomputed)
    }
  }
  return map
}

/**
 * Treats payments the payer has already marked as paid (status 'marked_paid',
 * awaiting the receiver's confirmation) as sent, for the purpose of working out
 * what is STILL left to suggest. balances.ts deliberately counts only
 * 'confirmed' rows (money not yet confirmed is not yet a balance), so without
 * this a freeze or refreeze recomputes the same debts again and suggests them a
 * second time. Only rows in the trip's base currency are promoted: balances
 * have no per-row fx for settlements, so a payment in another currency cannot
 * honestly reduce a base-currency debt. The returned rows are for the maths
 * only, never written back.
 */
export function withSentPaymentsCounted(settlements: Settlement[], baseCurrency: string): Settlement[] {
  // A payment recorded twice is ONE payment: count one row per duplicate group
  // (and none when a confirmed row in the group is already in the balances).
  const notCounted = new Set<string>()
  for (const g of findDuplicatePayments(settlements, baseCurrency)) {
    const hasConfirmed = g.rows.some((r) => r.status === 'confirmed')
    g.rows.forEach((r, i) => {
      if (r.status === 'marked_paid' && (hasConfirmed || i > 0)) notCounted.add(r.id)
    })
  }
  return settlements.map((s) =>
    s.status === 'marked_paid' && !notCounted.has(s.id) && (s.currency ?? baseCurrency) === baseCurrency ? { ...s, status: 'confirmed' } : s
  )
}

/**
 * What is still left to pay: computeSuggestedPayments over the balances with
 * already-sent (marked_paid) base-currency payments counted. A pair that has
 * sent in full gets no suggestion, a partial payment shrinks it, and an
 * overpayment flips it into the reverse suggestion (never a negative amount).
 * Used for the pre-freeze list and for the rows a (re)freeze inserts. Do NOT
 * use it for computePendingMismatches, which must compare a pending row with
 * the debt as if that row did not exist.
 */
export function computeRemainingSuggestions(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  people: SettleUpPerson[],
  baseCurrency: string,
  simplify: boolean,
  carryovers: SettlementCarryover[] = []
): Transaction[] {
  return dedupeTransactions(
    computeSuggestedPayments(expenses, withSentPaymentsCounted(settlements, baseCurrency), people, baseCurrency, simplify, carryovers)
  )
}

/** Drops repeated identical (from, to, amount) suggestions so a freeze can never insert the same payment twice. */
export function dedupeTransactions(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>()
  return transactions.filter((t) => {
    const key = `${t.from}:${t.to}:${t.amount}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface DuplicatePaymentGroup {
  key: string
  from: string
  to: string
  amount: number
  currency: string
  /** Oldest first (by created_at, then id). Always at least two rows. */
  rows: Settlement[]
}

/** Two rows count as the same payment only if created within this window (mirrors remove_duplicate_settlement). */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Detection for payments recorded twice: two or more NON-suggested settlement
 * rows (marked_paid or confirmed) between the same pair with the same amount
 * and currency, each created within 24 hours of the previous one. It is only a
 * hint, since two genuine identical payments are possible, so nothing acts on
 * it automatically. Suggested rows are ignored (they are proposals, and a
 * refreeze replaces them). Rows further apart than 24h are separate payments.
 */
export function findDuplicatePayments(settlements: Settlement[], baseCurrency: string): DuplicatePaymentGroup[] {
  const groups = new Map<string, DuplicatePaymentGroup>()
  for (const s of settlements) {
    if (s.status === 'suggested') continue
    const currency = s.currency ?? baseCurrency
    const key = `${s.from_user_id}:${s.to_user_id}:${toMinorUnits(s.amount, currency)}:${currency}`
    const g = groups.get(key)
    if (g) g.rows.push(s)
    else groups.set(key, { key, from: s.from_user_id, to: s.to_user_id, amount: s.amount, currency, rows: [s] })
  }
  const out: DuplicatePaymentGroup[] = []
  for (const g of groups.values()) {
    if (g.rows.length < 2) continue
    const sorted = [...g.rows].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))
    let cluster: Settlement[] = []
    const flush = () => {
      if (cluster.length > 1) out.push({ ...g, key: `${g.key}:${cluster[0].id}`, rows: cluster })
      cluster = []
    }
    for (const r of sorted) {
      const prev = cluster[cluster.length - 1]
      if (prev && !withinDuplicateWindow(prev, r)) flush()
      cluster.push(r)
    }
    flush()
  }
  return out
}

/** True when two rows were created within 24h of each other (rows with no timestamp are assumed close). */
export function withinDuplicateWindow(a: Pick<Settlement, 'created_at'>, b: Pick<Settlement, 'created_at'>): boolean {
  if (!a.created_at || !b.created_at) return true
  return Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < DUPLICATE_WINDOW_MS
}

/**
 * Duplicate groups that still need a human: at least one row is not yet
 * confirmed (so it can be removed). Freeze is blocked while any exist, because
 * the amounts to suggest would otherwise rest on a payment that may not be real.
 * A group of only confirmed rows is already in the balances and cannot be
 * removed here, so it does not block.
 */
export function unresolvedDuplicateGroups(settlements: Settlement[], baseCurrency: string): DuplicatePaymentGroup[] {
  return findDuplicatePayments(settlements, baseCurrency).filter((g) => g.rows.some((r) => r.status === 'marked_paid'))
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
