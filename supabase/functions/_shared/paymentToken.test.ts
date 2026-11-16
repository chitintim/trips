import { assert, assertEquals, assertNotEquals, assertFalse } from 'jsr:@std/assert@1'
import { generateToken, hashToken, isPlausibleToken, base64url, TOKEN_LENGTH } from './paymentToken.ts'

Deno.test('generateToken: 43 url-safe chars, unique, plausible', () => {
  const a = generateToken()
  const b = generateToken()
  assertEquals(a.length, TOKEN_LENGTH)
  assert(isPlausibleToken(a))
  assertNotEquals(a, b)
  assertFalse(/[+/=]/.test(a))
})

Deno.test('hashToken: sha256 hex, known vector, differs from the token', async () => {
  assertEquals(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const t = generateToken()
  const h = await hashToken(t)
  assertEquals(h.length, 64)
  assertNotEquals(h, t)
  assertEquals(await hashToken(t), h)
})

Deno.test('isPlausibleToken rejects junk', () => {
  for (const v of [undefined, null, 5, '', 'short', 'a'.repeat(44), 'a'.repeat(42) + '!', 'a'.repeat(42) + ' ']) assertFalse(isPlausibleToken(v))
})

Deno.test('base64url: no padding, url alphabet', () => {
  assertEquals(base64url(new Uint8Array([251, 255, 254])), '-__-')
})
