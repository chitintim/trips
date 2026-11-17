// ---- apply: the LIVE phase-1 migration first, then phase 2 ------------------------------------------------------------------------------
const applyFile = async (f, label) => {
  try { await db.exec(fs.readFileSync(f, 'utf8')) } catch (e) { console.log(label + ' ERROR', e.message, e.position); const q = e.query ?? ''; console.log(q.slice(Math.max(0, +e.position - 300), +e.position + 100).slice(0, 600)); process.exit(2) }
}
await applyFile(MIG1, 'MIG1')
const live = (await db.query(`select proname, md5(prosrc) m from pg_proc where pronamespace='public'::regnamespace and proname in ('_receipt_tagged','_receipt_leftover_confirmed')`)).rows
const phase1Md5 = Object.fromEntries(live.map(r => [r.proname, r.m]))
await applyFile(MIG2, 'MIG2')
console.log('phase 1 then phase 2 applied; phase-1 md5s', JSON.stringify(phase1Md5))

// ---- helpers -----------------------------------------------------------------------------------------------------------------------------
const asC = async fn => fn()   // `call(<number>, ...)` already runs as the authenticated role
const asS = async fn => fn()
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0]
const qa = async (sql, params) => (await db.query(sql, params)).rows
const respond = async (eid, u, r) => { await db.query(`update expenses set claims_sent_at = coalesce(claims_sent_at, now()) where id=$1`, [eid]); return db.query(`insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,$3) on conflict (expense_id,user_id) do update set response=excluded.response`, [eid, U(u), r]) }
const totals = async eid => Object.fromEntries((await qa(`select user_id::text u, sum(amount_owed)::float a from expense_item_claims where expense_id=$1 group by 1`, [eid])).map(r => [r.u, r.a]))
const lineOk = async eid => (await qa(`select li.line_number n, li.total_amount::float t, coalesce(sum(c.amount_owed),0)::float a from expense_line_items li left join expense_item_claims c on c.line_item_id=li.id where li.expense_id=$1 group by li.id, li.line_number, li.total_amount having li.total_amount <> coalesce(sum(c.amount_owed),0)`, [eid]))
const assign = async (E, owners) => { for (const [i, o] of Object.entries(owners)) { const r = await SET(2, E.id, [{ line_item_id: E.lines[+i], user_ids: [].concat(o).map(U) }]); if (r.e) throw r.e } }
const sha = () => crypto.createHash('sha256').update(crypto.randomBytes(24)).digest('hex')
const act = (hash, action, payload = null) => call('svc', `select receipt_claim_act($1,$2,$3::jsonb) j`, [hash, action, payload == null ? null : JSON.stringify(payload)])
const peek = hash => call('svc', `select receipt_claim_peek($1) j`, [hash])
const issue = async (eid, u, hash = sha()) => { const r = await call('svc', `select issue_receipt_claim_token($1,$2,$3) j`, [eid, U(u), hash]); return { hash, r } }
const setLive = (eid, sql, p = []) => db.query(`update expenses set ${sql} where id=$1`, [eid, ...p])

// ---- 1. structure ----------------------------------------------------------------------------------------------------------------------
{
  const cols = (await qa(`select table_name||'.'||column_name c, is_nullable n, data_type d, column_default df from information_schema.columns where table_schema='public' and ((table_name='expenses' and column_name in ('claim_deadline','claims_sent_at','claims_closed_at')) or (table_name='trips' and column_name='receipt_notices_enabled')) order by 1`))
  eq('new columns', cols.map(c => [c.c, c.n, c.d]), [['expenses.claim_deadline', 'YES', 'timestamp with time zone'], ['expenses.claims_sent_at', 'YES', 'timestamp with time zone'], ['expenses.claims_closed_at', 'YES', 'timestamp with time zone'], ['trips.receipt_notices_enabled', 'NO', 'boolean']].sort((a, b) => a[0] < b[0] ? -1 : 1))
  eq('receipt_notices_enabled default true', (await q1(`select receipt_notices_enabled r from trips where id=$1`, [T])).r, true)
  eq('RLS on the three new tables', (await qa(`select relname, relrowsecurity r from pg_class where relname in ('expense_claim_responses','receipt_claim_tokens','receipt_claim_rate_limits') order by 1`)).map(r => r.r), [true, true, true])
  eq('policies: 4 on responses, none on tokens / rate limits', (await qa(`select tablename, count(*)::int c from pg_policies where tablename in ('expense_claim_responses','receipt_claim_tokens','receipt_claim_rate_limits') group by 1 order by 1`)).map(r => [r.tablename, r.c]), [['expense_claim_responses', 4]])
  eq('new triggers', (await qa(`select tgname from pg_trigger where not tgisinternal and tgname in ('trg_guard_claim_response','trg_guard_expense_claim_state') order by 1`)).map(r => r.tgname), ['trg_guard_claim_response', 'trg_guard_expense_claim_state'])
  eq('token table: hash unique, FK cascade to expenses', (await q1(`select (select count(*)::int from pg_constraint where conrelid='receipt_claim_tokens'::regclass and contype='u') u, (select confdeltype::text from pg_constraint where conrelid='receipt_claim_tokens'::regclass and confrelid='expenses'::regclass) d`)), { u: 1, d: 'c' })
  eq('responses PK + CHECK + cascade', (await q1(`select (select count(*)::int from pg_constraint where conrelid='expense_claim_responses'::regclass and contype='p') p, (select count(*)::int from pg_constraint where conrelid='expense_claim_responses'::regclass and contype='c') c, (select confdeltype::text from pg_constraint where conrelid='expense_claim_responses'::regclass and confrelid='expenses'::regclass) d`)), { p: 1, c: 1, d: 'c' })
  // privileges
  const F = [
    ['_receipt_tagged(uuid)', false, false, true], ['_receipt_leftover_confirmed(uuid)', false, false, true], ['_receipt_token_name(uuid)', false, false, true],
    ['_receipt_default_deadline()', false, false, true], ['_receipt_can_toggle(uuid,uuid)', false, false, true], ['_receipt_claim_view(uuid,uuid)', false, false, true],
    ['_receipt_token_lookup(text)', false, false, true], ['guard_claim_response()', false, false, false], ['guard_expense_claim_state()', false, false, false],
    ['_expense_trip_member(uuid,uuid)', false, false, true], ['_receipt_response_state(uuid,uuid)', false, true, true],
    ['send_receipt_to_table(uuid,timestamptz)', false, true, null], ['extend_receipt_deadline(uuid,timestamptz)', false, true, null], ['apply_receipt_deadline(uuid,boolean)', false, true, true], ['reopen_receipt_claims(uuid,timestamptz)', false, true, null],
    ['_receipt_begin(uuid,boolean)', false, false, true], ['_receipt_reshare_mode(uuid)', false, false, true], ['_receipt_sync_token_expiry(uuid)', false, false, true], ['_receipt_resplit_table_items(uuid)', false, false, true],
    ['_receipt_after_tagged_change(uuid)', false, false, true], ['after_claim_response()', false, false, false], ['clear_done_on_claim_change()', false, false, false], ['guard_claim_closed()', false, false, false],
    ['issue_receipt_claim_token(uuid,uuid,text)', false, false, true], ['receipt_claim_peek(text)', false, false, true], ['receipt_claim_act(text,text,jsonb)', false, false, true],
    ['receipt_claim_rate_hit(text,integer,integer)', false, false, true],
  ]
  for (const [f, a, au, sv] of F) {
    const p = await q1(`select has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') u, has_function_privilege('service_role',$1,'EXECUTE') s, has_function_privilege('public',$1,'EXECUTE') pub`, ['public.' + f])
    eq('privileges ' + f, [p.a, p.u, p.pub, sv === null ? null : p.s], [a, au, false, sv])
  }
  const tp = await q1(`select has_table_privilege('anon','expense_claim_responses','SELECT') a, has_table_privilege('authenticated','receipt_claim_tokens','SELECT') t, has_table_privilege('authenticated','receipt_claim_rate_limits','INSERT') r, has_table_privilege('service_role','receipt_claim_tokens','INSERT') s, has_table_privilege('authenticated','expense_claim_responses','DELETE') d`)
  eq('table privileges: anon none on responses, tokens/rate-limits closed to clients, service role open', tp, { a: false, t: false, r: false, s: true, d: true })
  // old functions keep their privileges
  const pr = await q1(`select has_function_privilege('authenticated','set_receipt_claims(uuid,jsonb)','EXECUTE') a, has_function_privilege('anon','share_receipt_leftovers(uuid,text,uuid,boolean)','EXECUTE') b, has_function_privilege('authenticated','_receipt_tagged(uuid)','EXECUTE') c`)
  eq('phase-1 privileges untouched', pr, { a: true, b: false, c: false })
}

// ---- 2. the rule, through the PUBLIC share_receipt_leftovers(..., 'everyone') path ------------------------------------------------------
const EIGHT = [2, 3, 4, 21, 22, 23, 24, 25]           // 24 = Marj, 25 = Louis; 2 = payer
{
  // Example 1: Le Bistrot, 312.00, 8 people (F = 39.00), six confirmed; Marj claimed 22.00 (unconfirmed), Louis nothing. 48.00 unclaimed (wine 36 + dessert 12).
  const LB = await mkExpense({ payer: 2, amount: 312, desc: 'Le Bistrot', tagged: EIGHT, lines: [['a', 1, 100], ['b', 1, 50], ['c', 1, 30], ['d', 1, 30], ['e', 1, 20], ['f', 1, 12], ['marj', 1, 22], ['wine', 1, 36], ['dessert', 1, 12]] })
  await assign(LB, { 0: 2, 1: 3, 2: 4, 3: 21, 4: 22, 5: 23, 6: 24 })
  for (const u of [2, 3, 4, 21, 22, 23]) await respond(LB.id, u, 'done')
  eq('confirmed set = the six who said done', (await q1(`select _receipt_leftover_confirmed($1) c`, [LB.id])).c, [2, 3, 4, 21, 22, 23].map(U).sort())
  const pv = await SHARE(2, LB.id, 'everyone', null, true)
  eq('preview: Marj +17.00 and Louis +31.00 (total 39 / 31)', pv.r.j.people.map(p => [p.user_id, p.amount, p.total_after]), [[U(24), 17, 39], [U(25), 31, 31]])
  eq('preview wrote nothing', (await claimRows(LB.id)).filter(r => r.la > 0).length, 0)
  const r = await SHARE(2, LB.id, 'everyone')
  ok('example 1 shares', !r.e, r.e?.message)
  eq('example 1: Marj +17, Louis +31, nobody else', r.r.j.people.map(p => [p.user_id, p.amount]), [[U(24), 17], [U(25), 31]])
  eq('example 1: even share is 39.00', r.r.j.even_share, 39)
  eq('example 1: confirmed ids reported', r.r.j.confirmed_user_ids.length, 6)
  const t = await totals(LB.id)
  eq('example 1: Marj total 39.00', t[U(24)], 39)
  eq('example 1: Louis total 31.00', t[U(25)], 31)
  eq('example 1: the six who confirmed pay exactly what they claimed', [2, 3, 4, 21, 22, 23].map(u => t[U(u)]), [100, 50, 30, 30, 20, 12])
  eq('example 1: the payer absorbs 0 of the leftovers', (await claimRows(LB.id)).filter(x => x.u === U(2)).reduce((s, x) => s + x.la, 0), 0)
  eq('example 1: receipt adds up to 312.00 and every line is exact', [Object.values(t).reduce((s, x) => s + x, 0), (await lineOk(LB.id)).length], [312, 0])
  // Example 2: everyone confirmed, 9.00 of bread and water unclaimed -> 4 x 1.13 + 4 x 1.12
  const BW = await mkExpense({ payer: 2, amount: 120, desc: 'Bread', tagged: EIGHT, lines: [['m1', 1, 14], ['m2', 1, 14], ['m3', 1, 14], ['m4', 1, 14], ['m5', 1, 14], ['m6', 1, 14], ['m7', 1, 14], ['m8', 1, 13], ['bread', 1, 9]] })
  await assign(BW, { 0: 2, 1: 3, 2: 4, 3: 21, 4: 22, 5: 23, 6: 24, 7: 25 })
  for (const u of EIGHT) await respond(BW.id, u, 'done')
  const r2 = await SHARE(2, BW.id, 'everyone')
  ok('example 2 shares', !r2.e, r2.e?.message)
  eq('example 2: four people get 1.13 and four 1.12, lowest ids first', r2.r.j.people.map(p => p.amount), [1.13, 1.13, 1.13, 1.13, 1.12, 1.12, 1.12, 1.12])
  eq('example 2: everyone tagged takes a part (8 people)', r2.r.j.people.length, 8)
  eq('example 2: 9.00 in total and the receipt adds up', [Math.round(r2.r.j.people.reduce((s, p) => s + p.amount, 0) * 100), cents(Object.values(await totals(BW.id)).reduce((s, x) => s + x, 0))], [900, 12000])
  eq('example 2: lines exact', (await lineOk(BW.id)).length, 0)
  // 'same' repeats identically (the mode is remembered)
  const before = JSON.stringify(await claimRows(BW.id))
  const sm = await SHARE(2, BW.id, 'same')
  eq('same re-run identical', JSON.stringify(await claimRows(BW.id)), before)
}
{
  // nobody confirmed: U = everyone, water-filling (NOT a plain equal split of the leftovers when claims differ)
  const NC = await mkExpense({ payer: 2, amount: 30, desc: 'Nobody confirmed', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 4], ['rest', 1, 16]] })
  await assign(NC, { 0: 2, 1: 3 })
  eq('never sent to the table: nobody has had the chance to confirm, the confirmed set is everyone on the receipt (phase-1 behaviour)', (await q1(`select _receipt_leftover_confirmed($1) c`, [NC.id])).c, [2, 3, 4].map(U).sort())
  await db.query(`update expenses set claims_sent_at=now() where id=$1`, [NC.id])
  eq('sent to the table and nobody answered -> only the PAYER counts as confirmed', (await q1(`select _receipt_leftover_confirmed($1) c`, [NC.id])).c, [U(2)])
  const r = await SHARE(2, NC.id, 'everyone')
  eq('nobody confirmed: Bob +6 (to his even share 10), Carol +10, the payer already at 10 gets 0', r.r.j.people.map(p => [p.user_id, p.amount]), [[U(3), 6], [U(4), 10]])
  // everyone at their cap -> step 2 shares the rest equally across everyone tagged
  const AC = await mkExpense({ payer: 2, amount: 30, desc: 'All at cap', tagged: [2, 3, 4], lines: [['a', 1, 14], ['b', 1, 6], ['rest', 1, 10]] })
  await assign(AC, { 0: 2, 1: 3 })
  await respond(AC.id, 3, 'done'); await respond(AC.id, 4, 'done')
  const r2 = await SHARE(2, AC.id, 'everyone')
  eq('the only unconfirmed person (payer) is above the even share: nothing for them in step 1, step 2 splits 10.00 across all three', r2.r.j.people.map(p => p.amount), [3.34, 3.33, 3.33])
  eq('... sums and lines exact', [Object.values(await totals(AC.id)).reduce((s, x) => s + x, 0), (await lineOk(AC.id)).length], [30, 0])
  // all unconfirmed people below the even share but the leftovers exceed their rooms -> the excess goes to everyone
  const SP = await mkExpense({ payer: 2, amount: 40, desc: 'Spill', tagged: [2, 3, 4, 21], lines: [['a', 1, 10], ['rest', 1, 30]] })
  await assign(SP, { 0: 2 })
  await respond(SP.id, 3, 'done'); await respond(SP.id, 4, 'done'); await respond(SP.id, 21, 'done')
  const r3 = await SHARE(2, SP.id, 'everyone')
  // F = 10; U = {payer} room 0 -> 30 spills to step 2: 7.50 each
  eq('spill: 30.00 shared equally by the four', r3.r.j.people.map(p => p.amount), [7.5, 7.5, 7.5, 7.5])
}


{
  // the payer is confirmed once the receipt is sent: unclaimed items stop landing on them
  const PY = await mkExpense({ payer: 2, amount: 30, desc: 'Payer confirmed', tagged: [2, 3, 4], lines: [['a', 1, 10], ['rest', 1, 20]] })
  await assign(PY, { 0: 2 })
  await db.query(`update expenses set claims_sent_at=now() where id=$1`, [PY.id])
  const r = await SHARE(2, PY.id, 'everyone')
  eq('payer never receives leftovers on a sent receipt with non-responders: 10.00 / 10.00 to the two who have not replied', r.r.j.people.map(p => [p.user_id, p.amount]), [[U(3), 10], [U(4), 10]])
  const AL = await mkExpense({ payer: 2, amount: 30, desc: 'All confirmed', tagged: [2, 3, 4], lines: [['a', 1, 10], ['rest', 1, 20]] })
  await assign(AL, { 0: 2 })
  await respond(AL.id, 3, 'done'); await respond(AL.id, 4, 'done')
  const ra = await SHARE(2, AL.id, 'everyone')
  eq('all confirmed (payer included): equal split of the 20.00 among everyone on the receipt, payer too', ra.r.j.people.map(p => p.amount), [6.67, 6.67, 6.66])
  const PM = await mkExpense({ payer: 2, amount: 30, desc: 'Payer explicit', tagged: [2, 3, 4], lines: [['a', 1, 10], ['rest', 1, 20]] })
  await assign(PM, { 0: 3 })
  await db.query(`update expenses set claims_sent_at=now() where id=$1`, [PM.id])
  const rp = await SHARE(2, PM.id, 'payer')
  eq('explicit payer mode still charges the payer', rp.r.j.people.map(p => [p.user_id, p.amount]), [[U(2), 20]])
  const rq = await SHARE(2, PM.id, 'person', U(2))
  eq('explicit person = the payer too', rq.r.j.people.map(p => [p.user_id, p.amount]), [[U(2), 20]])
}

// ---- 3. "I wasn't there" -------------------------------------------------------------------------------------------------------------------
{
  const NT = await mkExpense({ payer: 2, amount: 30, desc: 'Not there', tagged: [2, 3, 4, 21], lines: [['rest', 1, 30]] })
  eq('tagged before', (await q1(`select _receipt_tagged($1) t`, [NT.id])).t, [2, 3, 4, 21].map(U).sort())
  await respond(NT.id, 21, 'not_there')
  eq('a not_there person is not tagged', (await q1(`select _receipt_tagged($1) t`, [NT.id])).t, [2, 3, 4].map(U).sort())
  await fails('payer cannot put a not_there person on a line (not tagged)', 2, `select set_receipt_claims($1,$2::jsonb)`, [NT.id, JSON.stringify([{ line_item_id: NT.lines[0], user_ids: [U(21)] }])], { hint: 'not_tagged' })
  const r = await SHARE(2, NT.id, 'everyone')
  eq('sent, nobody replied, nothing claimed: the two non-payers fill to the even share (10.00 each), the 10.00 left over is shared by the three; nothing for the absent one', r.r.j.people.map(p => [p.user_id, p.amount]), [[U(2), 3.34], [U(3), 13.33], [U(4), 13.33]])
  eq('even share uses n = 3', r.r.j.even_share, 10)
  // the payer can never be not_there
  const e1 = await call(null, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [NT.id, U(2)])
  eq('payer not_there rejected (hint)', e1.e?.hint, 'payer_not_there')
  // a person holding an own claim cannot be not_there: rejected, claims untouched
  const e2 = await call(null, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [NT.id, U(3)])
  ok('a person who only holds a LEFTOVER share (no own claim) may still say not_there', !e2.e, e2.e?.message)
  await db.query(`delete from expense_claim_responses where expense_id=$1 and user_id=$2`, [NT.id, U(3)])
  const NT2 = await mkExpense({ payer: 2, amount: 20, desc: 'Own claim', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 10]] })
  await assign(NT2, { 0: 3 })
  const e3 = await call(null, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [NT2.id, U(3)])
  eq('has_claims rejected, not cleared', [e3.e?.hint, (await claimRows(NT2.id)).length], ['has_claims', 1])
  // a stale not_there row for somebody who HOLDS an own claim (inserted straight into the claims table) keeps them tagged
  await respond(NT2.id, 4, 'not_there')
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [NT2.lines[1], U(4), NT2.id])
  ok('own-claim holder with a stale not_there stays tagged', (await q1(`select _receipt_tagged($1) t`, [NT2.id])).t.includes(U(4)))
  // 'done' from a not_there person flips it back; the response replaces the row
  await respond(NT.id, 21, 'done')
  ok('not_there -> done puts them back on the receipt', (await q1(`select _receipt_tagged($1) t`, [NT.id])).t.includes(U(21)))
}

// ---- 4. responses: RLS + guards as an ordinary signed-in client ------------------------------------------------------------------
{
  const RE = await mkExpense({ payer: 2, amount: 30, desc: 'RLS', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(RE, { 0: 2 })
  await asC(async () => {
    let x = await call(3, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done') returning response`, [RE.id, U(3)])
    ok('own response insert', !x.e && x.r.response === 'done', x.e?.message)
    x = await call(3, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [RE.id, U(4)])
    eq('cannot answer for somebody else (RLS)', x.e?.code, '42501')
    x = await call(9, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [RE.id, U(9)])
    eq('a non-member cannot answer', x.e?.code, '42501')
    x = await call(9, `select count(*)::int n from expense_claim_responses where expense_id=$1`, [RE.id])
    eq('a non-member sees nothing', x.r.n, 0)
    x = await call(4, `select user_id::text u, response r from expense_claim_responses where expense_id=$1`, [RE.id])
    eq('a trip member sees everybody\'s answers (Waiting on)', x.r, { u: U(3), r: 'done' })
    x = await call(3, `update expense_claim_responses set response='not_there' where expense_id=$1 and user_id=$2 returning response`, [RE.id, U(3)])
    ok('own change not_there', !x.e && x.r.response === 'not_there', x.e?.message)
    x = await call(4, `update expense_claim_responses set response='done' where expense_id=$1 and user_id=$2 returning 1 n`, [RE.id, U(3)])
    eq('cannot change somebody else\'s answer (0 rows)', x.r, undefined)
    x = await call(4, `delete from expense_claim_responses where expense_id=$1 and user_id=$2 returning 1 n`, [RE.id, U(3)])
    eq('cannot delete somebody else\'s answer (0 rows)', x.r, undefined)
    x = await call(2, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [RE.id, U(2)])
    eq('the payer cannot say not_there', x.e?.hint, 'payer_not_there')
    x = await call(2, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [RE.id, U(2)])
    ok('the payer may say done', !x.e, x.e?.message)
    x = await call(3, `delete from expense_claim_responses where expense_id=$1 and user_id=$2 returning 1 n`, [RE.id, U(3)])
    eq('own delete', x.r, { n: 1 })
    x = await call(3, `insert into expense_claim_responses(expense_id,user_id,response,responded_at) values ($1,$2,'done','2001-01-01') returning (responded_at > now() - interval '1 minute') fresh`, [RE.id, U(3)])
    eq('responded_at is the server time', x.r, { fresh: true })
    x = await call(3, `update expense_claim_responses set expense_id=$3 where expense_id=$1 and user_id=$2`, [RE.id, U(3), RE.lines[0]])
    ok('cannot move a response (FK / guard)', !!x.e)
  })
  // person with an own claim, via client
  const own = await asC(async () => call(2, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done') on conflict (expense_id,user_id) do update set response='done' returning 1 n`, [RE.id, U(2)]))
  ok('upsert as payer fine', !own.e, own.e?.message)
  await assign(RE, { 1: 4 })
  const hc = await asC(async () => call(4, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [RE.id, U(4)]))
  eq('has_claims via the client path too', hc.e?.hint, 'has_claims')
  // frozen / closed
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [T])
  let fz = await asC(async () => call(3, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [RE.id, U(3)]))
  eq('frozen: client write refused', fz.e?.hint, 'frozen')
  fz = await asC(async () => call(3, `delete from expense_claim_responses where expense_id=$1 and user_id=$2`, [RE.id, U(3)]))
  eq('frozen: client delete refused', fz.e?.hint, 'frozen')
  const ownerWrite = await call(null, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done') on conflict (expense_id,user_id) do update set response='done'`, [RE.id, U(21)])
  ok('frozen: the link functions / service path are not blocked by the client guard', !ownerWrite.e, ownerWrite.e?.message)
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
  await db.query(`update expenses set claims_closed_at=now() where id=$1`, [RE.id])
  const cl = await asC(async () => call(3, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done') on conflict (expense_id,user_id) do update set response='done'`, [RE.id, U(3)]))
  eq('closed: client write refused', cl.e?.hint, 'claims_closed')
  await db.query(`update expenses set claims_closed_at=null where id=$1`, [RE.id])
  // the claim-state columns of an expense cannot be written by a client
  await asC(async () => {
    await call(2, `update expenses set claim_deadline = now() + interval '40 days', claims_sent_at = now(), claims_closed_at = now(), description = 'renamed' where id=$1`, [RE.id])
  })
  const st = await q1(`select claim_deadline, claims_sent_at, claims_closed_at, description from expenses where id=$1`, [RE.id])
  eq('client UPDATE of the claim-state columns is ignored (other columns still change)', [st.claim_deadline, st.claims_sent_at, st.claims_closed_at, st.description], [null, null, null, 'renamed'])
  const ins = await asC(async () => call(2, `insert into expenses(trip_id,paid_by,amount,description,claim_deadline,claims_sent_at,claims_closed_at) values ($1,$2,5,'ins',now(),now(),now()) returning claim_deadline, claims_sent_at, claims_closed_at`, [T, U(2)]))
  eq('client INSERT forces the claim-state columns to NULL', ins.r, { claim_deadline: null, claims_sent_at: null, claims_closed_at: null })
}
