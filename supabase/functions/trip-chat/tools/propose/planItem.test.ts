import { assert, assertEquals } from 'jsr:@std/assert@1'
import { assertRefused, assertStored, call } from './helpers.ts'
import { makeCtx, organiser, OUT } from './testing.ts'

// Fixture trip: 5-12 Dec 2026, today 17 Nov 2026 (travel window 28 Nov - 19 Dec).
const item = (o: Record<string, unknown> = {}) => ({ title: 'Dinner in Tokyo', date: '2026-12-02', start_time: '19:00', end_time: null, for: 'me', notes: null, ...o })
const NAME = 'propose_add_plan_item'
const EVERYONE_REFUSED = 'Only organisers can add to the group plan. I can add it just for this person, or suggest it as an idea.'

Deno.test('add_plan_item: for me (a member) is a tap; the date is outside the trip and nobody complains', async () => {
  const h = makeCtx()
  const row = assertStored(await call(NAME, item(), h), h)
  assertEquals(row.kind, 'add_plan_item')
  assertEquals(row.requires, 'tap')
  assertEquals(row.params, { title: 'Dinner in Tokyo', date: '2026-12-02', start_time: '19:00', end_time: null, for: 'me', notes: null })
  assertEquals(row.preview.for_label, 'Just you')
  assertEquals(row.preview.when_label, 'Wed 2 Dec 19:00 · 3 days before the trip')
  assertEquals(row.preview.date_note, '3 days before the trip starts.')
  assertEquals(row.preview.date_check, false)
  assertEquals(row.basis.can_manage_trip, false)
  assertEquals(h.emitted[0].kind, 'add_plan_item')
})

Deno.test('add_plan_item: a member asking for everyone is refused with the plain message; an organiser gets a review', async () => {
  const h = makeCtx()
  assertRefused(await call(NAME, item({ for: 'everyone' }), h), h)
  assertEquals((await call(NAME, item({ for: 'everyone' }), makeCtx())).content, { ok: false, error: EVERYONE_REFUSED })
  const o = organiser()
  const row = assertStored(await call(NAME, item({ for: 'everyone', date: '2026-12-07' }), o), o)
  assertEquals(row.requires, 'review')
  assertEquals(row.preview.for_label, 'Everyone')
  assertEquals(row.preview.when_label, 'Mon 7 Dec 19:00')
  assertEquals(row.preview.date_note, null)
  assertEquals(row.basis.can_manage_trip, true)
  // An organiser can still add one for just themselves, as a tap.
  const o2 = organiser()
  assertEquals(assertStored(await call(NAME, item(), o2), o2).requires, 'tap')
})

Deno.test('add_plan_item: a past date is refused; a wrong-year date too', async () => {
  let h = makeCtx()
  assertRefused(await call(NAME, item({ date: '2026-11-16' }), h), h, /^That date \(2026-11-16\) has already passed\.$/)
  h = makeCtx()
  assertRefused(await call(NAME, item({ date: '2028-01-02' }), h), h, /^That date looks wrong\. Check the year\.$/)
  h = makeCtx()
  assertStored(await call(NAME, item({ date: '2026-11-17' }), h), h)
})

Deno.test('add_plan_item: an end before the start runs into the next day and is allowed; an end alone is not', async () => {
  let h = makeCtx()
  const row = assertStored(await call(NAME, item({ start_time: '22:00', end_time: '01:00' }), h), h)
  assertEquals(row.params.end_time, '01:00')
  assertEquals(row.preview.when_label, 'Wed 2 Dec 22:00 → 01:00 next day · 3 days before the trip')
  h = makeCtx()
  assertEquals(assertStored(await call(NAME, item({ start_time: '19:00', end_time: '21:00' }), h), h).preview.when_label, 'Wed 2 Dec 19:00–21:00 · 3 days before the trip')
  h = makeCtx()
  assertRefused(await call(NAME, item({ start_time: null, end_time: '21:00' }), h), h, /needs start_time/)
  h = makeCtx()
  assertRefused(await call(NAME, item({ start_time: '7pm' }), h), h, /HH:MM/)
  h = makeCtx()
  assertEquals(assertStored(await call(NAME, item({ start_time: null }), h), h).preview.when_label, 'Wed 2 Dec · 3 days before the trip')
})

Deno.test('add_plan_item: a date beyond the 7-day window is stored with date_check', async () => {
  const h = makeCtx()
  const row = assertStored(await call(NAME, item({ date: '2026-12-30' }), h), h)
  assertEquals(row.preview.date_check, true)
  assertEquals(row.preview.date_note, '18 days after the trip ends. Check the date is right.')
  assertEquals(row.requires, 'tap')
})

Deno.test('add_plan_item: gate off, finished trip, person who is out, long title, unknown field', async () => {
  let h = makeCtx({ actionsEnabled: false })
  const r = await call(NAME, item(), h)
  assertEquals(r.is_error, false)
  assert(/not switched on/i.test(JSON.stringify(r.content)))
  assertEquals(h.db.writes.length, 0)
  h = makeCtx({ trip: { start_date: '2026-11-03', end_date: '2026-11-10' } })
  assertRefused(await call(NAME, item(), h), h, /finished/)
  h = makeCtx({ userId: OUT })
  assertRefused(await call(NAME, item(), h), h, /only help with money/)
  h = makeCtx()
  assertRefused(await call(NAME, item({ title: 'x'.repeat(121) }), h), h, /at most 120/)
  h = makeCtx()
  assertRefused(await call(NAME, item({ notes: 'x'.repeat(501) }), h), h, /at most 500/)
  h = makeCtx()
  assertRefused(await call(NAME, { ...item(), person_id: OUT }, h), h, /Invalid input/)
})
