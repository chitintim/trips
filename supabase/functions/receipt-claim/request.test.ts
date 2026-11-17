import { assert, assertEquals } from 'jsr:@std/assert@1'
import { parseClaimPost, RATE } from './request.ts'

const T = 'A'.repeat(43)
const LINE = '123e4567-e89b-12d3-a456-426614174000'

Deno.test('parseClaimPost: the four plain actions and peek', () => {
  for (const action of ['peek', 'done', 'not_there', 'undo_done'] as const) assertEquals(parseClaimPost({ t: T, action }), { ok: true, token: T, action })
})

Deno.test('parseClaimPost: toggle needs a line id; on is optional and boolean', () => {
  assertEquals(parseClaimPost({ t: T, action: 'toggle', line_item_id: LINE.toUpperCase() }), { ok: true, token: T, action: 'toggle', lineItemId: LINE, on: null })
  assertEquals(parseClaimPost({ t: T, action: 'toggle', line_item_id: LINE, on: false }), { ok: true, token: T, action: 'toggle', lineItemId: LINE, on: false })
  assertEquals(parseClaimPost({ t: T, action: 'toggle' }).ok, false)
  assertEquals(parseClaimPost({ t: T, action: 'toggle', line_item_id: 'x' }).ok, false)
  assertEquals(parseClaimPost({ t: T, action: 'toggle', line_item_id: LINE, on: 'yes' }).ok, false)
})

Deno.test('parseClaimPost: junk and old payment-confirm actions are refused', () => {
  for (const body of [null, undefined, 'x', [], {}, { t: 'short', action: 'peek' }, { t: T }, { t: T, action: 'confirm' }, { t: T, action: 'not_received' }, { t: T, action: 'set_claims' }, { t: 5, action: 'peek' }]) {
    assertEquals(parseClaimPost(body).ok, false)
  }
})

Deno.test('RATE: reads are looser than a token can legitimately need, writes allow several toggles', () => {
  assert(RATE.tokenWrite.limit >= 20)
  assert(RATE.ipRead.limit >= RATE.tokenRead.limit)
})
