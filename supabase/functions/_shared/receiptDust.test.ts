import { assertEquals } from 'jsr:@std/assert@1'
import { receiptFullyClaimedWithinDust } from './receiptDust.ts'

const lines = [{ id: 'a', quantity: 1, total_amount: 10 }, { id: 'z', quantity: 1, total_amount: 0 }]

Deno.test('0.33 x 3 of a line is claimed; the zero-total line is ignored', () => {
  const thirds = [0, 1, 2].map(() => ({ line_item_id: 'a', quantity_claimed: 0.33 }))
  assertEquals(receiptFullyClaimedWithinDust(lines, thirds), true)
})

Deno.test('a real gap, no claims, no lines and unknown shapes are not claimed', () => {
  assertEquals(receiptFullyClaimedWithinDust(lines, [{ line_item_id: 'a', quantity_claimed: 0.9 }]), false)
  assertEquals(receiptFullyClaimedWithinDust(lines, []), false)
  assertEquals(receiptFullyClaimedWithinDust([], []), false)
  assertEquals(receiptFullyClaimedWithinDust(null, []), false)
  assertEquals(receiptFullyClaimedWithinDust(lines, [{ quantity_claimed: 1 }]), false)
})
