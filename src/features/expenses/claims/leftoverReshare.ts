/**
 * What to do about shared leftovers after somebody's claims on a receipt change.
 *
 * The server replaces every claim row on a line it touches (set_receipt_claims), or every row of one person on the lines they save (the
 * direct save), and with them the leftover share inside those rows. Leftover shares are DERIVED, so after any edit on a receipt that has
 * leftovers shared they must be rebuilt, and the rebuild can also be needed for lines the edit did not touch (value that was merged into
 * another line as dust). So the rule is receipt-wide, never "did a line I touched carry a leftover part".
 *
 *   - payer / managers: re-share with mode 'same' (the server repeats the mode it stored on the expense);
 *   - an ordinary person may not (the server refuses): the leftover parts they removed return to the payer's "unclaimed" bucket, which is
 *     safe (sums only ever go down) and visible (the receipt shows as having unclaimed value); the payer is told to share again.
 */
import { claimLeftoverAmount, claimLeftoverQuantity } from '../lib/balances'
import { toMinorUnits } from '../../../lib/money'
import type { ClaimRow } from './claimMath'

/** True when leftovers have been shared on this receipt: the expense remembers a mode, or any row carries a leftover part. */
export function receiptHasLeftovers(
  expense: object | null | undefined,
  claims: ReadonlyArray<Pick<ClaimRow, 'leftover_quantity' | 'leftover_amount'>>
): boolean {
  // expenses.leftover_mode is added by the receipt-claims migration and is not in the generated types yet.
  if ((expense as { leftover_mode?: string | null } | null | undefined)?.leftover_mode != null) return true
  return claims.some((c) => claimLeftoverAmount(c) > 0 || claimLeftoverQuantity(c) > 0)
}

export type LeftoverFollowUp = 'reshare' | 'tell_payer' | 'none'

export function leftoverFollowUp(args: {
  expense: object | null | undefined
  claims: ReadonlyArray<Pick<ClaimRow, 'leftover_quantity' | 'leftover_amount'>>
  canShare: boolean
}): LeftoverFollowUp {
  if (!receiptHasLeftovers(args.expense, args.claims)) return 'none'
  return args.canShare ? 'reshare' : 'tell_payer'
}

/**
 * True when every line that has money on it is full (nothing left to claim): after the leftovers are shared out, an ordinary person cannot
 * add an own claim until the payer reassigns or re-shares, so the claim page says so instead of offering steppers the server will refuse.
 */
export function everythingSharedOut(
  lines: ReadonlyArray<{ id: string; quantity: number; total_amount: number }>,
  claims: ReadonlyArray<Pick<ClaimRow, 'line_item_id' | 'quantity_claimed'>>,
  currency: string
): boolean {
  const payable = lines.filter((l) => l.quantity > 0 && toMinorUnits(l.total_amount, currency) > 0)
  if (payable.length === 0) return false
  const qty = new Map<string, number>()
  for (const c of claims) qty.set(c.line_item_id, (qty.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  return payable.every((l) => Math.round((l.quantity - (qty.get(l.id) ?? 0)) * 1e6) / 1e6 <= 0.011)
}
