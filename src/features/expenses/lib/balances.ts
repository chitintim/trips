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
 * Unclaimed itemised value (receipts 2026-11): money on a receipt that nobody
 * has claimed is owed by nobody, so it used to leave the ledger summing to +U
 * with the payer silently absorbing it. It is now the payer's own share until
 * it is shared (`pendingUnclaimedMinor`, per person and per receipt), so the
 * ledger always sums to exactly zero and the payer's credit never includes
 * money no one owes. Rounding dust (claims that differ from the line value by
 * pennies) goes to the same bucket and is exposed as `dustMinor`; what any
 * claimer owes is never changed. Fully claimed receipts without dust compute
 * exactly as before.
 *
 * All arithmetic here is done in the expense's own currency exponent via
 * src/lib/money (integer minor units), converted to base-currency minor
 * units using the resolved rate, then summed as integers -- no float drift.
 */
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
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
  /**
   * Part of `totalOwedMinor`: itemised-receipt value nobody has claimed (yet),
   * counted as the PAYER's own share until it is shared, plus rounding dust.
   * Always 0 for people who paid for no itemised receipt. Signed (an
   * over-claimed receipt makes it negative) so the ledger sums to exactly zero.
   */
  pendingUnclaimedMinor: number
}

/** Where a claim row came from. Rows written before the claims v2 migration have no `source`: those are 'self'. */
export type ClaimSource = 'self' | 'on_behalf' | 'shared' | 'leftover'

export function claimSource(claim: { source?: string | null }): ClaimSource {
  const s = claim.source
  return s === 'on_behalf' || s === 'shared' || s === 'leftover' ? s : 'self'
}

/**
 * A person has ONE claim row per line (the database keeps unique (line_item_id, user_id)). The part of that row that came from sharing the
 * leftovers is `leftover_quantity` / `leftover_amount`; the rest is the person's OWN claim. Both columns are added by the receipt-claims
 * migration, so before it is applied (or for rows written by an old client) they are absent and read as 0: the whole row is the person's own.
 */
type ClaimParts = { quantity_claimed: number; amount_owed: number; leftover_quantity?: number | null; leftover_amount?: number | null }

function nonNegative(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** The leftover share inside this row, in units of the line (hundredths). */
export function claimLeftoverQuantity(c: Pick<ClaimParts, 'leftover_quantity'>): number {
  return nonNegative(c.leftover_quantity)
}

/** The leftover share inside this row, in the expense currency. */
export function claimLeftoverAmount(c: Pick<ClaimParts, 'leftover_amount'>): number {
  return nonNegative(c.leftover_amount)
}

/** The person's own quantity on the line: quantity_claimed minus the leftover share (hundredths, never below 0). */
export function claimOwnQuantity(c: Pick<ClaimParts, 'quantity_claimed' | 'leftover_quantity'>): number {
  return Math.max(0, Math.round((c.quantity_claimed - claimLeftoverQuantity(c)) * 100) / 100)
}

/** The person's own amount on the line: amount_owed minus the leftover share (never below 0). */
export function claimOwnAmount(c: Pick<ClaimParts, 'amount_owed' | 'leftover_amount'>): number {
  return Math.max(0, Math.round((c.amount_owed - claimLeftoverAmount(c)) * 100) / 100)
}

/** True when the row holds a claim of the person's own (not only a share of the leftovers). */
export function hasOwnClaim(c: Pick<ClaimParts, 'quantity_claimed' | 'leftover_quantity'>): boolean {
  return claimOwnQuantity(c) > 0
}

/**
 * How much of one itemised receipt has an owner. All `*Minor` fields are in
 * the trip's BASE currency (the ledger's unit); `unclaimedOwnMinor` and
 * `currency` are the receipt's own currency, for printing "EUR 48.00".
 *
 *   totalMinor    what the payer paid (base)
 *   claimedMinor  sum of every claim's amount_owed (base), whoever made it,
 *                 leftover rows included
 *   pendingMinor  totalMinor - claimedMinor, signed. This is exactly what is
 *                 added to the payer's owed so the ledger sums to zero.
 *   unclaimedMinor the part of pendingMinor that is REAL unclaimed value: money
 *                 on lines that still have quantity nobody took (>= 0)
 *   dustMinor     pendingMinor - unclaimedMinor: rounding residue on lines that
 *                 are fully claimed (or an over-claim). Small and signed.
 */
export interface ReceiptClaimStatus {
  expenseId: string
  description: string
  paidBy: string
  currency: string
  /** expense_allocation_links.code: the receipt's claim page is /claim/<code>. */
  claimCode: string | null
  totalMinor: number
  claimedMinor: number
  /** Part of claimedMinor that arrived as the leftover share inside people's rows (leftover_amount; shared out at the end). */
  leftoverClaimedMinor: number
  pendingMinor: number
  unclaimedMinor: number
  dustMinor: number
  /** Real unclaimed value in the receipt's own currency (what the receipt itself says is left). */
  unclaimedOwnMinor: number
  /**
   * Own-currency value left on lines by the raw rule (line total minus claimed
   * amount_owed, summed over lines, over-claimed lines count as 0), dust
   * included. Informational only: nothing in the UI gates on it, use
   * `unclaimedOwnMinor` (see isLineReallyUnclaimed).
   */
  shortfallOwnMinor: number
}

export interface BalanceComputationResult {
  balances: ParticipantBalance[]
  /** Every itemised receipt that counted in the ledger, with its claimed / unclaimed split. */
  receipts: ReceiptClaimStatus[]
  /** Receipts with real unclaimed value (unclaimedMinor > 0), largest first. */
  unclaimedReceipts: ReceiptClaimStatus[]
  /** Sum of pendingMinor over all receipts (what sits in payers' pendingUnclaimedMinor). */
  pendingUnclaimedTotalMinor: number
  /** Sum of unclaimedMinor over all receipts. */
  unclaimedTotalMinor: number
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

/** A line counts as fully claimed when at most this much quantity is left (claim steps are hundredths; thirds leave 0.01). */
const LINE_QUANTITY_TOLERANCE = 0.011

/**
 * THE client rule for "is this line unclaimed?" (used by balances, the header
 * and Settle up notices, the Freeze dialog gate and the claim page).
 *
 * A line whose claimed QUANTITY is complete (within LINE_QUANTITY_TOLERANCE) is
 * fully claimed: a few minor units of amount dust left over from legacy
 * per-claim rounding (0.33 x 3, 7-way JPY splits) is not "unclaimed". It is
 * absorbed invisibly into the payer's pending bucket and never listed, never
 * blocks and never opens a dialog. "A few" = the value of the quantity
 * tolerance itself (0.33 x 3 of a line leaves 0.01 of a unit, i.e. about 1% of
 * the line) plus one minor unit per claim row on the line; anything larger on
 * a fully claimed line (an edited line total) is real money nobody owes, so it
 * still counts. A line with real quantity left counts for all of its missing value.
 */
export function isLineReallyUnclaimed(lineQuantity: number, claimedQuantity: number, leftMinor: number, claimRows: number, lineTotalMinor: number): boolean {
  if (leftMinor <= 0 || lineQuantity <= 0) return false
  // Rounded to 6 places so float noise (1.001 - 0.99 = 0.011000000000000010) cannot disagree with the server's exact numeric maths.
  if (Math.round((lineQuantity - claimedQuantity) * 1e6) / 1e6 > LINE_QUANTITY_TOLERANCE) return true
  // The 1e-9 guard keeps 1000 * 0.011 (= 11.000000000000002 in floats) at 11, as in SQL: ceil(abs(total) * 0.011 / quantity).
  const dustAllowance = Math.max(1, claimRows) + Math.ceil((Math.abs(lineTotalMinor) * LINE_QUANTITY_TOLERANCE) / lineQuantity - 1e-9)
  return leftMinor > dustAllowance
}

export function isItemizedExpense(expense: ExpenseWithDetails): boolean {
  return !!expense.ai_parsed && !!expense.status && expense.line_items.length > 0
}

/**
 * Splits one itemised receipt into claimed / unclaimed / dust, per the rules in
 * ReceiptClaimStatus. Returns null when the receipt is not itemised or cannot
 * be converted to the base currency. Never changes what any claimer owes: it
 * only describes the difference between what was paid and what was claimed.
 */
export function analyseReceiptClaims(expense: ExpenseWithDetails, baseCurrency: string): ReceiptClaimStatus | null {
  if (!isItemizedExpense(expense)) return null
  const rate = resolveExpenseRate(expense, baseCurrency)
  if (rate == null) return null
  const own = expense.currency
  const totalMinor = toMinorUnits(expense.amount * rate, baseCurrency)

  let claimedMinor = 0
  let leftoverClaimedMinor = 0
  const qtyByLine = new Map<string, number>()
  const ownMinorByLine = new Map<string, number>()
  for (const c of expense.claims) {
    const base = toMinorUnits(c.amount_owed * rate, baseCurrency)
    claimedMinor += base
    leftoverClaimedMinor += toMinorUnits(claimLeftoverAmount(c) * rate, baseCurrency)
    qtyByLine.set(c.line_item_id, (qtyByLine.get(c.line_item_id) ?? 0) + c.quantity_claimed)
    ownMinorByLine.set(c.line_item_id, (ownMinorByLine.get(c.line_item_id) ?? 0) + toMinorUnits(c.amount_owed, own))
  }

  let unclaimedOwnMinor = 0
  let shortfallOwnMinor = 0
  const rowsByLine = new Map<string, number>()
  for (const c of expense.claims) rowsByLine.set(c.line_item_id, (rowsByLine.get(c.line_item_id) ?? 0) + 1)
  for (const line of expense.line_items) {
    const lineMinor = toMinorUnits(line.total_amount, own)
    const leftMinor = Math.max(0, lineMinor - (ownMinorByLine.get(line.id) ?? 0))
    shortfallOwnMinor += leftMinor
    if (isLineReallyUnclaimed(line.quantity, qtyByLine.get(line.id) ?? 0, leftMinor, rowsByLine.get(line.id) ?? 0, lineMinor)) unclaimedOwnMinor += leftMinor
  }

  const pendingMinor = totalMinor - claimedMinor
  const unclaimedOwnBaseMinor = own === baseCurrency ? unclaimedOwnMinor : toMinorUnits(fromMinorUnits(unclaimedOwnMinor, own) * rate, baseCurrency)
  const unclaimedMinor = Math.max(0, Math.min(unclaimedOwnBaseMinor, pendingMinor))
  return {
    expenseId: expense.id,
    description: expense.description,
    paidBy: expense.paid_by,
    currency: own,
    claimCode: expense.allocation_link?.code ?? null,
    totalMinor,
    claimedMinor,
    leftoverClaimedMinor,
    pendingMinor,
    unclaimedMinor,
    dustMinor: pendingMinor - unclaimedMinor,
    unclaimedOwnMinor: unclaimedMinor > 0 ? unclaimedOwnMinor : 0,
    shortfallOwnMinor,
  }
}

/** True when a receipt must be sorted out before balances can freeze: real unclaimed value. */
export function blocksFreeze(r: Pick<ReceiptClaimStatus, 'unclaimedOwnMinor'>): boolean {
  return r.unclaimedOwnMinor > 0
}

/**
 * The dust-tolerant "every item has an owner" test, the client twin of the server's _receipt_refresh_status: no line that has money on it has
 * more than LINE_QUANTITY_TOLERANCE of a unit unclaimed (0.33 x 3 leaves 0.01 and counts as claimed; zero-total lines are ignored). Use this, never
 * the exact comparison of the database trigger (expenses.status), to decide whether anything is left to claim.
 */
export function allLinesClaimedWithinDust(
  lines: ReadonlyArray<{ id: string; quantity: number; total_amount?: number | null }>,
  claims: ReadonlyArray<{ line_item_id: string; quantity_claimed: number }>
): boolean {
  const qty = new Map<string, number>()
  for (const c of claims) qty.set(c.line_item_id, (qty.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  return lines.every((l) => !((l.total_amount ?? 1) > 0) || Math.round((l.quantity - (qty.get(l.id) ?? 0)) * 1e6) / 1e6 <= LINE_QUANTITY_TOLERANCE)
}

/** Receipts the Freeze dialog gate lists: only real unclaimed value (see isLineReallyUnclaimed), never legacy dust. Largest first. */
export function findFreezeBlockingReceipts(expenses: ExpenseWithDetails[], baseCurrency: string): ReceiptClaimStatus[] {
  return expenses
    // A foreign-currency receipt with no FX rate cannot be converted, but its unclaimed items are still real: it is analysed (and
    // listed) in its OWN currency, exactly as the server does (rate 1, no conversion), never silently dropped.
    .map((e) => analyseReceiptClaims(e, baseCurrency) ?? (isItemizedExpense(e) ? analyseReceiptClaims(e, e.currency) : null))
    .filter((r): r is ReceiptClaimStatus => r != null && blocksFreeze(r))
    .sort((a, b) => b.pendingMinor - a.pendingMinor || a.expenseId.localeCompare(b.expenseId))
}

/** Itemised receipts with real unclaimed value, largest first. Pure; shared by every surface that warns about them. */
export function findUnclaimedReceipts(expenses: ExpenseWithDetails[], baseCurrency: string): ReceiptClaimStatus[] {
  return expenses
    .map((e) => analyseReceiptClaims(e, baseCurrency))
    .filter((r): r is ReceiptClaimStatus => r != null && r.unclaimedMinor > 0)
    .sort((a, b) => b.unclaimedMinor - a.unclaimedMinor || a.expenseId.localeCompare(b.expenseId))
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

/**
 * Everyone whose money actually moves in the ledger: payers, split members,
 * itemized claimants, parties to a REAL (non-pending) settlement and to a
 * carryover. Expenses with no resolvable FX rate are skipped because they
 * contribute nothing to the numbers. Used so that someone who left the trip
 * (trip_participants.active = false) with expense history still gets a
 * balance row -- otherwise their share silently vanishes and the remaining
 * balances stop summing to zero.
 */
export function collectMoneyUserIds(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  baseCurrency: string,
  carryovers: SettlementCarryover[] = []
): string[] {
  const ids = new Set<string>()
  for (const expense of expenses) {
    if (resolveExpenseRate(expense, baseCurrency) == null) continue
    ids.add(expense.paid_by)
    const isItemized = isItemizedExpense(expense)
    if (isItemized) for (const c of expense.claims) ids.add(c.user_id)
    else for (const sp of expense.splits) ids.add(sp.user_id)
  }
  for (const st of settlements) {
    if (st.status === 'suggested' || st.status === 'marked_paid') continue
    ids.add(st.from_user_id)
    ids.add(st.to_user_id)
  }
  for (const c of carryovers) {
    if (c.currency !== baseCurrency) continue
    ids.add(c.from_user_id)
    ids.add(c.to_user_id)
  }
  return [...ids]
}

/** Roster ids plus everyone else who appears in the money (deduplicated, roster first). */
export function withMoneyParticipants(
  rosterUserIds: string[],
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  baseCurrency: string,
  carryovers: SettlementCarryover[] = []
): string[] {
  return [...new Set([...rosterUserIds, ...collectMoneyUserIds(expenses, settlements, baseCurrency, carryovers)])]
}

/**
 * `participantUserIds` is the set of people the ledger is computed over;
 * money belonging to anyone NOT in it is dropped (and a carryover with a
 * party outside it is excluded whole, see partitionCarryovers). To keep the
 * ledger summing to zero, callers that present balances should pass
 * `withMoneyParticipants(activeIds, ...)` rather than only active people.
 */
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
  const pendingMinor = new Map<string, number>()
  const receipts: ReceiptClaimStatus[] = []
  let pendingTotalMinor = 0
  let unclaimedTotalMinor = 0
  for (const id of participantUserIds) {
    paidMinor.set(id, 0)
    owedMinor.set(id, 0)
    settlementsPaidMinor.set(id, 0)
    settlementsReceivedMinor.set(id, 0)
    pendingMinor.set(id, 0)
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

    const isItemized = isItemizedExpense(expense)

    if (isItemized) {
      // --- unclaimed value: nobody owes it yet, so until it is shared it is the PAYER's own share.
      // pendingMinor = paid - claimed (signed), which makes the ledger sum to exactly zero. ---
      const status = analyseReceiptClaims(expense, baseCurrency)
      if (status) {
        receipts.push(status)
        pendingTotalMinor += status.pendingMinor
        unclaimedTotalMinor += status.unclaimedMinor
        if (owedMinor.has(expense.paid_by)) {
          owedMinor.set(expense.paid_by, (owedMinor.get(expense.paid_by) ?? 0) + status.pendingMinor)
          pendingMinor.set(expense.paid_by, (pendingMinor.get(expense.paid_by) ?? 0) + status.pendingMinor)
        }
      }
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
      pendingUnclaimedMinor: pendingMinor.get(userId) ?? 0,
    }
  })

  const unclaimedReceipts = receipts
    .filter((r) => r.unclaimedMinor > 0)
    .sort((a, b) => b.unclaimedMinor - a.unclaimedMinor || a.expenseId.localeCompare(b.expenseId))
  return { balances, receipts, unclaimedReceipts, pendingUnclaimedTotalMinor: pendingTotalMinor, unclaimedTotalMinor, groupTotalMinor, expensesMissingRate }
}

/** Convenience: current user's "you owe" / "owed to you" split from their net balance, in base-currency major units. */
export function splitOwedAmounts(netBalanceMinor: number, baseCurrency: string): { youOwe: number; owedToYou: number } {
  if (netBalanceMinor >= 0) {
    return { youOwe: 0, owedToYou: fromMinorUnits(netBalanceMinor, baseCurrency) }
  }
  return { youOwe: fromMinorUnits(-netBalanceMinor, baseCurrency), owedToYou: 0 }
}
