/**
 * Unit tests for brandedFrom(): the sender display name is pinned to
 * BRAND_NAME in code, while the address may come from env secrets (it must
 * stay provider-verified). A stale pre-branding RESEND_FROM secret was
 * silently stripping the display name from every outgoing email. Run with:
 *   deno test supabase/functions/_shared/emailSender.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { brandedFrom } from './emailSender.ts'
import { BRAND_NAME } from './emailTemplate.ts'

const FALLBACK = 'trips@mail.fontem.ai'

Deno.test('brandedFrom: unset env uses fallback address with brand name', () => {
  const r = brandedFrom(undefined, FALLBACK)
  assertEquals(r.from, `${BRAND_NAME} <trips@mail.fontem.ai>`)
  assertEquals(r.address, FALLBACK)
  assertEquals(r.name, BRAND_NAME)
})

Deno.test('brandedFrom: bare-address env keeps the address, adds the brand name', () => {
  const r = brandedFrom('trips@mail.fontem.ai', FALLBACK)
  assertEquals(r.from, `${BRAND_NAME} <trips@mail.fontem.ai>`)
})

Deno.test('brandedFrom: name-wrapped env keeps only the address -- old name is replaced', () => {
  const r = brandedFrom('Trips App <custom@mail.fontem.ai>', FALLBACK)
  assertEquals(r.address, 'custom@mail.fontem.ai')
  assertEquals(r.from, `${BRAND_NAME} <custom@mail.fontem.ai>`)
})

Deno.test('brandedFrom: unparseable env falls back to the verified default address', () => {
  const r = brandedFrom('not an email at all', FALLBACK)
  assertEquals(r.from, `${BRAND_NAME} <trips@mail.fontem.ai>`)
})

Deno.test('brandedFrom: whitespace around a bare address is tolerated', () => {
  const r = brandedFrom('  trips@mail.fontem.ai  ', FALLBACK)
  assertEquals(r.address, 'trips@mail.fontem.ai')
})
