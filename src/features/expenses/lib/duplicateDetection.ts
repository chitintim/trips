/**
 * Duplicate-charge warning (plan §10/§16): new in v2, no v1 equivalent.
 * Non-blocking warning banner shown on create when an existing expense
 * matches same vendor + amount within +/-5% + same day (also catches
 * double card charges).
 */
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface DuplicateCandidate {
  expense: ExpenseWithDetails
  amountDeltaPercent: number
}

function normalizeVendor(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase()
}

/**
 * Finds existing expenses that look like duplicates of a candidate new
 * expense: same vendor name (case/whitespace-insensitive), same
 * payment_date, and amount within +/-5% (in the same currency -- cross
 * currency comparisons are out of scope, a duplicate charge is always
 * captured in the same currency by definition).
 */
export function findDuplicateCandidates(
  newExpense: { vendor_name?: string | null; amount: number; currency: string; payment_date: string },
  existingExpenses: ExpenseWithDetails[],
  excludeExpenseId?: string
): DuplicateCandidate[] {
  const vendor = normalizeVendor(newExpense.vendor_name)
  if (!vendor) return []

  const results: DuplicateCandidate[] = []
  for (const existing of existingExpenses) {
    if (excludeExpenseId && existing.id === excludeExpenseId) continue
    if (normalizeVendor(existing.vendor_name) !== vendor) continue
    if (existing.payment_date !== newExpense.payment_date) continue
    if (existing.currency !== newExpense.currency) continue
    if (existing.amount === 0) continue

    const deltaPercent = (Math.abs(existing.amount - newExpense.amount) / Math.abs(existing.amount)) * 100
    if (deltaPercent <= 5) {
      results.push({ expense: existing, amountDeltaPercent: deltaPercent })
    }
  }
  return results.sort((a, b) => a.amountDeltaPercent - b.amountDeltaPercent)
}
