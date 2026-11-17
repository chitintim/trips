/**
 * Claim math: per-line available quantity, unclaimed remainder, and a
 * claimant's owed total for a line-item selection. Quantities are decimal
 * (shared dishes -- e.g. claiming 0.5 of a shared appetizer), matching the
 * legacy ClaimItemsPage's `expense_item_claims.quantity_claimed` semantics.
 */
import { toMinorUnits, fromMinorUnits, roundHalfAwayFromZero, largestRemainderDistribute } from '../../../lib/money'
import type { ExpenseLineItem, ExpenseItemClaim } from '../../../lib/queries/useExpenses'
import { isLineReallyUnclaimed, claimOwnQuantity, claimOwnAmount, hasOwnClaim } from '../lib/balances'

/**
 * Where a claim row came from. `source` / `created_by` / `shared_by_all` are
 * added by the receipt-claims migration; until it is applied they are simply
 * absent from the rows, so every reader treats them as optional.
 */
export type ClaimSource = 'self' | 'on_behalf' | 'shared' | 'leftover'
export type ClaimRow = ExpenseItemClaim & {
  source?: ClaimSource | string | null
  created_by?: string | null
  /** The part of quantity_claimed / amount_owed that came from sharing the leftovers (one row per person and line; absent before the migration). */
  leftover_quantity?: number | null
  leftover_amount?: number | null
}
export type LineRow = ExpenseLineItem & { shared_by_all?: boolean | null }

export interface LineClaimSummary {
  lineItem: ExpenseLineItem
  totalClaimed: number
  available: number
  isFullyClaimed: boolean
  myClaimed: number
}

const QUANTITY_EPSILON = 0.001

/**
 * A claim the whole-unit stepper can edit: the person's own (or put down by
 * someone else) whole-unit row, judged on the OWN part of the row (a leftover
 * share inside the row does not count). Shared shares, rows that only hold a
 * leftover share and legacy fractions are "fixed shares": shown, but changed
 * through the share picker.
 */
export function isStepperClaim(c: Pick<ClaimRow, 'quantity_claimed' | 'source' | 'leftover_quantity'>): boolean {
  return c.source !== 'shared' && c.source !== 'leftover' && hasOwnClaim(c) && isWholeQuantity(claimOwnQuantity(c))
}

export function summarizeLineClaims(
  lineItem: ExpenseLineItem,
  claimsForLine: ClaimRow[],
  currentUserId: string | undefined
): LineClaimSummary {
  const totalClaimed = claimsForLine.reduce((sum, c) => sum + c.quantity_claimed, 0)
  // A person has ONE row per line; its leftover part (if any) is not theirs to change with the stepper, so only the own part counts here.
  const myClaimed = claimsForLine
    .filter((c) => c.user_id === currentUserId && isStepperClaim(c))
    .reduce((sum, c) => sum + claimOwnQuantity(c), 0)
  const available = Math.max(0, lineItem.quantity - totalClaimed)

  return {
    lineItem,
    totalClaimed,
    available: available < QUANTITY_EPSILON ? 0 : available,
    isFullyClaimed: available < QUANTITY_EPSILON,
    myClaimed,
  }
}

/** Max quantity a user could claim on a line right now (their own existing claim plus whatever's still available). */
export function maxClaimableQuantity(summary: LineClaimSummary): number {
  return summary.available + summary.myClaimed
}

/**
 * A user's owed amount for a given claimed quantity on a line, pro-rated
 * from unit price (no tax/service proration here -- that's applied
 * afterwards via distributeAdjustmentsAcrossClaimants). Routed through the
 * money lib (integer minor units) rather than raw float division/
 * multiplication + a hardcoded *100/100 round, which silently broke for
 * zero-decimal currencies (JPY: 100 minor units, not 1) and 3-decimal ones
 * (BHD/KWD/JOD/OMR: 1000 minor units) -- both real trip base currencies
 * this app supports (see src/lib/money/currencyExponent.ts).
 */
export function amountOwedForQuantity(lineItem: ExpenseLineItem, quantity: number, currency: string): number {
  if (lineItem.quantity <= 0) return 0
  const totalMinor = toMinorUnits(lineItem.total_amount, currency)
  const owedMinor = roundHalfAwayFromZero((totalMinor / lineItem.quantity) * quantity)
  return fromMinorUnits(owedMinor, currency)
}

export interface OverallClaimProgress {
  totalItems: number
  claimedItems: number
  percentClaimed: number
  isFullyAllocated: boolean
}

export function summarizeOverallProgress(lineItems: ExpenseLineItem[], claims: ExpenseItemClaim[]): OverallClaimProgress {
  const totalItems = lineItems.reduce((sum, l) => sum + l.quantity, 0)
  const claimedByLine = new Map<string, number>()
  for (const c of claims) {
    claimedByLine.set(c.line_item_id, (claimedByLine.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  }
  const claimedItems = lineItems.reduce((sum, l) => sum + Math.min(l.quantity, claimedByLine.get(l.id) ?? 0), 0)
  const percentClaimed = totalItems > 0 ? (claimedItems / totalItems) * 100 : 0

  return { totalItems, claimedItems, percentClaimed, isFullyAllocated: percentClaimed >= 99.9 }
}

// ---------------------------------------------------------------------------
// Penny-exact line maths (client side; mirrors the server's largest remainder)
// ---------------------------------------------------------------------------

/** True when a stored quantity is a whole number of units (stored as numeric(10,2)). */
export function isWholeQuantity(q: number): boolean {
  return Math.abs(q - Math.round(q)) < 0.005
}

/**
 * Split one line's value equally between `userIds`, to the minor unit, so the
 * shares add up EXACTLY to the line value. Largest remainder, with ties going
 * to the lowest user_id (a stable order the server also uses), so a screen
 * that previews a split shows the same pennies the server stores.
 */
export function shareLineMinor(lineTotalMinor: number, userIds: string[]): Map<string, number> {
  const sorted = [...new Set(userIds)].sort()
  const result = new Map<string, number>()
  if (sorted.length === 0) return result
  const shares = largestRemainderDistribute(lineTotalMinor, sorted.map(() => 1))
  sorted.forEach((id, i) => result.set(id, shares[i]))
  return result
}

/**
 * Amounts (minor units) for several claims on one line, given the quantities
 * claimed. When the quantities use the whole line the amounts add up to the
 * line total exactly; when only part is claimed they add up to that part of the
 * line (rounded once), never more than the line.
 */
export function splitLineByQuantities(lineTotalMinor: number, lineQuantity: number, quantities: number[]): number[] {
  if (quantities.length === 0) return []
  const claimed = quantities.reduce((a, b) => a + b, 0)
  if (lineQuantity <= 0 || claimed <= 0) return quantities.map(() => 0)
  const fraction = Math.min(1, claimed / lineQuantity)
  const partMinor = fraction > 1 - QUANTITY_EPSILON / Math.max(1, lineQuantity) ? lineTotalMinor : roundHalfAwayFromZero(lineTotalMinor * fraction)
  return largestRemainderDistribute(partMinor, quantities)
}

/**
 * What a person owes for claiming `quantity` of a line, given the OTHER
 * people's existing claims on it. If this claim takes the last of the line, it
 * takes exactly what the others left, so a fully claimed line always adds up to
 * its total (per-claim rounding used to leave a line a penny short).
 */
export function claimAmountMinor(
  lineItem: ExpenseLineItem,
  quantity: number,
  otherClaims: Array<Pick<ExpenseItemClaim, 'quantity_claimed' | 'amount_owed'>>,
  currency: string
): number {
  if (quantity <= 0 || lineItem.quantity <= 0) return 0
  const totalMinor = toMinorUnits(lineItem.total_amount, currency)
  const othersQty = otherClaims.reduce((s, c) => s + c.quantity_claimed, 0)
  const othersMinor = otherClaims.reduce((s, c) => s + toMinorUnits(c.amount_owed, currency), 0)
  const remainingQty = lineItem.quantity - othersQty - quantity
  if (remainingQty < QUANTITY_EPSILON) return Math.max(0, totalMinor - othersMinor)
  return roundHalfAwayFromZero((totalMinor / lineItem.quantity) * quantity)
}

export function claimAmount(
  lineItem: ExpenseLineItem,
  quantity: number,
  otherClaims: Array<Pick<ExpenseItemClaim, 'quantity_claimed' | 'amount_owed'>>,
  currency: string
): number {
  return fromMinorUnits(claimAmountMinor(lineItem, quantity, otherClaims, currency), currency)
}

/**
 * Value (minor units) of a receipt that nobody is paying for yet: per line, line
 * total minus claimed `amount_owed`, summed over lines that have real unclaimed
 * quantity. Legacy rounding dust on fully claimed lines is not counted (see
 * isLineReallyUnclaimed). Several rows per (line, person) are all summed.
 */
export function unclaimedMinor(
  lineItems: ExpenseLineItem[],
  claims: Array<Pick<ExpenseItemClaim, 'line_item_id' | 'amount_owed'> & Partial<Pick<ExpenseItemClaim, 'quantity_claimed'>>>,
  currency: string
): number {
  const owed = new Map<string, number>()
  const qty = new Map<string, number>()
  const rows = new Map<string, number>()
  for (const c of claims) {
    owed.set(c.line_item_id, (owed.get(c.line_item_id) ?? 0) + toMinorUnits(c.amount_owed, currency))
    qty.set(c.line_item_id, (qty.get(c.line_item_id) ?? 0) + (c.quantity_claimed ?? 0))
    rows.set(c.line_item_id, (rows.get(c.line_item_id) ?? 0) + 1)
  }
  let total = 0
  for (const li of lineItems) {
    const lineMinor = toMinorUnits(li.total_amount, currency)
    const left = Math.max(0, lineMinor - (owed.get(li.id) ?? 0))
    // Callers that pass no quantities: treat the line as having quantity left when anything is short.
    const claimedQty = claims.some((c) => c.line_item_id === li.id && c.quantity_claimed === undefined) ? 0 : qty.get(li.id) ?? 0
    if (isLineReallyUnclaimed(li.quantity, claimedQty, left, rows.get(li.id) ?? 0, lineMinor)) total += left
  }
  return total
}

/**
 * True when a multi-unit line ("3 beers") holds whole-unit claims someone
 * entered themselves for part of it (for example 2 of 3). "Who had what" and
 * the share picker replace a line wholesale with an equal split, so they warn
 * before replacing these.
 */
export function hasDirectUnitClaims(line: Pick<ExpenseLineItem, 'quantity'>, rows: Array<Pick<ClaimRow, 'quantity_claimed' | 'source' | 'leftover_quantity'>>): boolean {
  if (line.quantity <= 1 + QUANTITY_EPSILON) return false
  return rows.some((c) => isStepperClaim(c) && claimOwnQuantity(c) < line.quantity - 0.005)
}

export const REPLACES_OWN_ENTRIES_WARNING = 'This replaces what people entered themselves for this item.'

/** Equal split of an integer into n parts by largest remainder: the first (total mod n) parts get one extra unit (mirrors _receipt_even_split). */
export function evenSplit(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const rem = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

/**
 * True when the OWN parts of the rows on a line are EXACTLY what an equal split between their people would be: one row per person, the
 * line's quantity in hundredths and its total in minor units both split by largest remainder in user_id order. A direct "2 of 3 beers"
 * or a legacy 0.33 share is not. Mirrors the server's check in set_receipt_claims: a person who is not the payer or an organizer may
 * only toggle themselves on a line where everyone else's rows are an equal split (re-splitting would otherwise rewrite their amounts).
 */
export function lineIsEqualSplit(
  line: Pick<ExpenseLineItem, 'quantity' | 'total_amount'>,
  rows: Array<Pick<ClaimRow, 'user_id' | 'quantity_claimed' | 'amount_owed' | 'source' | 'leftover_quantity' | 'leftover_amount'>>,
  currency: string
): boolean {
  const own = rows.filter((r) => hasOwnClaim(r)).sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))
  const people = new Set(own.map((r) => r.user_id))
  if (own.length === 0) return true
  if (people.size !== own.length) return false
  const wantQ = evenSplit(Math.round(line.quantity * 100), own.length)
  const wantA = evenSplit(toMinorUnits(line.total_amount, currency), own.length)
  return own.every((r, i) => Math.round(claimOwnQuantity(r) * 100) === wantQ[i] && toMinorUnits(claimOwnAmount(r), currency) === wantA[i])
}

/**
 * The server's rule for a person who is on the receipt but is neither the payer nor a trip manager: they may only TOGGLE THEMSELVES.
 *   add myself:      the new people = the people already on the line + me;
 *   take myself off: the new people = the people already on the line - me (empty when I was the only one).
 * Never anyone else, never an item shared by everyone at the table, and never a line where somebody else holds rows that are not an
 * equal split (`othersSplitUnequal`, see lineIsEqualSplit). Returns the reason a pick would be refused, or null.
 * `existing` = people already on the line with a claim of their own (a leftover share alone does not count). The payer and managers (`fullPower`) may pick anyone.
 */
export function sharePickProblem(args: {
  fullPower: boolean
  me: string
  pick: string[]
  existing: string[]
  lineSharedByAll: boolean
  othersSplitUnequal?: boolean
}): string | null {
  const { fullPower, me, pick, existing, lineSharedByAll, othersSplitUnequal } = args
  if (fullPower) return pick.length === 0 ? 'Pick at least one person.' : null
  if (lineSharedByAll) return 'This item is shared by everyone at the table. The payer or an organizer can change it.'
  const onLine = new Set(existing)
  const others = existing.filter((id) => id !== me)
  const picked = new Set(pick)
  const sameSet = (a: Set<string>, b: string[]) => a.size === new Set(b).size && b.every((x) => a.has(x))
  const adding = sameSet(picked, [...existing, me])
  const removing = onLine.has(me) && !picked.has(me) && sameSet(picked, others)
  if (!adding && !removing) return 'You can add yourself to this item or take yourself off it. The payer or an organizer can change who else is on it.'
  if (others.length > 0 && othersSplitUnequal) return 'Someone claimed part of this item on their own. The payer or an organizer can change it.'
  return null
}

/** The new list of people when an ordinary person toggles themselves on (`on`) or off a line. */
export function selfTogglePick(existing: string[], me: string, on: boolean): string[] {
  const rest = existing.filter((id) => id !== me)
  return on ? [...rest, me] : rest
}

/** People whose chip cannot be switched for a non-manager: everyone but yourself (the payer and managers can switch anyone). */
export function lockedSharePeople(args: { fullPower: boolean; me: string; people: string[] }): Set<string> {
  if (args.fullPower) return new Set()
  return new Set(args.people.filter((id) => id !== args.me))
}
