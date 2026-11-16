import { assertEquals } from 'jsr:@std/assert@1'
import { parseConfirmPost } from './request.ts'
import { generateToken } from '../_shared/paymentToken.ts'

Deno.test('parseConfirmPost accepts a token and one of three actions only', () => {
  const t = generateToken()
  assertEquals(parseConfirmPost({ t, action: 'peek' }), { ok: true, token: t, action: 'peek' })
  assertEquals(parseConfirmPost({ t, action: 'confirm' }), { ok: true, token: t, action: 'confirm' })
  assertEquals(parseConfirmPost({ t, action: 'not_received' }), { ok: true, token: t, action: 'not_received' })
  for (const bad of [null, [], 'x', {}, { t, action: 'delete' }, { t: 'short', action: 'confirm' }, { action: 'confirm' }, { t: 5, action: 'confirm' }]) {
    assertEquals(parseConfirmPost(bad).ok, false)
  }
})
