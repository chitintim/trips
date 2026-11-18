import { assertEquals } from 'jsr:@std/assert@1'
import { assertRefused, assertStored, call } from './helpers.ts'
import { baseTables, makeCtx, ME, OPT_A, organiser, SEC_DONE, SEC_OPEN, SEC_OTHER_TRIP, SEC_OWN } from './testing.ts'

const sug = (o: Record<string, unknown> = {}) => ({ question_id: SEC_OPEN, title: 'Pho Cafe', note: null, link: null, ...o })

Deno.test('suggest_option: participant adds an option (review), link normalised', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_suggest_option', sug({ note: 'Near the station', link: 'www.pho.example/menu' }), h), h)
  assertEquals(row.kind, 'suggest_option')
  assertEquals(row.requires, 'review')
  assertEquals(row.params, { section_id: SEC_OPEN, idea: false, title: 'Pho Cafe', note: 'Near the station', link: 'https://www.pho.example/menu' })
  assertEquals(row.preview.question_title, 'Saturday dinner')
  assertEquals(row.basis.option_count, 3)
})

Deno.test('suggest_option: null question = an idea for the Ideas list', async () => {
  const h = makeCtx()
  const row = assertStored(await call('propose_suggest_option', sug({ question_id: null }), h), h)
  assertEquals(row.params.idea, true)
  assertEquals(row.params.section_id, null)
  assertEquals(row.preview.is_idea, true)
})

Deno.test('suggest_option: an organiser may add an idea (the RPC allows roster organisers); for a question they are pointed at propose_add_option', async () => {
  const h0 = organiser()
  const row = assertStored(await call('propose_suggest_option', sug({ question_id: null, title: 'Fado night' }), h0), h0)
  assertEquals(row.kind, 'suggest_option')
  assertEquals(row.params.idea, true)
  assertEquals(row.params.section_id, null)
  assertEquals(row.requires, 'review')
  // Not on the roster (site admin / creator only): the RPC would refuse, so the tool does too.
  const off = organiser({ me: { isOnRoster: false } })
  assertRefused(await call('propose_suggest_option', sug({ question_id: null }), off), off, /roster/)
})

Deno.test('suggest_option: organisers are pointed at propose_add_option for a question; bad targets refused', async () => {
  let h = organiser()
  assertRefused(await call('propose_suggest_option', sug(), h), h, /propose_add_option/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ question_id: SEC_DONE }), h), h, /decided/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ question_id: SEC_OWN }), h), h, /Own-choice/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ question_id: SEC_OTHER_TRIP }), h), h, /not found on this trip/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ title: "nando's" }), h), h, /same title/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ link: 'javascript:alert(1)' }), h), h, /link/)
  h = makeCtx()
  assertRefused(await call('propose_suggest_option', sug({ note: 'x'.repeat(501) }), h), h, /at most 500/)
})

Deno.test('suggest_option: the per-question cap of five', async () => {
  const t = baseTables()
  for (let i = 0; i < 5; i++) t.options.push({ id: `9000000${i}-0000-4000-8000-000000000000`, section_id: SEC_OPEN, title: `Mine ${i}`, status: 'available', locked: false, metadata: { suggested_by: ME } })
  const h = makeCtx({ tables: t })
  assertRefused(await call('propose_suggest_option', sug(), h), h, /limit/)
})

const qIn = (o: Record<string, unknown> = {}) => ({
  title: 'Saturday dinner?', shape: 'group', section_type: 'activities', voting: 'single', deadline: '2026-11-20T18:00:00Z',
  options: [
    { title: "Nando's", note: null, price: '15', currency: null, price_basis: null },
    { title: 'Wahaca', note: 'Mexican', price: null, currency: null, price_basis: null },
    { title: 'Dishoom', note: null, price: '22.50', currency: 'GBP', price_basis: 'each' },
  ], ...o,
})

Deno.test('create_question: organiser gets one review action with all options inline', async () => {
  const h = organiser()
  const row = assertStored(await call('propose_create_question', qIn({ title: 'Brunch?' }), h), h)
  assertEquals(row.kind, 'create_question')
  assertEquals(row.requires, 'review')
  assertEquals(row.params.shape, 'vote')
  assertEquals(row.params.method, 'single')
  assertEquals(row.params.answer_by, '2026-11-20T18:00:00.000Z')
  assertEquals(row.params.options.map((o: any) => [o.title, o.price, o.price_minor]), [["Nando's", '15', 1500], ['Wahaca', null, null], ['Dishoom', '22.50', 2250]])
  assertEquals(row.preview.options[2].price_text, '£22.50')
  assertEquals(row.preview.options[0].basis_text, 'per person')
  assertEquals(row.preview.deadline_label, 'Fri 20 Nov 18:00 UTC')
})

Deno.test('create_question: participants cannot (error names propose_suggest_option); validation', async () => {
  let h = makeCtx()
  assertRefused(await call('propose_create_question', qIn(), h), h, /propose_suggest_option/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ options: [qIn().options[0]] }), h), h, /Invalid input/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ deadline: '2026-11-01T10:00:00Z' }), h), h, /already passed/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ options: [qIn().options[0], { ...qIn().options[0], title: "NANDO'S" }] }), h), h, /twice/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ title: 'saturday dinner' }), h), h, /already an open question/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ options: [{ title: 'A', note: null, price: '1.234', currency: null, price_basis: null }, qIn().options[1]] }), h), h, /not a price/)
  h = organiser()
  assertRefused(await call('propose_create_question', qIn({ options: [{ title: 'A', note: null, price: '5', currency: 'EUR', price_basis: null }, { title: 'B', note: null, price: '5', currency: 'GBP', price_basis: null }] }), h), h, /same currency/)
})

Deno.test('add_option: organiser only, open question on this trip, no duplicates', async () => {
  const input = { question_id: SEC_OPEN, title: 'Pho Cafe', note: null, price: '18.00', currency: null, price_basis: 'total_split' }
  let h = organiser()
  const row = assertStored(await call('propose_add_option', input, h), h)
  assertEquals(row.kind, 'add_option')
  assertEquals(row.requires, 'review')
  assertEquals(row.params, { section_id: SEC_OPEN, shape: 'vote', title: 'Pho Cafe', note: null, price: '18.00', price_minor: 1800, currency: 'GBP', price_basis: 'total_split' })
  assertEquals(row.preview.price_text, '£18.00')
  h = makeCtx()
  assertRefused(await call('propose_add_option', input, h), h, /propose_suggest_option/)
  h = organiser()
  assertRefused(await call('propose_add_option', { ...input, question_id: SEC_OTHER_TRIP }, h), h, /not found on this trip/)
  h = organiser()
  assertRefused(await call('propose_add_option', { ...input, question_id: SEC_DONE }, h), h, /decided/)
  h = organiser()
  assertRefused(await call('propose_add_option', { ...input, title: 'Wahaca' }, h), h, /same title/)
  h = organiser()
  assertRefused(await call('propose_add_option', { ...input, question_id: OPT_A }, h), h, /not found/)
})
