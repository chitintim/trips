import { assertEquals } from 'jsr:@std/assert@1'
import { assertRefused, assertStored, call } from './helpers.ts'
import { baseTables, makeCtx, ME, OPT_A, OPT_B, OPT_C, OPT_DONE, OPT_OTHER_TRIP, OPT_OWN1, OPT_R1, OPT_R2, OPT_R3, OUT, SAM, SEC_DONE, SEC_OPEN, SEC_OTHER_TRIP, SEC_OWN, SEC_RANK } from './testing.ts'

const ans = (o: Record<string, unknown>) => ({ question_id: SEC_OPEN, op: 'pick', option_ids: [], ranks: null, own_choice: null, ...o })

Deno.test('answer: pick one is a tap with the exact option title', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h)
  assertEquals(row.kind, 'answer')
  assertEquals(row.requires, 'tap')
  assertEquals(row.params.mode, 'single')
  assertEquals(row.params.option_ids, [OPT_A])
  assertEquals(row.params.answer_actions, [{ type: 'pick', optionId: OPT_A }])
  assertEquals(row.preview.question_title, 'Saturday dinner')
  assertEquals(row.preview.chosen, [{ option_id: OPT_A, title: "Nando's", rank: null, quantity: null, variant: null }])
  assertEquals(row.preview.replaces_text, null)
  assertEquals(row.basis.section_status, 'in_progress')
})

Deno.test('answer: says what it replaces', async () => {
  const t = baseTables()
  t.option_votes = [{ id: 'v1', option_id: OPT_B, user_id: ME, rank: null }]
  const h = makeCtx({ tables: t })
  const row = assertStored(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h)
  assertEquals(row.preview.replaces_text, 'Wahaca')
  assertEquals(row.basis.my_previous.votes, [{ optionId: OPT_B, rank: null }])
})

Deno.test('answer: the same answer again, closed question, locked option, other trip are refused', async () => {
  const t = baseTables()
  t.option_votes = [{ id: 'v1', option_id: OPT_A, user_id: ME, rank: null }]
  let h = makeCtx({ tables: t })
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h, /already your answer/)
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ question_id: SEC_DONE, option_ids: [OPT_DONE] }), h), h, /decided.*closed/)
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_C] }), h), h, /locked/)
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ question_id: SEC_OTHER_TRIP, option_ids: [OPT_OTHER_TRIP] }), h), h, /not found on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_OTHER_TRIP] }), h), h, /not on this question/)
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A, OPT_B] }), h), h, /one answer/)
})

Deno.test('answer: ranked keeps rank order and sums', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_answer', ans({ question_id: SEC_RANK, option_ids: [OPT_R1, OPT_R2, OPT_R3], ranks: [3, 1, 2] }), h), h)
  assertEquals(row.params.option_ids, [OPT_R2, OPT_R3, OPT_R1])
  assertEquals(row.params.ranks, [1, 2, 3])
  assertEquals(row.params.answer_actions, [{ type: 'pick', optionId: OPT_R2 }, { type: 'pick', optionId: OPT_R3 }, { type: 'pick', optionId: OPT_R1 }])
  assertEquals(row.preview.chosen.map((c: any) => [c.title, c.rank]), [['Hike', 1], ['Spa', 2], ['Kayak', 3]])
  const h2 = makeCtx()
  assertRefused(await call('propose_answer', ans({ question_id: SEC_RANK, option_ids: [OPT_R1, OPT_R2], ranks: [1, 1] }), h2), h2, /1\.\.n/)
  const h3 = makeCtx()
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A], ranks: [1] }), h3), h3, /only for ranked/)
})

Deno.test('answer: pass and clear', async () => {
  let h = makeCtx()
  let row = assertStored(await call('propose_answer', ans({ op: 'pass' }), h), h)
  assertEquals(row.params.pass_kind, 'no_preference')
  assertEquals(row.params.answer_actions, [{ type: 'pass' }])
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ op: 'clear' }), h), h, /nothing to clear/)
  const t = baseTables()
  t.option_votes = [{ id: 'v1', option_id: OPT_A, user_id: ME, rank: null }]
  h = makeCtx({ tables: t })
  row = assertStored(await call('propose_answer', ans({ op: 'clear' }), h), h)
  assertEquals(row.params.answer_actions, [{ type: 'clear' }])
  h = makeCtx()
  assertRefused(await call('propose_answer', ans({ op: 'pass', option_ids: [OPT_A] }), h), h, /takes no options/)
})

Deno.test('answer: other people\'s votes are never read into the proposal (only my rows)', async () => {
  const t = baseTables()
  t.option_votes = [{ id: 'v9', option_id: OPT_B, user_id: SAM, rank: null }]
  const h = makeCtx({ tables: t })
  const row = assertStored(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h)
  assertEquals(row.preview.replaces_text, null)
  assertEquals(JSON.stringify(row).includes(SAM), false)
})

Deno.test('answer: own choice order with variant and quantity', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_answer', ans({ question_id: SEC_OWN, own_choice: [{ option_id: OPT_OWN1, quantity: 2, variant: 'Kids' }] }), h), h)
  assertEquals(row.params.mode, 'own')
  assertEquals(row.params.own_choice, [{ option_id: OPT_OWN1, quantity: 2, variant: 'Kids' }])
  assertEquals(row.params.answer_actions, [{ type: 'save_own', items: [{ optionId: OPT_OWN1, checked: true, variant: 'Kids', quantity: 2 }] }])
  assertEquals(row.preview.chosen[0].title, 'Skis')
  const h2 = makeCtx()
  assertRefused(await call('propose_answer', ans({ question_id: SEC_OWN, own_choice: [{ option_id: OPT_OWN1, quantity: 1, variant: 'Giant' }] }), h2), h2, /not one of that item's options/)
  const h3 = makeCtx()
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A], own_choice: [{ option_id: OPT_A, quantity: 1, variant: null }] }), h3), h3, /only for Own-choice/)
  const row2 = (() => { const t = makeCtx(); return call('propose_answer', ans({ question_id: SEC_OWN, op: 'pass' }), t).then((r) => assertStored(r, t)) })()
  assertEquals((await row2).params.pass_kind, 'none_for_me')
})

Deno.test('answer: a person who is out, and missing question_passes table', async () => {
  let h = makeCtx({ userId: OUT })
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h, /only help with money/)
  h = makeCtx()
  h.db.tableErrors.question_passes = { code: '42P01', message: 'missing' }
  assertRefused(await call('propose_answer', ans({ op: 'pass' }), h), h, /not available/)
  // a plain pick still works without passes
  h = makeCtx()
  h.db.tableErrors.question_passes = { code: '42P01', message: 'missing' }
  assertStored(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h)
})

Deno.test('answer: finished trip refuses', async () => {
  const h = makeCtx({ trip: { start_date: '2026-11-01', end_date: '2026-11-08' } })
  assertRefused(await call('propose_answer', ans({ option_ids: [OPT_A] }), h), h, /finished/)
})
