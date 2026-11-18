import { assert, assertEquals } from 'jsr:@std/assert'
import { actionsEnabledFor, tripIsUpcoming } from './flags.ts'

const NOW = new Date('2026-11-18T23:59:00Z')
const ID = 'abc-123'
const on = (flag: string | undefined, trip?: { start_date?: string | null; end_date?: string | null } | null) => actionsEnabledFor(flag, ID, trip, NOW)

Deno.test('flag: off, on, ids behave as before', () => {
  for (const f of [undefined, null, '', ' ', 'off', 'false', '0', 'bogus']) assert(!actionsEnabledFor(f as string | undefined, ID, { start_date: '2027-01-01', end_date: '2027-01-02' }, NOW), String(f))
  for (const f of ['on', 'ON', ' true ', '1', 'all']) assert(on(f, null), f)
  assert(on(`x, ${ID.toUpperCase()} `, null))
  assert(!on('other', { start_date: '2027-01-01', end_date: '2027-01-02' }))
})

Deno.test('flag: upcoming token parsing, mixed lists, whitespace and case', () => {
  const future = { start_date: '2027-01-01', end_date: '2027-01-05' }
  const old = { start_date: '2025-01-01', end_date: '2025-01-05' }
  assert(on('upcoming', future))
  assert(on(' UpComing ', future))
  assert(on('x, upcoming ,y', future))
  assert(!on('x,upcoming', old))
  assert(on(`upcoming,${ID}`, old)) // explicit id wins for an old trip
  assert(!on('upcomingg,soon', future)) // unknown tokens ignored
  assert(!on('upcoming', undefined))
})

Deno.test('upcoming: date boundaries (UTC today = 2026-11-18)', () => {
  const t = (end: string | null, start: string | null = '2026-01-01') => tripIsUpcoming({ start_date: start, end_date: end }, NOW)
  assert(t('2026-11-18')) // ends today
  assert(t('2026-12-30'))
  assert(t('2026-10-19')) // 30 days ago
  assert(!t('2026-10-18')) // 31 days ago
  assert(!t('2026-10-18T10:00:00Z'))
  assert(t(null, '2026-10-19')) // no end date: start date used
  assert(!t(null, '2026-10-18'))
  assert(t(null, null)) // still being planned
})

Deno.test('upcoming: unreadable dates fail closed', () => {
  assertEquals(tripIsUpcoming(null, NOW), false)
  assertEquals(tripIsUpcoming(undefined, NOW), false)
  assertEquals(tripIsUpcoming({}, NOW), false)
  assertEquals(tripIsUpcoming({ start_date: '2027-01-01' }, NOW), false)
  assertEquals(tripIsUpcoming({ start_date: 'soon', end_date: null }, NOW), false)
  assertEquals(tripIsUpcoming({ start_date: null, end_date: '2027-13-45' }, NOW), false)
})

Deno.test('upcoming: clock uses the UTC date', () => {
  const late = new Date('2026-11-18T23:59:59Z')
  const early = new Date('2026-11-19T00:00:00Z')
  const trip = { start_date: '2026-10-01', end_date: '2026-10-19' }
  assert(tripIsUpcoming(trip, late))
  assert(!tripIsUpcoming(trip, early))
})
