import { assert, assertEquals } from 'jsr:@std/assert@1'
import { assertRefused, assertStored, call } from './helpers.ts'
import { baseTables, makeCtx, ME, OUT, SAM, TRIP } from './testing.ts'

// Fixture trip: 5-12 Dec 2026, today 17 Nov 2026 (travel window 28 Nov - 19 Dec).
const leg = (o: Record<string, unknown> = {}) => ({
  direction: 'arrival', leg: 'main', title: null, date: '2026-12-03', time: '10:00', flight_ref: null, airport_code: null,
  set_off_date: null, set_off_time: null, home_date: null, home_time: null, ...o,
})
const NAME = 'propose_set_my_travel'

const ownRow = (o: Record<string, unknown> = {}) => ({
  id: '80000000-0000-4000-8000-000000000001', trip_id: TRIP, event_date: '2026-12-04', start_time: '09:30:00', title: 'Tim arrives',
  participant_ids: [ME], updated_at: '2026-11-10T09:00:00Z', metadata: { travel_details: true, direction: 'arrival', flight_ref: 'BA117' }, ...o,
})
const withRows = (rows: Record<string, unknown>[]) => ({ ...baseTables(), trip_timeline_events: rows })

Deno.test('set_my_travel: a new arrival before the trip is a tap, and says where it falls without warning', async () => {
  const h = makeCtx()
  const row = assertStored(await call(NAME, leg({ flight_ref: 'JL044', airport_code: 'hnd' }), h), h)
  assertEquals(row.kind, 'set_travel')
  assertEquals(row.requires, 'tap')
  assertEquals(row.params, {
    id: null, direction: 'arrival', leg: 'main', title: null, date: '2026-12-03', time: '10:00', flight_ref: 'JL044', airport_code: 'HND',
    set_off_date: null, set_off_time: null, home_date: null, home_time: null, replaces_event_id: null,
  })
  assertEquals(row.preview, {
    journey_label: 'Arriving', when_label: 'Thu 3 Dec 10:00 local · 2 days before the trip', other_end_label: null, ref: 'JL044', airport: 'HND',
    date_note: '2 days before the trip starts.', date_check: false, replaces_label: null,
  })
  assertEquals(row.basis.replaces_updated_at, null)
  assertEquals(h.emitted[0].kind, 'set_travel')
})

Deno.test('set_my_travel: an overnight arrival shows the set-off and a departure the get-home', async () => {
  let h = makeCtx()
  let row = assertStored(await call(NAME, leg({ set_off_date: '2026-12-02', set_off_time: '21:00' }), h), h)
  assertEquals(row.preview.other_end_label, 'Wed 2 Dec 21:00 · lands next day')
  h = makeCtx()
  row = assertStored(await call(NAME, leg({ set_off_date: '2026-12-01' }), h), h)
  assertEquals(row.preview.other_end_label, 'Tue 1 Dec · lands 2 days later')
  h = makeCtx()
  row = assertStored(await call(NAME, leg({ direction: 'departure', date: '2026-12-12', home_date: '2026-12-13', home_time: '09:00' }), h), h)
  assertEquals(row.preview.journey_label, 'Leaving')
  assertEquals(row.preview.other_end_label, 'Sun 13 Dec 09:00')
  assertEquals(row.preview.when_label, 'Sat 12 Dec 10:00 local')
  assertEquals(row.preview.date_note, null)
})

Deno.test('set_my_travel: set-off and get-home order and direction are checked with the RPC wording', async () => {
  let h = makeCtx()
  assertRefused(await call(NAME, leg({ set_off_date: '2026-12-04' }), h), h, /^Setting off must be on or up to 3 days before arriving\.$/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ set_off_date: '2026-11-28' }), h), h, /up to 3 days before arriving/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ direction: 'departure', date: '2026-12-12', home_date: '2026-12-11' }), h), h, /^Getting home must be on or up to 3 days after leaving\.$/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ direction: 'departure', date: '2026-12-12', set_off_date: '2026-12-11' }), h), h, /only for an arrival/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ home_date: '2026-12-04' }), h), h, /only for a departure/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ set_off_time: '21:00' }), h), h, /needs set_off_date/)
})

Deno.test('set_my_travel: a past date is refused, a wrong-year date too', async () => {
  let h = makeCtx()
  assertRefused(await call(NAME, leg({ date: '2026-11-10' }), h), h, /^That date \(2026-11-10\) has already passed\.$/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ date: '2024-12-03' }), h), h, /^That date looks wrong\. Check the year\.$/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ date: '2026-02-30' }), h), h, /Check the year/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ set_off_date: '2026-11-16', date: '2026-11-18' }), h), h, /already passed/)
})

Deno.test('set_my_travel: time, airport and reference are validated', async () => {
  let h = makeCtx()
  assertRefused(await call(NAME, leg({ time: '25:00' }), h), h, /HH:MM/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ airport_code: 'LH' }), h), h, /3 letters/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ flight_ref: 'ABCDEFGHIJKLM' }), h), h, /at most 12/)
  h = makeCtx()
  const row = assertStored(await call(NAME, leg({ time: null, flight_ref: '  JL 044 ', airport_code: ' ' }), h), h)
  assertEquals(row.params.time, null)
  assertEquals(row.params.flight_ref, 'JL 044')
  assertEquals(row.params.airport_code, null)
  assertEquals(row.preview.when_label, 'Thu 3 Dec · 2 days before the trip')
})

Deno.test('set_my_travel: an existing main leg is replaced and reviewed; others rows and other directions are not', async () => {
  const rows = [
    ownRow(),
    ownRow({ id: '80000000-0000-4000-8000-000000000002', participant_ids: [SAM], title: 'Sam arrives' }),
    ownRow({ id: '80000000-0000-4000-8000-000000000003', metadata: { travel_details: true, direction: 'departure' }, event_date: '2026-12-12' }),
    ownRow({ id: '80000000-0000-4000-8000-000000000004', metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } }),
    ownRow({ id: '80000000-0000-4000-8000-000000000005', metadata: {}, title: 'Dinner' }),
  ]
  const h = makeCtx({ tables: withRows(rows) })
  const row = assertStored(await call(NAME, leg(), h), h)
  assertEquals(row.requires, 'review')
  assertEquals(row.params.replaces_event_id, '80000000-0000-4000-8000-000000000001')
  assertEquals(row.params.id, '80000000-0000-4000-8000-000000000001')
  assertEquals(row.preview.replaces_label, 'Fri 4 Dec 09:30 · BA117')
  assertEquals(row.basis.replaces_updated_at, '2026-11-10T09:00:00Z')
  // The departure is untouched by an arrival; with only Sam's / non-travel rows it is a tap.
  const h2 = makeCtx({ tables: withRows([rows[1], rows[4]]) })
  assertEquals(assertStored(await call(NAME, leg(), h2), h2).requires, 'tap')
})

Deno.test('set_my_travel: a legacy row with no leg field counts as the main leg (title decides the direction)', async () => {
  const h = makeCtx({ tables: withRows([ownRow({ metadata: { travel_details: true }, title: 'Tim departs', event_date: '2026-12-12' })]) })
  const row = assertStored(await call(NAME, leg({ direction: 'departure', date: '2026-12-12' }), h), h)
  assertEquals(row.params.replaces_event_id, '80000000-0000-4000-8000-000000000001')
})

Deno.test('set_my_travel: an extra journey needs a title, a main leg takes none; extras are never a replacement', async () => {
  let h = makeCtx()
  assertRefused(await call(NAME, leg({ leg: 'extra' }), h), h, /needs a short title/)
  h = makeCtx()
  assertRefused(await call(NAME, leg({ title: 'Flight to Tokyo' }), h), h, /take no title/)
  h = makeCtx({ tables: withRows([ownRow()]) })
  const row = assertStored(await call(NAME, leg({ leg: 'extra', title: 'Flight to Tokyo', date: '2026-12-01' }), h), h)
  assertEquals(row.requires, 'tap')
  assertEquals(row.params.replaces_event_id, null)
  assertEquals(row.params.title, 'Flight to Tokyo')
  assertEquals(row.preview.journey_label, '“Flight to Tokyo”')
  assertEquals(row.preview.when_label, 'Tue 1 Dec 10:00 local · 4 days before the trip')
  h = makeCtx()
  assertRefused(await call(NAME, leg({ leg: 'extra', title: 'x'.repeat(61) }), h), h, /at most 60/)
})

Deno.test('set_my_travel: at most three extra journeys each way', async () => {
  const extra = (n: number) => ownRow({ id: `80000000-0000-4000-8000-00000000010${n}`, metadata: { travel_details: true, direction: 'arrival', leg: 'extra' } })
  let h = makeCtx({ tables: withRows([extra(1), extra(2), extra(3)]) })
  assertRefused(await call(NAME, leg({ leg: 'extra', title: 'Train to Osaka' }), h), h, /up to 3 extra journeys/)
  h = makeCtx({ tables: withRows([extra(1), extra(2), extra(3)]) })
  assertStored(await call(NAME, leg({ leg: 'extra', title: 'Train to Osaka', direction: 'departure', date: '2026-12-14' }), h), h)
})

Deno.test('set_my_travel: a date beyond the 7-day window is stored with date_check, never refused', async () => {
  const h = makeCtx()
  const row = assertStored(await call(NAME, leg({ date: '2026-12-30' }), h), h)
  assertEquals(row.preview.date_check, true)
  assertEquals(row.preview.date_note, '18 days after the trip ends. Check the date is right.')
  assertEquals(row.requires, 'tap')
  const h2 = makeCtx()
  const early = assertStored(await call(NAME, leg({ date: '2026-11-27' }), h2), h2)
  assertEquals(early.preview.date_check, true)
  const h3 = makeCtx()
  const edge = assertStored(await call(NAME, leg({ date: '2026-11-28' }), h3), h3)
  assertEquals(edge.preview.date_check, false)
})

Deno.test('set_my_travel: gate off, finished trip, out of the trip, unknown field', async () => {
  let h = makeCtx({ actionsEnabled: false })
  const r = await call(NAME, leg(), h)
  assertEquals(r.is_error, false)
  assert(/not switched on/i.test(JSON.stringify(r.content)))
  assertEquals(h.db.writes.length, 0)
  h = makeCtx({ trip: { start_date: '2026-11-03', end_date: '2026-11-10' } })
  assertRefused(await call(NAME, leg({ date: '2026-12-03' }), h), h, /finished/)
  h = makeCtx({ userId: OUT })
  assertRefused(await call(NAME, leg(), h), h, /only help with money/)
  h = makeCtx()
  assertRefused(await call(NAME, { ...leg(), person_id: SAM }, h), h, /Invalid input/)
})

Deno.test('set_my_travel: a failed read of existing travel still proposes, but as a review', async () => {
  const h = makeCtx()
  h.db.tableErrors['trip_timeline_events'] = { code: '500', message: 'boom' }
  const row = assertStored(await call(NAME, leg(), h), h)
  assertEquals(row.requires, 'review')
})
