
// ======================================================================================================================================
// PHASE 4: M1 freeze enforcement (20261128090000) and M2 own claims + direct-write counter (20261128100000)
// ======================================================================================================================================
{
  // idempotence + names: apply both twice, nothing changes the second time
  const snap = async () => JSON.stringify([
    await qa(`select proname, pg_get_function_identity_arguments(oid) a, md5(prosrc) m, prosecdef s, proacl::text acl from pg_proc where pronamespace='public'::regnamespace order by 1,2`),
    await qa(`select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1,2`),
    await qa(`select tgrelid::regclass::text t, tgname from pg_trigger where not tgisinternal order by 1,2`),
    await qa(`select relname, relacl::text a, relrowsecurity r from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`),
  ])
  await applyFile(MIG3, 'MIG3')
  await applyFile(MIG4, 'MIG4')
  const a = await snap()
  await applyFile(MIG3, 'MIG3 (second apply)')
  await applyFile(MIG4, 'MIG4 (second apply)')
  eq('phase 4: applying both migrations a second time changes nothing (functions, policies, triggers, ACLs)', await snap(), a)
  eq('phase 4: only the documented existing function is replaced by M2', (await qa(`select proname from pg_proc where pronamespace='public'::regnamespace and proname='_receipt_resplit_table_items'`)).length, 1)
  const priv = async (f) => q1(`select has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') u, has_function_privilege('public',$1,'EXECUTE') p`, ['public.' + f])
  eq('privileges: _trip_frozen_for_write usable by clients only', await priv('_trip_frozen_for_write(uuid)'), { a: false, u: true, p: false })
  eq('privileges: set_my_receipt_claims authenticated only', await priv('set_my_receipt_claims(uuid,jsonb)'), { a: false, u: true, p: false })
  eq('privileges: the counter helper is not callable by anon', (await priv('_log_client_direct_write(text,text)')).a, false)
  {
    // a signed-in user calling the helper through /rpc logs nothing (only the statement triggers may); the log table is closed to clients
    await db.query(`delete from client_direct_writes`)
    const x = await call(3, `select _log_client_direct_write('expense_item_claims','INSERT') j`)
    ok('counter helper: callable but a silent no-op outside a trigger', !x.e && (await q1(`select count(*)::int n from client_direct_writes`)).n === 0, x.e?.message)
    eq('counter table: not readable or writable by clients', [(await call(3, `select count(*) from client_direct_writes`)).e?.code, (await call(3, `delete from client_direct_writes`)).e?.code], ['42501', '42501'])
    // the frozen lookup by expense id works for an expense the caller cannot see (RLS), so the guard can never skip
    const hid = await mkExpense({ trip: T2, payer: 2, amount: 5, desc: 'invisible', itemised: false, status: 'confirmed', lines: [] })
    await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [T2])
    const vis = await call(3, `select count(*)::int n from expenses where id=$1`, [hid.id])
    const fr = await call(3, `select _expense_frozen_for_write($1) f`, [hid.id])
    eq('guard helper: a client who cannot even see the expense still gets the true frozen answer', [vis.r.n, fr.r.f], [0, true])
    await db.query(`update trips set settlement_snapshot=null where id=$1`, [T2])
    eq('privileges: _expense_frozen_for_write usable by clients, not anon', await priv('_expense_frozen_for_write(uuid)'), { a: false, u: true, p: false })
  }
  eq('privileges: trigger functions are nobody\'s', [(await priv('guard_frozen_expense()')).u, (await priv('guard_frozen_expense_child()')).u, (await priv('guard_trip_settlement_columns()')).u, (await priv('count_client_direct_write()')).u], [false, false, false, false])
  eq('responses: the three write policies are gone, SELECT stays; no write privilege for clients', [(await qa(`select cmd from pg_policies where tablename='expense_claim_responses' order by 1`)).map(r => r.cmd), (await q1(`select has_table_privilege('authenticated','expense_claim_responses','INSERT') i, has_table_privilege('authenticated','expense_claim_responses','SELECT') s`))], [['SELECT'], { i: false, s: true }])
}

// ---- M1: the matrix, as real clients ----------------------------------------------------------------------------------------------------------------------------
const F = '10000000-0000-0000-0000-0000000000f1'
{
  await db.query(`insert into trips(id,name,created_by) values ($1,'freeze trip',$2)`, [F, U(11)])
  for (const [u, r] of [[1, 'organizer'], [2, 'participant'], [3, 'participant'], [4, 'participant']]) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [F, U(u), r])
  const E = await mkExpense({ trip: F, payer: 2, amount: 20, desc: 'frozen receipt', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 10]] })
  await SET(2, E.id, [{ line_item_id: E.lines[0], user_ids: [U(2)] }, { line_item_id: E.lines[1], user_ids: [U(3)] }])
  const P = await mkExpense({ trip: F, payer: 2, amount: 12, desc: 'plain expense', itemised: false, status: 'confirmed', lines: [] })
  await db.query(`insert into expense_splits(expense_id,user_id,amount) values ($1,$2,6),($1,$3,6)`, [P.id, U(2), U(3)])
  const OTHER = await mkExpense({ trip: T, payer: 2, amount: 5, desc: 'unfrozen trip expense', itemised: false, status: 'confirmed', lines: [] })

  // not frozen: everything works as before
  ok('unfrozen: a client can add, edit and delete an expense', !(await call(2, `insert into expenses(trip_id,paid_by,amount,description) values ($1,$2,7,'new') returning id`, [F, U(2)])).e
    && !(await call(2, `update expenses set amount = 13 where id=$1`, [P.id])).e && !(await call(2, `delete from expenses where description='new' and trip_id=$1`, [F])).e)
  await call(2, `update expenses set amount = 12 where id=$1`, [P.id])

  // freeze through the REAL function
  const fz = await call(1, `select freeze_settlements($1,$2::jsonb,$3::jsonb,$4::uuid[]) j`, [F, JSON.stringify({ transactions: [{ from: U(3), to: U(2), amount: 10, currency: 'EUR' }] }), JSON.stringify([{ from: U(3), to: U(2), amount: 10, currency: 'EUR' }]), []])
  ok('freeze_settlements works (definer path)', !fz.e && (await q1(`select settlement_snapshot is not null f from trips where id=$1`, [F])).f, fz.e?.message)
  const frozen = async (label, u, sql, params = []) => eq(label, (await call(u, sql, params)).e?.hint, 'frozen')

  await frozen('frozen: expense INSERT refused', 3, `insert into expenses(trip_id,paid_by,amount,description) values ($1,$2,7,'x')`, [F, U(3)])
  await frozen('frozen: amount UPDATE refused', 2, `update expenses set amount = 99 where id=$1`, [P.id])
  await frozen('frozen: paid_by UPDATE refused', 2, `update expenses set paid_by = $2 where id=$1`, [P.id, U(3)])
  await frozen('frozen: participant_ids UPDATE refused', 2, `update expenses set participant_ids = ARRAY[$2]::uuid[] where id=$1`, [P.id, U(2)])
  await frozen('frozen: currency UPDATE refused', 2, `update expenses set currency = 'USD' where id=$1`, [P.id])
  await frozen('frozen: fx_rate UPDATE refused', 2, `update expenses set fx_rate = 0.5 where id=$1`, [P.id])
  await frozen('frozen: status UPDATE refused (the old claim page\'s status write)', 2, `update expenses set status = 'unallocated' where id=$1`, [E.id])
  await frozen('frozen: ai_parsed UPDATE refused', 2, `update expenses set ai_parsed = false where id=$1`, [E.id])
  await frozen('frozen: expense DELETE refused', 2, `delete from expenses where id=$1`, [P.id])
  await frozen('frozen: splits INSERT refused', 2, `insert into expense_splits(expense_id,user_id,amount) values ($1,$2,1)`, [P.id, U(4)])
  await frozen('frozen: splits UPDATE refused', 2, `update expense_splits set amount = 7 where expense_id=$1`, [P.id])
  await frozen('frozen: splits DELETE refused', 2, `delete from expense_splits where expense_id=$1`, [P.id])
  await frozen('frozen: line item INSERT refused', 2, `insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,9,'x',1,1,1,1)`, [E.id])
  await frozen('frozen: line item DELETE refused (it would cascade to the claims)', 2, `delete from expense_line_items where id=$1`, [E.lines[0]])
  await frozen('frozen: claim DELETE refused', 3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [E.id, U(3)])
  await frozen('frozen: claim INSERT refused (existing guard)', 4, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [E.lines[0], U(4), E.id])
  await frozen('frozen: claim UPDATE refused (existing guard)', 3, `update expense_item_claims set quantity_claimed = 0.5, amount_owed = 5 where expense_id=$1 and user_id=$2`, [E.id, U(3)])
  eq('frozen: nothing changed by all of the above', [(await q1(`select amount::float a, paid_by::text p, currency c, status::text s from expenses where id=$1`, [P.id])), (await qa(`select amount::float a from expense_splits where expense_id=$1 order by user_id`, [P.id])).length, (await claimRows(E.id)).length, (await qa(`select 1 from expense_line_items where expense_id=$1`, [E.id])).length], [{ a: 12, p: U(2), c: 'EUR', s: 'confirmed' }, 2, 2, 2])
  // the OLD claim page: delete first, then insert: the first request stops it, the person's claims survive
  const del = await call(3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [E.id, U(3)])
  eq('frozen: the old claim page save stops at its DELETE and loses nothing', [del.e?.hint, (await claimRows(E.id)).filter(r => r.u === U(3)).length], ['frozen', 1])
  // cosmetic edits stay possible
  ok('frozen: description / category / vendor / location / receipt photo / date edits are allowed', !(await call(2, `update expenses set description='renamed', category='food', vendor_name='V', location='L', receipt_url='r.jpg', receipt_date='2026-11-01', payment_date='2026-11-02' where id=$1`, [P.id])).e)
  eq('frozen: ... and they were saved', (await q1(`select description d, receipt_url r from expenses where id=$1`, [P.id])), { d: 'renamed', r: 'r.jpg' })
  // the snapshot is written only by the RPCs
  eq('trips: a client cannot write the snapshot (frozen)', (await call(1, `update trips set settlement_snapshot = '{"x":1}'::jsonb where id=$1`, [F])).e?.hint, 'use_rpc')
  eq('trips: ... nor clear it', (await call(1, `update trips set settlement_snapshot = NULL where id=$1`, [F])).e?.hint, 'use_rpc')
  eq('trips: ... nor stamp who/when', (await call(1, `update trips set settlement_snapshot_by = $2 where id=$1`, [F, U(2)])).e?.hint, 'use_rpc')
  ok('trips: other trip columns stay editable by an organiser', !(await call(1, `update trips set name = 'renamed trip' where id=$1`, [F])).e)
  eq('trips: an INSERT cannot carry a snapshot (forced NULL)', (await call(1, `insert into trips(name,created_by,settlement_snapshot,settlement_snapshot_by) values ('t',$1,'{"x":1}'::jsonb,$1) returning settlement_snapshot is null n, settlement_snapshot_by is null b`, [U(1)])).r, { n: true, b: true })
  // responses: only through the RPC
  eq('responses: a direct client INSERT is no longer possible', (await call(3, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [E.id, U(3)])).e?.code, '42501')
  eq('responses: respond_to_receipt on a frozen trip says frozen', (await call(3, `select respond_to_receipt($1,'done') j`, [E.id])).e?.hint, 'frozen')
  // what stays allowed: settlements, unfreeze, service role, definer paths, cascades
  const sug = await q1(`select id::text from settlements where trip_id=$1 and status='suggested'`, [F])
  ok('frozen: the payer marks a suggested payment paid (settlement updates are untouched)', !!sug && !(await call(3, `update settlements set status='marked_paid', payment_method='cash' where id=$1`, [sug.id])).e, 'no suggested row or refused')
  ok('frozen: the service role can write expenses (jobs)', !(await call('svc', `update expenses set amount = 12 where id=$1`, [P.id])).e)
  ok('frozen: a definer RPC that legitimately writes works (apply on a never-sent receipt is not due, share_receipt_leftovers by the payer is refused by ITS frozen rule only)', (await call(2, `select share_receipt_leftovers($1,'everyone',null,true) j`, [E.id])).e?.hint === 'frozen')
  const lockBefore = await q1(`select count(*)::int n from pg_locks where locktype='advisory' and pid=pg_backend_pid()`)
  await db.exec('BEGIN')
  await call(2, `update expenses set description='again' where id=$1`, [P.id])
  const lk = await q1(`select count(*)::int n from pg_locks where locktype='advisory' and pid=pg_backend_pid()`)
  await db.exec('COMMIT')
  eq('the row triggers take no advisory lock (they would invert the lock order)', lk.n, lockBefore.n)
  const unf = await call(1, `select unfreeze_settlements($1) j`, [F])
  ok('unfreeze_settlements works on a frozen trip', !unf.e && unf.r.j.unfrozen, unf.e?.message)
  ok('after unfreeze the app can edit money again', !(await call(2, `update expenses set amount = 13 where id=$1`, [P.id])).e && !(await call(2, `delete from expense_splits where expense_id=$1`, [P.id])).e)
  // trip deletion cascades through every guard (owner), also while frozen; participant removal is unaffected
  await db.query(`update trips set settlement_snapshot = '{"transactions":[]}'::jsonb where id=$1`, [F])
  ok('frozen: removing a participant works', !(await call(1, `delete from trip_participants where trip_id=$1 and user_id=$2`, [F, U(4)])).e)
  const dt = await call(1, `delete from trips where id=$1 returning id`, [F])
  ok('frozen: deleting the whole trip cascades to expenses, splits, lines and claims', !dt.e && (await q1(`select (select count(*) from expenses where trip_id=$1)::int e, (select count(*) from expense_item_claims where expense_id=$2)::int c, (select count(*) from expense_line_items where expense_id=$2)::int l`, [F, E.id])).e === 0, dt.e?.message)
  eq('a normal trip is unaffected throughout', (await qa(`select id from expenses where id=$1`, [OTHER.id])).length, 1)
}

// ---- M2: set_my_receipt_claims -------------------------------------------------------------------------------------------------------------------------------------
{
  // parity with the client's claimAmountMinor (reference implementation of src/features/expenses/claims/claimMath.ts)
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/features/expenses/lib/ownClaimParityCases.json'), 'utf8')).cases
  const exp = c => ({ JPY: 0, KWD: 3 }[c] ?? 2)
  const toMinor = (v, c) => Math.round(v * 10 ** exp(c)), roundHalfAway = x => (x < 0 ? -Math.round(-x) : Math.round(x))
  const refMinor = (cs) => {
    const total = toMinor(cs.line.total, cs.currency), othersQ = cs.others.reduce((s, o) => s + o[0], 0), othersM = cs.others.reduce((s, o) => s + toMinor(o[1], cs.currency), 0)
    if (cs.quantity <= 0 || cs.line.quantity <= 0) return 0
    if (cs.line.quantity - othersQ - cs.quantity < 0.001) return Math.max(0, total - othersM)
    return roundHalfAway((total / cs.line.quantity) * cs.quantity)
  }
  let n = 0
  for (const cs of cases) {
    eq('parity (reference client maths): ' + cs.name, refMinor(cs), cs.expectMinor)
    const E = await mkExpense({ payer: 2, amount: Math.max(cs.line.total, 1), currency: cs.currency, desc: 'parity ' + (n++), tagged: [2, 3, 4, 21], lines: [['x', cs.line.quantity, cs.line.total]] })
    for (const [i, o] of cs.others.entries()) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [E.lines[0], U([3, 21][i % 2] + (i >= 2 ? 100 : 0)), E.id, o[0], o[1]])
    const r = await call(4, `select set_my_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[0], quantity: cs.quantity }])])
    ok('server: ' + cs.name, !r.e, r.e?.message)
    const mine = (await claimRows(E.id)).find(x => x.u === U(4))
    eq('server parity: ' + cs.name, mine ? Math.round(mine.a * 10 ** exp(cs.currency)) : null, cs.expectMinor)
  }
}
{
  // sums, leftovers, own edits
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'own claims', tagged: [2, 3, 4], lines: [['beer', 3, 10], ['pizza', 1, 20]] })
  for (const u of [2, 3, 4]) { const r = await call(u, `select set_my_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[0], quantity: 1 }])]); ok('each person claims one beer', !r.e, r.e?.message) }
  const beers = (await claimRows(E.id)).filter(r => r.l === E.lines[0])
  eq('three claims on the beers add up to the line total exactly (3.33 / 3.33 / 3.34)', [cents(beers.reduce((s, r) => s + r.a, 0)), beers.map(r => r.a).sort()], [1000, [3.33, 3.33, 3.34]])
  eq('the caller\'s rows are source self, created by them', beers.map(r => [r.s, r.u === r.cb]), [['self', true], ['self', true], ['self', true]])
  const before = JSON.stringify((await claimRows(E.id)).filter(r => r.u !== U(4)).map(r => [r.l, r.u, r.q, r.a]))
  await call(4, `select set_my_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[1], quantity: 1 }])])
  eq('one person\'s save never touches anybody else\'s rows', JSON.stringify((await claimRows(E.id)).filter(r => r.u !== U(4)).map(r => [r.l, r.u, r.q, r.a])), before)
  eq('...and takes the whole pizza line (20.00)', (await claimRows(E.id)).filter(r => r.l === E.lines[1]).map(r => r.a), [20])
  const off = await call(4, `select set_my_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[1], quantity: 0 }])])
  eq('quantity 0 takes the person off the line', [off.e?.message, (await claimRows(E.id)).filter(r => r.l === E.lines[1]).length, off.r?.j.unclaimed_total], [undefined, 0, 20])
  eq('the result has the set_receipt_claims shape', Object.keys(off.r.j).sort(), ['currency', 'expense_id', 'lines', 'rows_written', 'status', 'unclaimed_lines', 'unclaimed_total'])
  // refusals
  const R = (u, lines, eid = E.id) => call(u, `select set_my_receipt_claims($1,$2::jsonb) j`, [eid, JSON.stringify(lines)])
  eq('refused: more than is left (4 beers of 3)', (await R(4, [{ line_item_id: E.lines[0], quantity: 2 }])).e?.hint, 'overclaimed')
  eq('refused: negative / 3 decimals / duplicate / not a list', [(await R(4, [{ line_item_id: E.lines[0], quantity: -1 }])).e?.hint, (await R(4, [{ line_item_id: E.lines[0], quantity: 0.001 }])).e?.hint, (await R(4, [{ line_item_id: E.lines[0], quantity: 1 }, { line_item_id: E.lines[0], quantity: 1 }])).e?.hint, (await call(4, `select set_my_receipt_claims($1,'{}'::jsonb)`, [E.id])).e?.hint], ['bad_input', 'bad_input', 'bad_input', 'bad_input'])
  eq('refused: a line of another expense', (await R(4, [{ line_item_id: (await mkExpense({ amount: 5, desc: 'o', lines: [['o', 1, 5]] })).lines[0], quantity: 1 }])).e?.hint, 'bad_line')
  eq('refused: not on the receipt / no JWT / unknown expense', [(await R(9, [])).e?.hint, (await call(null, `select set_my_receipt_claims($1,'[]'::jsonb)`, [E.id])).e?.hint, (await R(4, [], '99999999-0000-0000-0000-000000000000')).e?.hint], ['forbidden', 'auth', 'not_found'])
  const NI = await mkExpense({ payer: 2, amount: 5, desc: 'plain', itemised: false, status: 'confirmed', lines: [] })
  eq('refused: not itemised', (await R(4, [], NI.id)).e?.hint, 'not_itemised')
  const TB = await mkExpense({ payer: 2, amount: 20, desc: 'table', tagged: [2, 3, 4], lines: [['bread', 1, 8], ['rest', 1, 12]] })
  await SET(2, TB.id, [{ line_item_id: TB.lines[0], shared_by_all: true }])
  eq('refused: a table item', (await R(4, [{ line_item_id: TB.lines[0], quantity: 1 }], TB.id)).e?.hint, 'table_item')
  const SH = await mkExpense({ payer: 2, amount: 20, desc: 'shared row', tagged: [2, 3, 4], lines: [['dish', 1, 20]] })
  await SET(2, SH.id, [{ line_item_id: SH.lines[0], user_ids: [U(3), U(4)] }])
  eq('refused: changing a shared share by hand (use the share picker)', (await R(4, [{ line_item_id: SH.lines[0], quantity: 1 }], SH.id)).e?.hint, 'fixed_share')
  await db.query(`update expenses set claims_closed_at = now() where id=$1`, [SH.id])
  eq('refused: closed receipt', (await R(3, [{ line_item_id: SH.lines[0], quantity: 0 }], SH.id)).e?.hint, 'claims_closed')
  // own edit keeps "done"; leftovers are kept and rebuilt
  const L = await mkExpense({ payer: 2, amount: 30, desc: 'with leftovers', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await db.query(`update expenses set claims_sent_at = now() where id=$1`, [L.id])
  await R(3, [{ line_item_id: L.lines[0], quantity: 1 }], L.id)
  await respond(L.id, 3, 'done')
  await SHARE(2, L.id, 'everyone')
  ok('(setup) leftovers exist', (await claimRows(L.id)).some(r => r.la > 0))
  const r2 = await R(3, [{ line_item_id: L.lines[0], quantity: 0 }], L.id)
  ok('a person changes their claim while leftovers are shared', !r2.e, r2.e?.message)
  eq('... leftovers were rebuilt the same way, every line exact, mode kept, their "done" kept (own edit)', [(await lineOk(L.id)).length, (await q1(`select leftover_mode m from expenses where id=$1`, [L.id])).m, (await respOf(L.id)).map(r => r[0])], [0, 'everyone', [U(3)]])
  // frozen
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [T])
  eq('refused: frozen', (await R(3, [{ line_item_id: L.lines[0], quantity: 0 }], L.id)).e?.hint, 'frozen')
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
}

// ---- M2: the direct-write counter -----------------------------------------------------------------------------------------------------------------------------------
{
  await db.query(`delete from client_direct_writes`)
  const E = await mkExpense({ payer: 2, amount: 20, desc: 'counter', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 10]] })
  const rows = async () => qa(`select tbl, op, build, user_id::text u from client_direct_writes order by ctid`)
  const hdr = v => db.query(`select set_config('request.headers', $1, false)`, [v])
  await hdr('{"x-client-info":"supabase-js-web/2.78.0","accept":"*/*"}')
  await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [E.lines[0], U(3), E.id])
  await hdr('{"x-client-info":"trips-web/abc1234"}')
  await call(3, `update expense_item_claims set quantity_claimed = 1, amount_owed = 10 where expense_id=$1 and user_id=$2`, [E.id, U(3)])
  await call(3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [E.id, U(3)])
  eq('counter: each direct client statement is one row with the build tag and the person', await rows(), [{ tbl: 'expense_item_claims', op: 'INSERT', build: 'supabase-js-web/2.78.0', u: U(3) }, { tbl: 'expense_item_claims', op: 'UPDATE', build: 'trips-web/abc1234', u: U(3) }, { tbl: 'expense_item_claims', op: 'DELETE', build: 'trips-web/abc1234', u: U(3) }])
  await db.query(`delete from client_direct_writes`)
  await call(2, `insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,7,'x',1,1,1,1)`, [E.id])
  await call(2, `insert into expense_splits(expense_id,user_id,amount) values ($1,$2,1)`, [E.id, U(2)])
  eq('counter: line items and splits are counted too', (await rows()).map(r => r.tbl), ['expense_line_items', 'expense_splits'])
  await db.query(`delete from client_direct_writes`)
  // RPC writes, the owner and the service role are never counted
  await call(3, `select set_my_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[1], quantity: 1 }])])
  await call(2, `select set_receipt_claims($1,$2::jsonb) j`, [E.id, JSON.stringify([{ line_item_id: E.lines[0], user_ids: [U(2)] }])])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [E.lines[0], U(4), E.id])
  await call('svc', `update expense_item_claims set amount_owed = amount_owed where expense_id=$1`, [E.id])
  eq('counter: RPC writes, owner and service-role writes are never counted', (await rows()).length, 0)
  // fail open
  await hdr('')
  ok('counter: no header at all: the write works, build NULL', !(await call(3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [E.id, U(3)])).e && (await rows()).every(r => r.build === null) && (await rows()).length === 1)
  await db.query(`delete from client_direct_writes`)
  await hdr('this is not json {')
  ok('counter: an unreadable header never breaks the write', !(await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [E.lines[1], U(3), E.id])).e && (await rows()).length === 1 && (await rows())[0].build === null)
  await hdr('')
  eq('counter: clients cannot read or write the log table', [(await call(3, `select count(*)::int n from client_direct_writes`)).e?.code, (await call(3, `insert into client_direct_writes(tbl,op) values ('x','y')`)).e?.code], ['42501', '42501'])
}

// ---- M2: table-item share activity (decision 3) ------------------------------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 52, desc: 'table activity', tagged: [2, 3, 4, 21], lines: [['bread', 1, 12], ['main', 1, 40]] })
  await SET(2, E.id, [{ line_item_id: E.lines[0], shared_by_all: true }])
  await db.query(`delete from activity_feed where verb='receipt_table_share_changed'`)
  const n0 = (await q1(`select count(*)::int n from notifications`)).n
  await call(21, `select respond_to_receipt($1,'not_there') j`, [E.id])
  const ev = await qa(`select actor::text a, metadata->>'user_id' u, (metadata->>'from')::float f, (metadata->>'to')::float t, metadata->>'line' l from activity_feed where verb='receipt_table_share_changed' order by 2`)
  eq('"I wasn\'t there": each person whose table share went up gets an activity entry (3.00 -> 4.00), caused by the person who said it', ev.map(e => [e.u, e.f, e.t, e.l, e.a]), [U(2), U(3), U(4)].map(u => [u, 3, 4, 'bread', U(21)]))
  eq('... and no email/notification row is written', (await q1(`select count(*)::int n from notifications`)).n, n0)
  await db.query(`delete from activity_feed where verb='receipt_table_share_changed'`)
  await call(21, `select respond_to_receipt($1,'undo') j`, [E.id])
  eq('undo: shares go DOWN again, no "went up" entry', (await qa(`select 1 from activity_feed where verb='receipt_table_share_changed'`)).length, 0)
}

// ---- PRE_APPLY groups 23 / 24 execute on the stubs --------------------------------------------------------------------------------------------------------------
{
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const g = pre.slice(pre.indexOf('-- 23. Migration 20261128090000'), pre.indexOf('-- 25. Trip chat A1'))
  try { await db.exec(g); pass++ } catch (e) { fail++; console.log('FAIL groups 23/24 do not run:', e.message) }
  const md5s = await qa(`select proname, md5(prosrc) m from pg_proc where pronamespace='public'::regnamespace and proname in ('guard_claim_overclaim','_receipt_resplit_table_items')`)
  eq('24b: the resplit md5 written in PRE_APPLY (phase-4 text) equals the pglite one; the overclaim guard equals the shipped phase-1 text',
    Object.fromEntries(md5s.map(r => [r.proname, r.m])), { _receipt_resplit_table_items: '5214a384cd672de9ccbab97ac034fbc2', guard_claim_overclaim: '57312c8bff6c4ee090181819a3889626' })
}

// ---- PRE_APPLY 23h: the exact expected list on the stubs ------------------------------------------------------------------------------------------------------------
{
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const a = pre.indexOf('-- 23h.'); const sql = pre.slice(pre.indexOf('SELECT p.oid::regprocedure', a), pre.indexOf(';\n', pre.indexOf('SELECT p.oid::regprocedure', a))).trim()
  eq('23h: the only SECURITY INVOKER writer of the guarded tables is _receipt_strip_leftovers (the exact list written in PRE_APPLY)', (await qa(sql)).map(r => Object.values(r)[0]), ['_receipt_strip_leftovers(uuid)'])
}
