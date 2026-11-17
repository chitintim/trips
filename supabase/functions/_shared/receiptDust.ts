/**
 * The dust-tolerant "every item on this receipt has an owner" test for edge functions.
 *
 * expenses.status is written by a database trigger (trigger_auto_update_expense_status) that compares claimed and line quantities EXACTLY, so a
 * legacy receipt split in thirds (0.33 x 3 of a line) can read 'pending_allocation' although every item is claimed. The claims feature uses one
 * tolerance everywhere (0.011 of a unit; src/features/expenses/lib/balances.ts LINE_QUANTITY_TOLERANCE, the SQL _receipt_refresh_status) and
 * ignores lines with no money on them. Functions that look at "unclaimed receipts" filter with this after reading the status column.
 * Same maths as linesFullyClaimedWithinDust in _shared/todos/computeTodos.ts (that file is a mirror of the front end and cannot import this one).
 */
export const CLAIM_QUANTITY_DUST = 0.011

export function receiptFullyClaimedWithinDust(
  lines: ReadonlyArray<{ id: string; quantity: number; total_amount?: number | null }> | null | undefined,
  claims: ReadonlyArray<{ line_item_id?: string | null; quantity_claimed?: number | null }>
): boolean {
  if (!lines || lines.length === 0) return false
  const claimed = new Map<string, number>()
  for (const c of claims) {
    if (c.line_item_id == null || typeof c.quantity_claimed !== 'number') return false
    claimed.set(c.line_item_id, (claimed.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  }
  return lines.every((l) => !((l.total_amount ?? 1) > 0) || Math.round((l.quantity - (claimed.get(l.id) ?? 0)) * 1e6) / 1e6 <= CLAIM_QUANTITY_DUST)
}
