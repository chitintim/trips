/**
 * Claim math: per-line available quantity, unclaimed remainder, and a
 * claimant's owed total for a line-item selection. Quantities are decimal
 * (shared dishes -- e.g. claiming 0.5 of a shared appetizer), matching the
 * legacy ClaimItemsPage's `expense_item_claims.quantity_claimed` semantics.
 */
import type { ExpenseLineItem, ExpenseItemClaim } from '../../../lib/queries/useExpenses'

export interface LineClaimSummary {
  lineItem: ExpenseLineItem
  totalClaimed: number
  available: number
  isFullyClaimed: boolean
  myClaimed: number
}

const QUANTITY_EPSILON = 0.001

export function summarizeLineClaims(
  lineItem: ExpenseLineItem,
  claimsForLine: ExpenseItemClaim[],
  currentUserId: string | undefined
): LineClaimSummary {
  const totalClaimed = claimsForLine.reduce((sum, c) => sum + c.quantity_claimed, 0)
  const myClaimed = claimsForLine.find((c) => c.user_id === currentUserId)?.quantity_claimed ?? 0
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

/** A user's owed amount for a given claimed quantity on a line, pro-rated from unit price (no tax/service proration here -- that's applied afterwards via distributeAdjustmentsAcrossClaimants). */
export function amountOwedForQuantity(lineItem: ExpenseLineItem, quantity: number): number {
  const unitCost = lineItem.quantity > 0 ? lineItem.total_amount / lineItem.quantity : 0
  return Math.round(unitCost * quantity * 100) / 100
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
