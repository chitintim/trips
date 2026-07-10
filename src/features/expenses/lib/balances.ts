/**
 * Balance computation (the financial core of the Expenses tab + Settle Up).
 *
 * Ports the v1 ExpensesTab formula EXACTLY:
 *   netBalance = totalPaid − totalOwed + settlementsPaid − settlementsReceived
 *   (positive netBalance = this person is owed money; "balanced" = |net| < balance epsilon)
 *
 *   totalPaid   = Σ base-currency amount of expenses where paid_by = user
 *   totalOwed   = Σ base-currency amount of that user's expense_splits
 *               + Σ (itemized: claim.amount_owed × the expense's fx rate)
 *
 * v1 bug fixed here (do not reintroduce): when an expense has no FX rate
 * resolved yet (fx_rate null and currency != base_currency), v1 silently
 * contributed 0 to both totalPaid/totalOwed, quietly understating balances.
 * v2 instead EXCLUDES such an expense from the numeric totals but flags it
 * via `expensesMissingRate`, so callers can render a prominent "N expenses
 * missing FX rates" warning chip instead of a silently wrong number.
 *
 * All arithmetic here is done in the expense's own currency exponent via
 * src/lib/money (integer minor units), converted to base-currency minor
 * units using the resolved rate, then summed as integers -- no float drift.
 */
import { toMinorUnits, fromMinorUnits, sumMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement, SettlementCarryover } from '../../../lib/queries/useSettlements'

export const BALANCE_EPSILON_MINOR = 1 // 1 minor unit tolerance, matches v1's 0.01 GBP epsilon

export interface ParticipantBalance {
  userId: string
  totalPaidMinor: number
  totalOwedMinor: number
  settlementsPaidMinor: number
  settlementsReceivedMinor: number
  netBalanceMinor: number
  isBalanced: boolean
}

export interface BalanceComputationResult {
  balances: ParticipantBalance[]
  /** Base-currency minor-unit sum of every expense counted (excludes expensesMissingRate). */
  groupTotalMinor: number
  /** Expense ids that could not be converted to base currency (fx_rate null and currency != base) -- excluded from totals, must be surfaced as a warning, never silently zeroed. */
  expensesMissingRate: string[]
}

/** Resolves the effective base-currency rate for an expense, or null if unavailable (never defaults to 0/1 silently unless currency truly matches). */
function resolveExpenseRate(expense: ExpenseWithDetails, baseCurrency: string): number | null {
  if (expense.currency === baseCurrency) return 1
  if (expense.fx_rate != null) return expense.fx_rate
  return null
}

/**
 * Converts a MAJOR-unit amount in an expense's own currency to base-currency
 * minor units using its resolved rate. Returns null if no rate is
 * available (caller must treat as "missing", not zero).
 *
 * Deliberately takes a major-unit (decimal) amount, not minor units: source
 * and target currencies can have different minor-unit exponents (e.g. JPY
 * has 0 decimal places, GBP has 2), so "convert then round to minor units"
 * only produces a correct result when done in major units first -- scaling
 * an already-minor-unit JPY amount by a JPY->GBP rate and treating the
 * result as GBP minor units silently divides the answer by 100.
 */
function toBaseMinor(amountOwnCurrencyMajor: number, expense: ExpenseWithDetails, baseCurrency: string): number | null {
  const rate = resolveExpenseRate(expense, baseCurrency)
  if (rate == null) return null
  return toMinorUnits(amountOwnCurrencyMajor * rate, baseCurrency)
}

/**
 * Converts already-folded settlement_carryovers rows (plan §12) into
 * pseudo-Settlement objects so computeBalances / computePairwiseBreakdown
 * can fold them into the SAME math path a real settlement uses, instead of
 * needing a parallel code path.
 *
 * IMPORTANT — from_user_id/to_user_id are DELIBERATELY REVERSED relative to
 * the carryover row's own columns. A settlement_carryovers row records WHO
 * OWES WHOM (from_user_id = the debtor, to_user_id = the creditor -- see
 * handleFoldInCarryover in SettleUpTab.tsx): the debt is UNPAID. A real
 * `settlements` row instead records a CASH TRANSFER THAT ALREADY HAPPENED
 * (from_user_id physically paid to_user_id), which the settlement loop
 * below treats as REDUCING from_user_id's debt and to_user_id's claim.
 * Since a carryover has NOT been paid, folding it into the target trip must
 * INCREASE the debtor's outstanding balance and the creditor's claim --
 * exactly like an unpaid expense would, not like a payment that resolves
 * one. Feeding the row through unchanged would incorrectly cancel the debt
 * instead of carrying it forward, so from/to are swapped here to land on
 * the correct sign while reusing the settlement-shaped math untouched.
 */
export function carryoversToPseudoSettlements(carryovers: SettlementCarryover[]): Settlement[] {
  return carryovers.map((c) => ({
    id: `carryover:${c.id}`,
    trip_id: c.trip_id,
    from_user_id: c.to_user_id, // reversed -- see doc comment above
    to_user_id: c.from_user_id, // reversed -- see doc comment above
    amount: c.amount,
    currency: c.currency,
    status: 'confirmed',
    created_by: c.created_by,
    settled_at: c.created_at,
    created_at: c.created_at,
    notes: null,
    payment_method: null,
  }))
}

export interface CarryoverPartition {
  /** Rows safe to feed into this trip's balance math. */
  usable: SettlementCarryover[]
  /** Rows excluded because their currency differs from the trip's base currency. There is no FX-conversion path for carryovers (no fx_rate concept on them), and reading minor units 1:1 across currencies silently mis-states money -- e.g. a JPY 10,000 row folded into a GBP trip would be counted as GBP 100.00 (10000 JPY minor units re-read as pence) instead of its real ~GBP 52. Excluded rows must be surfaced to the user as "not included", never silently converted or silently counted. */
  excludedCurrency: SettlementCarryover[]
  /** Rows excluded because one (or both) of the from/to parties is not in the participant list being computed over. The settlement loops guard each side with .has() independently, so applying such a row would move only ONE side's balance and break the zero-sum invariant (and min-cash-flow suggestions would silently disagree with the header) -- the whole row is excluded instead. */
  excludedParticipant: SettlementCarryover[]
}

/**
 * Splits a trip's folded carryovers into rows the balance math can safely
 * use vs. rows that must be excluded (see CarryoverPartition field docs for
 * why each exclusion exists). computeBalances/computeMoneyPosition apply
 * this internally so every surface stays consistent without each caller
 * pre-filtering; SettleUpTab also calls it directly to render a visible
 * "N carryovers not included" note whenever anything was excluded.
 */
export function partitionCarryovers(
  carryovers: SettlementCarryover[],
  baseCurrency: string,
  participantUserIds: string[]
): CarryoverPartition {
  const participantIds = new Set(participantUserIds)
  const usable: SettlementCarryover[] = []
  const excludedCurrency: SettlementCarryover[] = []
  const excludedParticipant: SettlementCarryover[] = []
  for (const c of carryovers) {
    if (c.currency !== baseCurrency) {
      excludedCurrency.push(c)
    } else if (!participantIds.has(c.from_user_id) || !participantIds.has(c.to_user_id)) {
      excludedParticipant.push(c)
    } else {
      usable.push(c)
    }
  }
  return { usable, excludedCurrency, excludedParticipant }
}

export function computeBalances(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  participantUserIds: string[],
  baseCurrency: string,
  carryovers: SettlementCarryover[] = []
): BalanceComputationResult {
  const paidMinor = new Map<string, number>()
  const owedMinor = new Map<string, number>()
  const settlementsPaidMinor = new Map<string, number>()
  const settlementsReceivedMinor = new Map<string, number>()
  for (const id of participantUserIds) {
    paidMinor.set(id, 0)
    owedMinor.set(id, 0)
    settlementsPaidMinor.set(id, 0)
    settlementsReceivedMinor.set(id, 0)
  }

  // Mismatched-currency / missing-participant carryovers are excluded from
  // the math entirely (see partitionCarryovers) -- callers surface them.
  const { usable: usableCarryovers } = partitionCarryovers(carryovers, baseCurrency, participantUserIds)
  const allSettlements =
    usableCarryovers.length > 0 ? [...settlements, ...carryoversToPseudoSettlements(usableCarryovers)] : settlements

  const expensesMissingRate: string[] = []
  let groupTotalMinor = 0

  for (const expense of expenses) {
    const rate = resolveExpenseRate(expense, baseCurrency)

    if (rate == null) {
      expensesMissingRate.push(expense.id)
      continue // excluded from totals -- flagged, never silently zeroed into the numbers
    }

    const amountBaseMinor = toBaseMinor(expense.amount, expense, baseCurrency) ?? 0
    groupTotalMinor += amountBaseMinor

    // --- totalPaid: whoever paid gets credited the full base-currency amount ---
    if (paidMinor.has(expense.paid_by)) {
      paidMinor.set(expense.paid_by, (paidMinor.get(expense.paid_by) ?? 0) + amountBaseMinor)
    }

    const isItemized = !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0

    if (isItemized) {
      // --- totalOwed (itemized): each claimant owes their claimed amount, converted at this expense's rate ---
      for (const claim of expense.claims) {
        const claimBaseMinor = toBaseMinor(claim.amount_owed, expense, baseCurrency)
        if (claimBaseMinor == null) continue // same expense, same rate check already passed above, defensive only
        if (owedMinor.has(claim.user_id)) {
          owedMinor.set(claim.user_id, (owedMinor.get(claim.user_id) ?? 0) + claimBaseMinor)
        }
      }
    } else {
      // --- totalOwed (non-itemized): each split's own-currency amount converted at this expense's rate ---
      for (const split of expense.splits) {
        const splitBaseMinor = toBaseMinor(split.amount, expense, baseCurrency)
        if (splitBaseMinor == null) continue
        if (owedMinor.has(split.user_id)) {
          owedMinor.set(split.user_id, (owedMinor.get(split.user_id) ?? 0) + splitBaseMinor)
        }
      }
    }
  }

  for (const settlement of allSettlements) {
    // Only rows that represent a REAL, completed payment move money in the
    // ledger sense: v2's 'suggested'/'marked_paid' rows are proposals, not
    // yet confirmed transfers, so they're excluded here (they still show up
    // in the Settle Up tab's pending-action UI, just not in balances).
    // status defaults to 'confirmed' in the DB specifically so pre-v2 rows
    // (which had no status concept -- every recorded settlement WAS a
    // completed payment) keep contributing to balances unchanged.
    if (settlement.status === 'suggested' || settlement.status === 'marked_paid') continue
    const settlementCurrency = settlement.currency || baseCurrency
    const settlementMinor = toMinorUnits(settlement.amount, settlementCurrency)
    // Settlements are recorded directly in trip base currency (plan §12); if
    // a legacy row somehow used another currency, treat 1:1 rather than drop
    // it silently (rare path, no historical fx_rate concept on settlements).
    const baseMinor = settlementCurrency === baseCurrency ? settlementMinor : settlementMinor

    if (settlementsPaidMinor.has(settlement.from_user_id)) {
      settlementsPaidMinor.set(settlement.from_user_id, (settlementsPaidMinor.get(settlement.from_user_id) ?? 0) + baseMinor)
    }
    if (settlementsReceivedMinor.has(settlement.to_user_id)) {
      settlementsReceivedMinor.set(settlement.to_user_id, (settlementsReceivedMinor.get(settlement.to_user_id) ?? 0) + baseMinor)
    }
  }

  const balances: ParticipantBalance[] = participantUserIds.map((userId) => {
    const totalPaidMinor = paidMinor.get(userId) ?? 0
    const totalOwedMinor = owedMinor.get(userId) ?? 0
    const sPaid = settlementsPaidMinor.get(userId) ?? 0
    const sReceived = settlementsReceivedMinor.get(userId) ?? 0
    const netBalanceMinor = totalPaidMinor - totalOwedMinor + sPaid - sReceived
    return {
      userId,
      totalPaidMinor,
      totalOwedMinor,
      settlementsPaidMinor: sPaid,
      settlementsReceivedMinor: sReceived,
      netBalanceMinor,
      isBalanced: Math.abs(netBalanceMinor) < BALANCE_EPSILON_MINOR,
    }
  })

  return { balances, groupTotalMinor, expensesMissingRate }
}

/** Convenience: current user's "you owe" / "owed to you" split from their net balance, in base-currency major units. */
export function splitOwedAmounts(netBalanceMinor: number, baseCurrency: string): { youOwe: number; owedToYou: number } {
  if (netBalanceMinor >= 0) {
    return { youOwe: 0, owedToYou: fromMinorUnits(netBalanceMinor, baseCurrency) }
  }
  return { youOwe: fromMinorUnits(-netBalanceMinor, baseCurrency), owedToYou: 0 }
}

/** Sums a list of minor-unit amounts across possibly-different currencies is never valid -- this guards the group-total display path to same-currency (base) sums only. */
export function sumBaseCurrencyMinor(amounts: number[]): number {
  return sumMinorUnits(amounts)
}
