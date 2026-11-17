import { assert, assertEquals } from 'jsr:@std/assert@1'
import { assertRefused, assertStored, call } from './helpers.ts'
import { ANA, BRING_FREE, makeCtx, ME, OPT_A, OUT, SAM, SEC_DONE, SEC_OPEN, SEC_OTHER_TRIP, STRANGER, TODO_ANYONE, TODO_EVERYONE, TODO_MINE, TODO_OTHER_TRIP, TODO_SAMS, TRIP, TURN } from './testing.ts'

const todo = (o: Record<string, unknown> = {}) => ({
  title: 'Book the ferry', notes: null, who: 'me', person_id: null, due: 'none', due_date: null, question_id: null, ...o,
})

Deno.test('add_todo: for me is a tap, row has params/preview/basis', async () => {
  const h = makeCtx()
  const r = await call('propose_add_todo', todo({ due: 'date', due_date: '2026-11-21' }), h)
  const row = assertStored(r, h)
  assertEquals(row.kind, 'add_todo')
  assertEquals(row.requires, 'tap')
  assertEquals(row.status, 'proposed')
  assertEquals(row.trip_id, TRIP)
  assertEquals(row.user_id, ME)
  assertEquals(row.turn_id, TURN)
  assertEquals(row.params, { title: 'Book the ferry', notes: null, mode: 'person', person_id: ME, before_trip: false, due_date: '2026-11-21', section_id: null })
  assertEquals(row.preview.who_label, 'You')
  assertEquals(row.preview.due_label, 'Sat 21 Nov')
  assert(String(row.preview.reminder_words).includes("You'll get an email"), row.preview.reminder_words)
  assert(String(row.preview.reminder_words).includes('the day before (Fri 20 Nov)'))
  assertEquals(row.basis.trip_frozen, false)
  assertEquals(h.emitted[0].requires, 'tap')
  assertEquals(h.emitted[0].kind, 'add_todo')
  // The model gets no user text back.
  assertEquals(JSON.stringify(r.content).includes('Book the ferry'), false)
})

Deno.test('add_todo: for another person / everyone / anyone is a review', async () => {
  for (const [who, person] of [['person', SAM], ['everyone', null], ['anyone', null]] as const) {
    const h = makeCtx()
    const row = assertStored(await call('propose_add_todo', todo({ who, person_id: person }), h), h)
    assertEquals(row.requires, 'review', who)
  }
  const h = makeCtx()
  const row = assertStored(await call('propose_add_todo', todo({ who: 'person', person_id: SAM, due: 'before_trip' }), h), h)
  assertEquals(row.preview.who_label, 'Sam')
  assertEquals(row.preview.due_label, 'Before the trip (Sat 5 Dec)')
  assertEquals(row.params.before_trip, true)
  assertEquals(row.params.due_date, null)
})

Deno.test('add_todo: bad ids and bad dates are refused', async () => {
  let h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ who: 'person', person_id: STRANGER }), h), h, /not on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ question_id: SEC_OTHER_TRIP }), h), h, /not found on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ question_id: SEC_DONE }), h), h, /already decided/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ due: 'date', due_date: '2026-11-01' }), h), h, /already passed/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ due: 'date', due_date: '2026-02-30' }), h), h, /real/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ who: 'person', person_id: OUT }), h), h, /not going/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ who: 'me', person_id: SAM }), h), h, /person_id is only/)
})

Deno.test('add_todo: a question on this trip is linked', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_todo', todo({ question_id: SEC_OPEN }), h), h)
  assertEquals(row.params.section_id, SEC_OPEN)
  assertEquals(row.preview.question_title, 'Saturday dinner')
  assertEquals(row.basis.section_status, 'in_progress')
})

Deno.test('add_todo: a person who is out may not propose it; unknown fields and long titles are refused', async () => {
  let h = makeCtx({ userId: OUT })
  assertRefused(await call('propose_add_todo', todo(), h), h, /only help with money/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', { ...todo(), trip_id: TRIP }, h), h, /Invalid input/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ title: 'x'.repeat(121) }), h), h, /at most 120/)
  h = makeCtx()
  assertRefused(await call('propose_add_todo', todo({ title: '  \u0000​ ' }), h), h, /must not be empty/)
})

Deno.test('add_todo: finished trip refuses', async () => {
  const h = makeCtx({ trip: { end_date: '2026-11-10', start_date: '2026-11-03' } })
  assertRefused(await call('propose_add_todo', todo(), h), h, /finished/)
})

Deno.test('add_todo: control characters are stripped from content, text is carried verbatim otherwise', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_todo', todo({ title: 'Book\u0007 the‮   ferry', notes: 'line1\r\n\r\n\r\n\r\nline2\u0000' }), h), h)
  assertEquals(row.params.title, 'Book the ferry')
  assertEquals(row.params.notes, 'line1\n\nline2')
})

Deno.test('add_todo: content copied from someone else is labelled with its author', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_add_todo', todo({ title: 'Book ferry' }), h), h)
  assertEquals(row.preview.content_origin.title, { author_id: SAM, author_name: 'Sam', source: 'todo' })
})

Deno.test('tick_todo: my own to-do is a tap with executor fields', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_MINE }, op: 'tick' }, h), h)
  assertEquals(row.kind, 'tick_todo')
  assertEquals(row.requires, 'tap')
  assertEquals(row.params, { source: 'action', id: TODO_MINE, op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null })
  assertEquals(row.preview.title, 'Book ferry')
  assertEquals(row.preview.current_state, 'open')
})

Deno.test('tick_todo: someone else\'s to-do and other trips\' to-dos are refused (with the open_screen alternative)', async () => {
  let h = makeCtx()
  const r = await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_SAMS }, op: 'tick' }, h)
  assertRefused(r, h, /belongs to Sam.*open_screen/)
  h = makeCtx()
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_OTHER_TRIP }, op: 'tick' }, h), h, /not found on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'checklist', id: TODO_MINE }, op: 'tick' }, h), h, /not found/)
})

Deno.test('tick_todo: everyone / anyone / bring rules', async () => {
  let h = makeCtx()
  let row = assertStored(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_EVERYONE }, op: 'tick' }, h), h)
  assertEquals(row.params.is_group_action, true)
  h = makeCtx()
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_EVERYONE }, op: 'claim' }, h), h, /everyone/)
  h = makeCtx()
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_ANYONE }, op: 'tick' }, h), h, /Claim it first/)
  h = makeCtx()
  row = assertStored(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_ANYONE }, op: 'claim' }, h), h)
  assertEquals(row.params.claim, true)
  assertEquals(row.params.anyone, true)
  h = makeCtx()
  row = assertStored(await call('propose_tick_todo', { todo_ref: { source: 'checklist', id: BRING_FREE }, op: 'claim' }, h), h)
  assertEquals(row.params.source, 'checklist')
  // Already ticked / nothing to untick
  h = makeCtx()
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_MINE }, op: 'untick' }, h), h, /nothing to untick/)
  // Someone else holds the anyone to-do
  h = makeCtx({ tables: { ...makeCtx().db.tables, trip_actions: makeCtx().db.tables.trip_actions.map((a) => (a.id === TODO_ANYONE ? { ...a, assigned_to: ANA } : a)) } })
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_ANYONE }, op: 'claim' }, h), h, /belongs to Ana/)
})

Deno.test('tick_todo: out user is refused', async () => {
  const h = makeCtx({ userId: OUT })
  assertRefused(await call('propose_tick_todo', { todo_ref: { source: 'action', id: TODO_MINE }, op: 'tick' }, h), h, /only help with money/)
  assert(OPT_A)
})
