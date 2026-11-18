import { assert, assertEquals } from 'jsr:@std/assert@1'
import { call, msg } from './helpers.ts'
import { OPEN_TARGETS } from './deepLinks.ts'
import { OPEN_SCREEN_RESULT_NOTE } from './openScreen.ts'
import { baseTables, forbiddenWrites, makeCtx, OPT_A, OPT_OTHER_TRIP, organiser, SEC_OPEN, SEC_OTHER_TRIP, TODO_MINE, TODO_OTHER_TRIP, TRIP, TURN, actionRows } from './testing.ts'

Deno.test('open_screen: question link is built from the verified id and emitted as a link envelope, nothing stored', async () => {
  const h = makeCtx()
  const r = await call('open_screen', { target: 'question', id: SEC_OPEN }, h)
  assertEquals(r.is_error, undefined)
  assertEquals(r.content, { ok: true, link: { label: 'Open the question', target: 'question', open_param: `question:${SEC_OPEN}` }, note: OPEN_SCREEN_RESULT_NOTE })
  assertEquals(h.emitted.length, 1)
  assertEquals(h.emitted[0].kind, 'open_screen')
  assertEquals(h.emitted[0].requires, 'link')
  assertEquals(h.emitted[0].status, 'proposed')
  assertEquals(h.emitted[0].id, `link-${TURN}-1`)
  assertEquals((h.emitted[0].preview as any).subject, 'Saturday dinner')
  assertEquals(actionRows(h.db).length, 0)
  assertEquals(forbiddenWrites(h.db).length, 0)
  assertEquals(h.db.writes.length, 0)
  // no trip text goes back to the model
  assertEquals(JSON.stringify(r.content).includes('Saturday'), false)
})

Deno.test('open_screen: works even with actions switched off and without the service role', async () => {
  const h = makeCtx({ actionsEnabled: false, admin: false })
  const r = await call('open_screen', { target: 'settle', id: null }, h)
  assertEquals((r.content as any).link.open_param, 'settle')
  assertEquals(h.emitted.length, 1)
})

Deno.test('open_screen: every bare target maps to its ?open= value', async () => {
  for (const t of ['todos', 'rsvp', 'answer-all', 'settle', 'travel-details', 'actions', 'actions-bring']) {
    const h = makeCtx()
    const r = await call('open_screen', { target: t, id: null }, h)
    assertEquals((r.content as any).link.open_param, t)
  }
  assert(OPEN_TARGETS.includes('book'))
})

Deno.test('open_screen: rejects unknown targets, ids on bare targets, missing ids and other trips\' ids', async () => {
  const bad = async (input: unknown, re: RegExp, h = makeCtx()) => {
    const r = await call('open_screen', input, h)
    assertEquals(r.is_error, true, JSON.stringify(input))
    assert(re.test(msg(r)), `${msg(r)} ~ ${re}`)
    assertEquals(h.emitted.length, 0)
  }
  await bad({ target: 'https://evil.example', id: null }, /Invalid input/)
  await bad({ target: 'delete-trip', id: null }, /Invalid input/)
  await bad({ target: 'settle', id: SEC_OPEN }, /takes no id/)
  await bad({ target: 'question', id: null }, /needs an id/)
  await bad({ target: 'question', id: SEC_OTHER_TRIP }, /not found on this trip/)
  await bad({ target: 'todo', id: TODO_OTHER_TRIP }, /not found on this trip/)
  await bad({ target: 'book', id: OPT_OTHER_TRIP }, /Only organisers/)
  await bad({ target: 'book', id: OPT_OTHER_TRIP }, /not found on this trip/, organiser())
  await bad({ target: 'payment', id: SEC_OPEN }, /not found on this trip/)
  await bad({ target: 'claim', id: SEC_OPEN }, /not found on this trip/)
  await bad({ target: 'item', id: OPT_OTHER_TRIP }, /not found on this trip/)
  await bad({ target: 'setup', id: null }, /Only organisers/)
})

Deno.test('open_screen: decide/book are organiser-only; todo, item, book resolve on this trip', async () => {
  let h = makeCtx()
  let r = await call('open_screen', { target: 'decide', id: SEC_OPEN }, h)
  assertEquals(r.is_error, true)
  h = organiser()
  r = await call('open_screen', { target: 'decide', id: SEC_OPEN }, h)
  assertEquals((r.content as any).link.open_param, `decide:${SEC_OPEN}`)
  r = await call('open_screen', { target: 'book', id: OPT_A }, h)
  assertEquals((r.content as any).link.open_param, `book:${OPT_A}`)
  r = await call('open_screen', { target: 'todo', id: TODO_MINE }, h)
  assertEquals((r.content as any).link.open_param, `todo:${TODO_MINE}`)
  r = await call('open_screen', { target: 'item', id: OPT_A }, h)
  assertEquals((r.content as any).link.open_param, `item:${OPT_A}`)
  const t = baseTables()
  t.settlements = [{ id: '80000000-0000-4000-8000-000000000001', trip_id: TRIP }]
  const h2 = makeCtx({ tables: t })
  r = await call('open_screen', { target: 'payment', id: '80000000-0000-4000-8000-000000000001' }, h2)
  assertEquals((r.content as any).link.open_param, 'payment:80000000-0000-4000-8000-000000000001')
})

Deno.test('open_screen: the same link twice is one card; link ids count up; capped at five', async () => {
  const h = makeCtx()
  await call('open_screen', { target: 'settle', id: null }, h)
  await call('open_screen', { target: 'settle', id: null }, h)
  assertEquals(h.emitted.length, 1)
  await call('open_screen', { target: 'todos', id: null }, h)
  assertEquals(h.emitted.map((e) => e.id), [`link-${TURN}-1`, `link-${TURN}-2`])
  for (const t of ['rsvp', 'answer-all', 'actions']) await call('open_screen', { target: t, id: null }, h)
  const r = await call('open_screen', { target: 'actions-bring', id: null }, h)
  assertEquals(r.is_error, true)
})

Deno.test('open_screen: the same button asked for twice in one turn shows once (same screen, or the same label and subject)', async () => {
  const h = makeCtx()
  const a = await call('open_screen', { target: 'settle', id: null }, h)
  const b = await call('open_screen', { target: 'settle', id: null }, h)
  assertEquals(a.content, b.content)
  assertEquals(h.emitted.length, 1)
  const q1 = await call('open_screen', { target: 'question', id: SEC_OPEN }, h)
  const q2 = await call('open_screen', { target: 'question', id: SEC_OPEN }, h)
  assertEquals(q1.content, q2.content)
  assertEquals(h.emitted.length, 2)
})

Deno.test('open_screen: parallel identical calls in one round also give one button', async () => {
  const h = makeCtx()
  await Promise.all([1, 2, 3].map(() => call('open_screen', { target: 'question', id: SEC_OPEN }, h)))
  assertEquals(h.emitted.length, 1)
})
