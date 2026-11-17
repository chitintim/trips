import { assert, assertEquals } from 'jsr:@std/assert@1'
import { messageStatesDate } from './statedDate.ts'
import { assertRefused, assertStored, call } from './helpers.ts'
import { ANA, baseTables, BEN, EXPENSE_1, makeCtx, ME, OUT, SAM, STRANGER } from './testing.ts'

const exp = (o: Record<string, unknown> = {}) => ({
  description: 'Taxis', amount: '40.00', currency: 'GBP', paid_by: null, split_between: [ME, SAM, ANA, BEN], custom_split: null, date: null, category: 'transport', ...o,
})

Deno.test('add_expense: even split of 40.00 between four, exact, review tier', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_expense', exp(), h), h)
  assertEquals(row.kind, 'add_expense')
  assertEquals(row.requires, 'review')
  assertEquals(row.params.amount_minor, 4000)
  assertEquals(row.params.currency, 'GBP')
  assertEquals(row.params.paid_by, ME)
  assertEquals(row.params.payment_date, '2026-11-17')
  assertEquals(row.params.split_mode, 'equal')
  assertEquals(row.params.splits.map((s: any) => s.amount_minor), [1000, 1000, 1000, 1000])
  assertEquals(row.params.needs_fx, false)
  assertEquals(row.preview.amount_text, '£40.00')
  assertEquals(row.preview.shares.map((s: any) => `${s.name} ${s.amount_text}`), ['Tim £10.00', 'Sam £10.00', 'Ana £10.00', 'Ben £10.00'])
  assertEquals(row.preview.fx_note, null)
})

Deno.test('add_expense: 3-way split of 10.00 is 3.34 / 3.33 / 3.33 and exact (the first in roster order gets the penny)', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_expense', exp({ amount: '10.00', split_between: [BEN, ANA, ME] }), h), h)
  // roster order is Tim, Sam, Ana, Ben -> Tim, Ana, Ben regardless of the order the model listed them
  assertEquals(row.params.participant_ids, [ME, ANA, BEN])
  assertEquals(row.params.splits.map((s: any) => s.amount_minor), [334, 333, 333])
  assertEquals(row.preview.shares.map((s: any) => s.amount_text), ['£3.34', '£3.33', '£3.33'])
  assertEquals(row.params.splits.reduce((a: number, s: any) => a + s.amount_minor, 0), 1000)
})

Deno.test('add_expense: everyone_in_scope uses inScopePeople (declined excluded)', async () => {
  const t = baseTables()
  const h = makeCtx({ tables: t, trip: { confirmation_enabled: true } })
  h.db.tables.trips[0].confirmation_enabled = true
  // roster: Olly declined; with tracking on, declined people are dropped
  const row = assertStored(await call('propose_add_expense', exp({ split_between: 'everyone_in_scope', amount: '9.00' }), h), h)
  assertEquals(row.params.participant_ids, [ME, SAM, ANA, BEN])
  assertEquals(row.params.splits.map((s: any) => s.amount_minor), [225, 225, 225, 225])
})

Deno.test('add_expense: custom split must add up exactly; a penny off is rejected', async () => {
  let h = makeCtx()
  const ok = assertStored(await call('propose_add_expense', exp({ amount: '10.00', split_between: [ME, SAM], custom_split: [{ person_id: ME, amount: '6.00' }, { person_id: SAM, amount: '4.00' }] }), h), h)
  assertEquals(ok.params.split_mode, 'custom')
  assertEquals(ok.params.splits.map((s: any) => s.amount_minor), [600, 400])
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ amount: '10.00', split_between: [ME, SAM], custom_split: [{ person_id: ME, amount: '6.00' }, { person_id: SAM, amount: '3.99' }] }), h), h, /short by £0\.01/)
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ amount: '10.00', split_between: [ME, SAM], custom_split: [{ person_id: ME, amount: '6.00' }, { person_id: SAM, amount: '4.01' }] }), h), h, /over by £0\.01/)
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ amount: '10.00', split_between: [ME, SAM], custom_split: [{ person_id: ME, amount: '10.00' }] }), h), h, /exactly the people/)
})

Deno.test('add_expense: frozen trip refuses with the plain reason', async () => {
  const t = baseTables()
  t.trips[0].settlement_snapshot = { frozen_at: 'x' }
  const h = makeCtx({ tables: t })
  assertRefused(await call('propose_add_expense', exp(), h), h, /Balances are frozen.*ask an organiser to unfreeze/i)
})

Deno.test('add_expense: other trip people, removed people, bad currency, bad amounts', async () => {
  let h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ split_between: [ME, STRANGER] }), h), h, /not on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ paid_by: STRANGER }), h), h, /not on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ currency: 'XXX' }), h), h, /not a currency the app knows/)
  for (const amount of ['0', '0.00', '-5', '£40', '40.123', '1,000', '']) {
    h = makeCtx()
    assertRefused(await call('propose_add_expense', exp({ amount }), h), h, /amount/)
  }
  h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ date: '2026-12-31' }), h), h, /future/)
  h = makeCtx({ rosterOverride: makeCtx().ctx.roster.map((p) => (p.userId === SAM ? { ...p, active: false } : p)) })
  assertRefused(await call('propose_add_expense', exp(), h), h, /removed from the trip/)
})

Deno.test('add_expense: "Sam paid" is allowed and reviewed; foreign currency leaves FX to the client', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_expense', exp({ paid_by: SAM, currency: 'eur', amount: '60' }), h), h)
  assertEquals(row.requires, 'review')
  assertEquals(row.params.paid_by, SAM)
  assertEquals(row.preview.paid_by_is_me, false)
  assertEquals(row.params.currency, 'EUR')
  assertEquals(row.params.needs_fx, true)
  assert(String(row.preview.fx_note).includes('GBP'))
  assertEquals(row.preview.amount_text, '€60.00')
})

Deno.test('add_expense: an out user may still propose money; zero-decimal currency works', async () => {
  const h = makeCtx({ userId: OUT })
  const row = assertStored(await call('propose_add_expense', exp({ currency: 'JPY', amount: '5000', paid_by: null, split_between: [OUT, ME] }), h), h)
  assertEquals(row.params.paid_by, OUT)
  assertEquals(row.params.exponent, 0)
  assertEquals(row.params.splits.map((s: any) => s.amount_minor), [2500, 2500])
})

Deno.test('add_expense: a similar existing expense is flagged, not blocked', async () => {
  const t = baseTables()
  t.expenses = [{ id: EXPENSE_1, trip_id: makeCtx().ctx.tripId, description: 'Taxis', amount: 40, paid_by: ME, payment_date: '2026-11-17' }]
  const h = makeCtx({ tables: t })
  const row = assertStored(await call('propose_add_expense', exp(), h), h)
  assertEquals(row.preview.possible_duplicate, { expense_id: EXPENSE_1 })
})

// ---- dates: far-off dates need the person's own words ----------------------------------------------------------

Deno.test('statedDate: ISO, day-month names, month-day names and numeric forms count; relative words do not', () => {
  assert(messageStatesDate('paid on 2026-03-04 for taxis', '2026-03-04'))
  assert(messageStatesDate('paid on 4 March', '2026-03-04'))
  assert(messageStatesDate('paid on the 4th of march', '2026-03-04'))
  assert(messageStatesDate('March 4th it was', '2026-03-04'))
  assert(messageStatesDate('paid 4/3', '2026-03-04'))
  assert(messageStatesDate('paid 3/4/2026', '2026-03-04'))
  assert(!messageStatesDate('paid yesterday', '2026-03-04'))
  assert(!messageStatesDate('paid on 14 March', '2026-03-04'))
  assert(!messageStatesDate('paid 24/3', '2026-03-04'))
  assert(!messageStatesDate('', '2026-03-04'))
})

Deno.test('add_expense: a future date is refused unless the person wrote it; the error tells the model to ask', async () => {
  const h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ date: '2026-12-31' }), h), h, /Ask them what date/)
  const h2 = makeCtx()
  h2.ctx.userMessage = 'I paid £40 for the 31st of December pre-booking'
  assertStored(await call('propose_add_expense', exp({ date: '2026-12-31' }), h2), h2)
})

Deno.test('add_expense: more than 60 days back is refused unless stated; 60 days back and tomorrow (no tz) are fine', async () => {
  const h = makeCtx()
  assertRefused(await call('propose_add_expense', exp({ date: '2026-09-01' }), h), h, /days ago/)
  const ok = makeCtx()
  assertStored(await call('propose_add_expense', exp({ date: '2026-09-18' }), ok), ok) // exactly 60 days before 2026-11-17
  const tomorrow = makeCtx()
  assertStored(await call('propose_add_expense', exp({ date: '2026-11-18' }), tomorrow), tomorrow) // UTC today, person may be ahead
  const withTz = makeCtx()
  withTz.ctx.tzLabel = 'your local date'
  assertRefused(await call('propose_add_expense', exp({ date: '2026-11-18' }), withTz), withTz, /future/)
  const stated = makeCtx()
  stated.ctx.userMessage = 'taxis on 1 September, £40'
  assertStored(await call('propose_add_expense', exp({ date: '2026-09-01' }), stated), stated)
})

Deno.test('add_expense: preview says who paid relative to the asker and the asker\'s own share', async () => {
  const h = makeCtx()
  const mine = assertStored(await call('propose_add_expense', exp(), h), h)
  assertEquals(mine.preview.payer_is_user, true)
  assertEquals(mine.preview.my_share_minor, 1000)
  assertEquals(mine.preview.my_share_text, '£10.00')
  const h2 = makeCtx()
  const other = assertStored(await call('propose_add_expense', exp({ paid_by: SAM }), h2), h2)
  assertEquals(other.preview.payer_is_user, false)
  assertEquals(other.preview.paid_by_is_me, false)
  assertEquals(other.preview.my_share_text, '£10.00')
  const h3 = makeCtx()
  const notIn = assertStored(await call('propose_add_expense', exp({ paid_by: SAM, split_between: [SAM, ANA] }), h3), h3)
  assertEquals(notIn.preview.my_share_minor, null)
  assertEquals(notIn.preview.my_share_text, null)
})
