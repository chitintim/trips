
// ======================================================================================================================================
// 14. Review fixes (phase2-db-review.md): each probe is now a permanent check
// ======================================================================================================================================
const NOT_THERE = (u, eid) => call(u, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there') on conflict (expense_id,user_id) do update set response='not_there' returning response`, [eid, U(u)])
const DONE = (u, eid) => call(u, `insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done') on conflict (expense_id,user_id) do update set response='done' returning response`, [eid, U(u)])
const UNDO = (u, eid) => call(u, `delete from expense_claim_responses where expense_id=$1 and user_id=$2 returning 1 n`, [eid, U(u)])
const leftoverOf = async eid => Object.fromEntries((await qa(`select user_id::text u, sum(leftover_amount)::float la from expense_item_claims where expense_id=$1 group by 1 having sum(leftover_amount) > 0`, [eid])).map(r => [r.u, r.la]))
const respOf = async eid => (await qa(`select user_id::text u, response r from expense_claim_responses where expense_id=$1 order by 1`, [eid])).map(r => [r.u, r.r])

// ---- B1: the person the payer chose cannot say "not there"; anyone else holding leftovers is re-shared away; a vanished target falls back to 'everyone' ------------
{
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'B1 person mode', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(E, { 0: 2 })
  await SEND(2, E.id)
  await SHARE(2, E.id, 'person', U(3))
  const nt = await NOT_THERE(3, E.id)
  eq('B1: the explicitly chosen leftover person cannot say not_there (client)', nt.e?.hint, 'has_leftovers')
  const tk = await issue(E.id, 3)
  const lk = await act(tk.hash, 'not_there')
  eq('B1: ... nor through the link', [lk.r.j.result, lk.r.j.reason], ['refused', 'has_leftovers'])
  eq('B1: nothing was written', [(await respOf(E.id)).length, (await leftoverOf(E.id))[U(3)]], [0, 20])
  // the target leaves the trip entirely: apply falls back to 'everyone' instead of failing 'not_tagged' forever
  await db.query(`delete from trip_participants where trip_id=$1 and user_id=$2`, [T, U(3)])
  eq('B1: _receipt_reshare_mode falls back to everyone when the chosen person is gone', (await q1(`select _receipt_reshare_mode($1) m`, [E.id])).m, 'everyone')
  await setLive(E.id, `claim_deadline = now() - interval '1 minute'`)
  const ap = await call('svc', `select apply_receipt_deadline($1,false) j`, [E.id])
  ok('B1: the job applies (it used to fail with not_tagged every day)', !ap.e && ap.r.j.applied === true && ap.r.j.mode === 'everyone', ap.e?.message ?? ap.r.j.mode)
  eq('B1: nobody who is gone is charged; the receipt is exact', [(await leftoverOf(E.id))[U(3)] ?? 0, (await lineOk(E.id)).length], [0, 0])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true)`, [T, U(3)])
  // everyone-mode holder says not_there: allowed, re-shared away at once (the AFTER trigger), so they are never charged
  const F = await mkExpense({ payer: 2, amount: 30, desc: 'B1 everyone mode', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(F, { 0: 2 })
  await SEND(2, F.id)
  await SHARE(2, F.id, 'everyone')
  eq('B1: before: Bob and Carol hold the leftovers', await leftoverOf(F.id), { [U(3)]: 10, [U(4)]: 10 })
  const n4 = await NOT_THERE(4, F.id)
  ok('B1: Carol (everyone mode) may say not_there', !n4.e, n4.e?.message)
  eq('B1: ... and the leftovers moved to the people still there, exactly', [(await leftoverOf(F.id))[U(4)] ?? 0, (await leftoverOf(F.id))[U(3)], (await leftoverOf(F.id))[U(2)], cents(Object.values(await totals(F.id)).reduce((s, x) => s + x, 0)), (await lineOk(F.id)).length], [0, 17.5, 2.5, 3000, 0])
  eq('B1: Carol holds nothing on the receipt any more', (await claimRows(F.id)).filter(r => r.u === U(4)).length, 0)
  const un = await UNDO(4, F.id)
  ok('B1: undo puts her back and re-shares', !un.e && (await leftoverOf(F.id))[U(4)] === 10, un.e?.message)
  // reitemise dropping the person-mode target from the list: leftovers cleared, no stuck state
  const G = await mkExpense({ payer: 2, amount: 30, desc: 'B1 reitemise', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(G, { 0: 2 })
  await SEND(2, G.id)
  await SHARE(2, G.id, 'person', U(3))
  const rg = await REIT(2, G.id, { participant_ids: [U(2), U(4)] }, [LN(G.lines[0], 'a', 1, 10, 10), LN(G.lines[1], 'b', 1, 20, 20)])
  eq('B1/S2: a changed participant list counts as a change: leftovers stripped, mode cleared', [rg.r?.j.leftovers_cleared, (await q1(`select leftover_mode m from expenses where id=$1`, [G.id])).m, (await leftoverOf(G.id))[U(3)] ?? 0], [true, null, 0])
}

// ---- B2: client answers take the locks, and are refused after the deadline / when closed, exactly like the links -------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 20, desc: 'B2 deadline', tagged: [2, 3, 4], lines: [['a', 1, 20]] })
  await SEND(2, E.id)
  await db.exec('BEGIN')
  const d1 = await DONE(3, E.id)
  const locks = await q1(`select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
                            and ((classid::bigint << 32) | objid::bigint) in (hashtextextended('settlement_freeze:' || $1::text, 0), hashtextextended('receipt_claims:' || $2::text, 0))`, [T, E.id])
  await db.exec('COMMIT')
  ok('B2: a client answer works while the deadline is open', !d1.e, d1.e?.message)
  eq('B2: ... and it took BOTH advisory locks (trip freeze lock, then the expense lock) like every other writer', locks.n, 2)
  await setLive(E.id, `claim_deadline = now() - interval '1 minute'`)
  eq('B2: after the deadline a client answer is refused (insert)', (await DONE(4, E.id)).e?.hint, 'deadline_passed')
  eq('B2: ... change', (await NOT_THERE(3, E.id)).e?.hint, 'deadline_passed')
  eq('B2: ... and delete', (await UNDO(3, E.id)).e?.hint, 'deadline_passed')
  const tk = await issue(E.id, 4).catch(() => null)
  await setLive(E.id, `claim_deadline = now() + interval '1 day'`)
  const t4 = await issue(E.id, 4)
  await setLive(E.id, `claim_deadline = now() - interval '1 minute'`)
  const lk = await act(t4.hash, 'done')
  eq('B2: the link says the same thing (identically)', [lk.r.j.result, lk.r.j.reason], ['refused', 'deadline_passed'])
  await setLive(E.id, `claims_closed_at = now()`)
  eq('B2: closed: client answer refused with claims_closed; so is the link', [(await DONE(4, E.id)).e?.hint, (await act(t4.hash, 'done')).r.j.reason], ['claims_closed', 'claims_closed'])
}

// ---- B3: "I wasn't there" on a receipt with a TABLE item -----------------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 52, desc: 'B3 table item', tagged: [2, 3, 4, 21], lines: [['bread', 1, 12], ['main', 1, 40]] })
  await SET(2, E.id, [{ line_item_id: E.lines[0], shared_by_all: true }])
  await assign(E, { 1: 2 })
  await SEND(2, E.id)
  const bread = async () => (await claimRows(E.id)).filter(r => r.l === E.lines[0]).map(r => [r.u, r.a, r.q]).sort()
  eq('B3: before: bread 3.00 each', (await bread()).map(x => x[1]), [3, 3, 3, 3])
  const nt = await NOT_THERE(21, E.id)
  ok('B3: Dave (only a table-item share) can say "I wasn\'t there" (client)', !nt.e, nt.e?.message)
  const b1 = await bread()
  eq('B3: his share is removed and the line is re-split among the three (4.00 each, exact pennies and quantity)', [b1.map(x => x[1]), cents(b1.reduce((s, x) => s + x[2], 0)), b1.some(x => x[0] === U(21))], [[4, 4, 4], 100, false])
  const un = await UNDO(21, E.id)
  const b2 = await bread()
  ok('B3: undo restores the 4-way split', !un.e && b2.map(x => x[1]).join() === '3,3,3,3' && cents(b2.reduce((s, x) => s + x[2], 0)) === 100, b2)
  // odd split: 10.00 over 3 people -> the lowest user_ids take the extra penny
  const O = await mkExpense({ payer: 2, amount: 20, desc: 'B3 odd', tagged: [2, 3, 4, 21], lines: [['bottle', 1, 10], ['rest', 1, 10]] })
  await SET(2, O.id, [{ line_item_id: O.lines[0], shared_by_all: true }])
  await NOT_THERE(21, O.id)
  eq('B3: 10.00 over three: 3.34 / 3.33 / 3.33 (largest remainder, lowest user_id first)', (await claimRows(O.id)).filter(r => r.l === O.lines[0]).map(r => [r.u, r.a]).sort(), [[U(2), 3.34], [U(3), 3.33], [U(4), 3.33]])
  // through the link
  const L = await mkExpense({ payer: 2, amount: 30, desc: 'B3 link', tagged: [2, 3, 4], lines: [['bread', 1, 9], ['rest', 1, 21]] })
  await SET(2, L.id, [{ line_item_id: L.lines[0], shared_by_all: true }])
  await SEND(2, L.id)
  const tl = await issue(L.id, 4)
  const lk = await act(tl.hash, 'not_there')
  eq('B3: through the link: ok, off the receipt, bread re-split 4.50 / 4.50', [lk.r.j.result, lk.r.j.state.on_receipt, (await claimRows(L.id)).filter(r => r.l === L.lines[0]).map(r => r.a)], ['ok', false, [4.5, 4.5]])
  const ud = await act(tl.hash, 'undo_done')
  eq('B3: undo through the link restores the three-way split', (await claimRows(L.id)).filter(r => r.l === L.lines[0]).map(r => r.a).sort(), [3, 3, 3])
  // the answer is honoured at APPLY even if the re-split trigger did not run (defence in depth)
  const A = await mkExpense({ payer: 2, amount: 30, desc: 'B3 apply', tagged: [2, 3, 4], lines: [['bread', 1, 9], ['rest', 1, 21]] })
  await SET(2, A.id, [{ line_item_id: A.lines[0], shared_by_all: true }])
  await SEND(2, A.id)
  await db.exec('ALTER TABLE expense_claim_responses DISABLE TRIGGER trg_after_claim_response')
  await db.query(`insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'not_there')`, [A.id, U(4)])
  await db.exec('ALTER TABLE expense_claim_responses ENABLE TRIGGER trg_after_claim_response')
  eq('B3: (stale) before apply Carol still holds a bread share', (await claimRows(A.id)).filter(r => r.l === A.lines[0] && r.u === U(4)).length, 1)
  const ap = await APPLY(2, A.id)
  ok('B3: apply re-splits table items first', !ap.e && (await claimRows(A.id)).filter(r => r.l === A.lines[0]).map(r => r.a).join() === '4.5,4.5' && (await lineOk(A.id)).length === 0 && !(U(4) in (await totals(A.id))), ap.e?.message ?? JSON.stringify(await claimRows(A.id)))
}

// ---- S1: a closed receipt is final until it is REOPENED ----------------------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'S1 closed', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(E, { 0: 3 })
  await SEND(2, E.id)
  await respond(E.id, 4, 'done')
  const ap = await APPLY(2, E.id)
  ok('S1: applied', ap.r?.j.applied === true, ap.e?.message)
  eq('S1: Bob un-toggles in-app on the closed receipt: refused', (await SET(3, E.id, [{ line_item_id: E.lines[0], user_ids: [] }])).e?.hint, 'claims_closed')
  eq('S1: the payer\'s set_receipt_claims is refused too (reopen first)', (await SET(2, E.id, [{ line_item_id: E.lines[0], user_ids: [U(2)] }])).e?.hint, 'claims_closed')
  eq('S1: an old client DELETEs his claim rows directly: refused', (await call(3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [E.id, U(3)])).e?.hint, 'claims_closed')
  eq('S1: ... INSERT', (await call(4, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [E.lines[0], U(4), E.id])).e?.hint, 'claims_closed')
  eq('S1: ... UPDATE', (await call(3, `update expense_item_claims set quantity_claimed=0.5, amount_owed=5 where expense_id=$1 and user_id=$2 and leftover_quantity=0`, [E.id, U(3)])).e?.hint, 'claims_closed')
  ok('S1: nothing became unclaimed', (await lineOk(E.id)).length === 0)
  eq('S1: reopen by a non-manager', (await call(3, `select reopen_receipt_claims($1) j`, [E.id])).e?.hint, 'forbidden')
  eq('S1: reopen with no JWT', (await call(null, `select reopen_receipt_claims($1) j`, [E.id])).e?.hint, 'auth')
  const nd = new Date(Date.now() + 4 * 86400e3).toISOString()
  const tkn = await issue(E.id, 3).catch(() => null)
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [T])
  eq('S1: reopen on a frozen trip: refused', (await call(2, `select reopen_receipt_claims($1,$2) j`, [E.id, nd])).e?.hint, 'frozen')
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
  eq('S1: reopen with a past deadline', (await call(2, `select reopen_receipt_claims($1,$2) j`, [E.id, new Date(Date.now() - 1000).toISOString()])).e?.hint, 'bad_deadline')
  const ro = await call(2, `select reopen_receipt_claims($1,$2) j`, [E.id, nd])
  ok('S1: payer reopens', !ro.e, ro.e?.message)
  eq('S1: reopened: new deadline, closed cleared, leftovers stripped, mode cleared, answers kept, tells who had been charged', [new Date(ro.r.j.claim_deadline).toISOString(), (await q1(`select claims_closed_at c, leftover_mode m from expenses where id=$1`, [E.id])), Object.keys(await leftoverOf(E.id)).length, (await respOf(E.id)).length, ro.r.j.was_charged.length > 0], [nd, { c: null, m: null }, 0, 1, true])
  eq('S1: reopen on a receipt that is not closed', (await call(2, `select reopen_receipt_claims($1) j`, [E.id])).e?.hint, 'not_closed')
  ok('S1: Bob can un-toggle again in-app', !(await SET(3, E.id, [{ line_item_id: E.lines[0], user_ids: [] }])).e)
  const rr = await REIT(2, E.id, {}, [LN(E.lines[0], 'a', 1, 10, 11), LN(E.lines[1], 'b', 1, 20, 20)])
  ok('S1: re-itemise works on the reopened receipt', !rr.e, rr.e?.message)
  // closing again and a payer-driven delete (cascades are not clients)
  await APPLY(2, E.id)
  const del = await call(2, `delete from expenses where id=$1 returning id`, [E.id])
  ok('S1: the payer can still DELETE a closed receipt (the FK cascades are not client writes)', !del.e && del.r?.id === E.id && (await q1(`select count(*)::int n from expense_item_claims where expense_id=$1`, [E.id])).n === 0, del.e?.message)
}

// ---- S2/S3 re-itemise: who is on the receipt, and "done" answers -------------------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 60, desc: 'S2 payer change', tagged: [2, 3, 4], lines: [['a', 1, 20], ['b', 1, 40]] })
  await assign(E, { 0: 2 })
  await SEND(2, E.id)
  await SHARE(2, E.id, 'payer')
  eq('S2: before: the payer holds the 40.00 of leftovers', (await leftoverOf(E.id))[U(2)], 40)
  await NOT_THERE(3, E.id)   // Bob is away; then the payer role moves to him: his stale answer must go
  const rp = await REIT(2, E.id, { paid_by: U(3) }, [LN(E.lines[0], 'a', 1, 20, 20), LN(E.lines[1], 'b', 1, 40, 40)])
  ok('S2: a paid_by change is accepted', !rp.e, rp.e?.message)
  eq('S2: ... and counts as a change: leftovers stripped and the mode cleared (no stale payer-mode leftovers)', [rp.r.j.leftovers_cleared, (await q1(`select leftover_mode m from expenses where id=$1`, [E.id])).m, Object.keys(await leftoverOf(E.id)).length], [true, null, 0])
  eq('S2: the new payer\'s stale "I wasn\'t there" is removed', (await respOf(E.id)).filter(r => r[0] === U(3)).length, 0)
  // table items follow a changed participant list
  const T1 = await mkExpense({ payer: 2, amount: 30, desc: 'S2 table', tagged: [2, 3, 4], lines: [['bread', 1, 9], ['rest', 1, 21]] })
  await SET(2, T1.id, [{ line_item_id: T1.lines[0], shared_by_all: true }])
  const rt = await REIT(2, T1.id, { participant_ids: [U(2), U(3)] }, [LN(T1.lines[0], 'bread', 1, 9, 9), LN(T1.lines[1], 'rest', 1, 21, 21)])
  eq('S2: an unchanged table item is re-split over the new list (4.50 / 4.50)', [rt.r?.j.cleared_claims, (await claimRows(T1.id)).filter(r => r.l === T1.lines[0]).map(r => r.a).sort()], [0, [4.5, 4.5]])
  // S3: new lines clear every "done"
  const D = await mkExpense({ payer: 2, amount: 30, desc: 'S3 done', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(D, { 0: 3 })
  await SEND(2, D.id)
  await respond(D.id, 3, 'done'); await respond(D.id, 4, 'done')
  const r0 = await REIT(2, D.id, { description: 'just a title' }, [LN(D.lines[0], 'a', 1, 10, 10), LN(D.lines[1], 'b', 1, 20, 20)])
  eq('S3: a header-only edit keeps the answers', [r0.r.j.reconfirm_user_ids, (await respOf(D.id)).length], [[], 2])
  const r1 = await REIT(2, D.id, {}, [LN(D.lines[0], 'a', 1, 10, 10), LN(D.lines[1], 'b', 1, 20, 20), LN(null, 'surprise wine', 1, 30, 30)])
  eq('S3: a NEW line clears everyone\'s "done" and returns them', [r1.r.j.reconfirm_user_ids, (await respOf(D.id)).length, r1.r.j.cleared_user_ids], [sortU([3, 4]), 0, []])
  // currency, link, check violation, discount percent
  const C = await mkExpense({ payer: 2, amount: 20, desc: 'S8 currency', tagged: [2, 3], lines: [['a', 1, 20]] })
  await db.query(`update expenses set fx_rate=0.85, rate_source='ecb' where id=$1`, [C.id])
  await db.query(`update expense_line_items set line_discount_percent=10 where id=$1`, [C.lines[0]])
  eq('S8: EUR -> USD without an exchange rate: refused', (await REIT(2, C.id, { currency: 'USD' }, [LN(C.lines[0], 'a', 1, 20, 20)])).e?.hint, 'bad_header')
  const cu = await REIT(2, C.id, { currency: 'USD', fx_rate: 0.79, fx_rate_date: '2026-11-17', rate_source: 'manual' }, [LN(C.lines[0], 'a', 1, 20, 20)])
  eq('S8: with a rate: stored; the old rate is gone; base amount follows', [cu.e?.message, (await q1(`select fx_rate::float f, rate_source s, base_currency_amount::float b from expenses where id=$1`, [C.id]))], [undefined, { f: 0.79, s: 'manual', b: 15.8 }])
  const bk = await REIT(2, C.id, { currency: 'GBP' }, [LN(C.lines[0], 'a', 1, 20, 20)])
  eq('S8: back to the trip base currency (GBP): no rate needed, the rate is dropped', [bk.e?.message, (await q1(`select fx_rate f, base_currency_amount b, rate_source s from expenses where id=$1`, [C.id]))], [undefined, { f: null, b: null, s: null }])
  eq('S8: needs_link when no allocation link exists, false once it does', [bk.r.j.needs_link, (await (async () => { await db.query(`insert into expense_allocation_links(expense_id,trip_id,created_by,code) values ($1,$2,$3,$4)`, [C.id, T, U(2), 'code' + Math.random()]); return (await REIT(2, C.id, {}, [LN(C.lines[0], 'a', 1, 20, 20)])).r.j.needs_link })())], [true, false])
  eq('S8: a changed line resets line_discount_percent; an unchanged one keeps it', [(await q1(`select line_discount_percent::float p from expense_line_items where id=$1`, [C.lines[0]])).p], [0])
  await db.query(`update expense_line_items set line_discount_percent=10 where id=$1`, [C.lines[0]])
  await REIT(2, C.id, {}, [LN(C.lines[0], 'a', 1, 20, 21)])
  eq('S8: ... (total-only change keeps it)', (await q1(`select line_discount_percent::float p from expense_line_items where id=$1`, [C.lines[0]])).p, 10)
  eq('S8: a live-style CHECK violation surfaces as bad_line, nothing written', [(await REIT(2, C.id, {}, [LN(C.lines[0], 'x'.repeat(300), 1, 20, 21)])).e?.hint, (await q1(`select name_original n from expense_line_items where id=$1`, [C.lines[0]])).n], ['bad_line', 'a'])
}

// ---- set_receipt_claims: someone ELSE changing a person's items clears their "done"; their own edits keep it ---------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 60, desc: 'done cleared', tagged: [2, 3, 4], lines: [['a', 1, 20], ['b', 1, 20], ['c', 1, 20]] })
  await assign(E, { 0: 3 })
  await SEND(2, E.id)
  await respond(E.id, 3, 'done'); await respond(E.id, 4, 'done')
  await SET(3, E.id, [{ line_item_id: E.lines[1], user_ids: [U(3)] }])
  eq('own edit (Bob adds himself to b): his "done" stays', (await respOf(E.id)).map(r => r[0]).sort(), sortU([3, 4]))
  await SET(2, E.id, [{ line_item_id: E.lines[2], user_ids: [U(2)] }])
  eq('the payer edits their OWN line: nobody else is affected', (await respOf(E.id)).length, 2)
  await SET(2, E.id, [{ line_item_id: E.lines[1], user_ids: [U(3), U(4)] }])
  eq('the payer re-assigns line b to Bob and Carol: both "done" answers are cleared', (await respOf(E.id)).length, 0)
  await respond(E.id, 3, 'done')
  await SHARE(2, E.id, 'everyone')
  eq('derived leftover writes never clear anyone\'s answer', (await respOf(E.id)).length, 1)
}

// ---- apply preview ----------------------------------------------------------------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'apply preview', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 4], ['rest', 1, 16]] })
  await assign(E, { 0: 2, 1: 3 })
  await SEND(2, E.id)
  await respond(E.id, 4, 'done')
  const before = await dumpExp(E.id)
  const pv = await APPLY(2, E.id, true)
  ok('apply preview ok (payer, early)', !pv.e, pv.e?.message)
  eq('apply preview wrote nothing (claims, responses, expense row, activity)', await dumpExp(E.id), before)
  eq('... and nothing is closed', (await q1(`select claims_closed_at c from expenses where id=$1`, [E.id])).c, null)
  const rl = await APPLY(2, E.id)
  const norm = j => JSON.stringify({ ...j, preview: undefined, closed_at: undefined })
  eq('apply preview result == real result', norm(pv.r.j), norm(rl.r.j))
  eq('preview flagged', [pv.r.j.preview, rl.r.j.preview], [true, false])
  await setLive(E.id, `claims_closed_at = null`)
  const F = await mkExpense({ payer: 2, amount: 20, desc: 'preview svc', tagged: [2, 3], lines: [['a', 1, 20]] })
  await SEND(2, F.id)
  await setLive(F.id, `claim_deadline = now() - interval '1 minute'`)
  const ps = await call('svc', `select apply_receipt_deadline($1,true) j`, [F.id])
  ok('the service role can preview too, and writes nothing', !ps.e && ps.r.j.preview === true && (await q1(`select claims_closed_at c from expenses where id=$1`, [F.id])).c === null, ps.e?.message)
  eq('an old one-argument call still resolves (default false)', (await call('svc', `select apply_receipt_deadline($1) j`, [F.id])).r.j.applied, true)
}

// ---- tokens: expiry follows the deadline; leaving the trip kills the link --------------------------------------------------------------------------------------------
{
  const E = await mkExpense({ payer: 2, amount: 20, desc: 'tokens', lines: [['a', 1, 20]] })   // NO explicit list (an explicit list would keep inactive / declined people on it)
  await SEND(2, E.id)
  const t3 = await issue(E.id, 3), t4 = await issue(E.id, 4)
  const exp = async h => (await q1(`select expires_at e from receipt_claim_tokens where token_hash=$1`, [h])).e
  const dl0 = (await q1(`select claim_deadline d from expenses where id=$1`, [E.id])).d
  ok('S4: a fresh link expires at deadline + 7 days', Math.abs(new Date(await exp(t3.hash)) - dl0 - 7 * 86400e3) < 1000)
  const far = new Date(Date.now() + 40 * 86400e3)
  await EXTEND(2, E.id, far.toISOString())
  ok('S4: extending the deadline moves the links with it', Math.abs(new Date(await exp(t3.hash)) - far - 7 * 86400e3) < 1000, await exp(t3.hash))
  await SEND(2, E.id, new Date(far.getTime() + 86400e3).toISOString())
  ok('S4: moving the deadline through send_receipt_to_table does too', Math.abs(new Date(await exp(t4.hash)) - far - 8 * 86400e3) < 1000)
  eq('S5: before: both links work', [(await peek(t3.hash)).r.j.result, (await peek(t4.hash)).r.j.result], ['ok', 'ok'])
  await db.query(`delete from trip_participants where trip_id=$1 and user_id=$2`, [T, U(3)])
  eq('S5: the person left the trip: peek and act say revoked', [(await peek(t3.hash)).r.j.result, (await act(t3.hash, 'done')).r.j.result], ['revoked', 'revoked'])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true)`, [T, U(3)])
  await db.query(`update trip_participants set active=false where trip_id=$1 and user_id=$2`, [T, U(4)])
  eq('S5: made inactive: revoked', (await peek(t4.hash)).r.j.result, 'revoked')
  await db.query(`update trip_participants set active=true, confirmation_status='declined' where trip_id=$1 and user_id=$2`, [T, U(4)])
  eq('S5: declined: revoked', (await peek(t4.hash)).r.j.result, 'revoked')
  await db.query(`update trip_participants set confirmation_status=null where trip_id=$1 and user_id=$2`, [T, U(4)])
  eq('S5: back on the trip: works again', (await peek(t4.hash)).r.j.result, 'ok')
  const ro = await call(2, `select reopen_receipt_claims($1) j`, [E.id]).catch(() => null)
}

// ---- S6/S7/S9 and the rest ------------------------------------------------------------------------------------------------------------------------------------------------
{
  const o = await call(9, `select _expense_trip_member($1,$2) j`, [(await mkExpense({ amount: 5, desc: 'oracle', lines: [['x', 1, 5]] })).id, U(2)])
  ok('S6: _expense_trip_member is not executable by a signed-in client (no membership oracle)', !!o.e && /permission denied/i.test(o.e.message), o.e?.message)
  // S7: a sent receipt converted back to plain
  const E = await mkExpense({ payer: 2, amount: 20, desc: 'to plain', tagged: [2, 3], lines: [['a', 1, 20]] })
  await SEND(2, E.id)
  await call(2, `update expenses set ai_parsed=false where id=$1`, [E.id])
  eq('S7: converting to plain clears the claim state (client UPDATE)', await q1(`select claim_deadline d, claims_sent_at s, claims_closed_at c from expenses where id=$1`, [E.id]), { d: null, s: null, c: null })
  await db.query(`update expenses set ai_parsed=true where id=$1`, [E.id])
  await setLive(E.id, `claims_sent_at = now(), claim_deadline = now() - interval '1 minute'`)
  await db.query(`delete from expense_line_items where expense_id=$1`, [E.id])
  const sk = await call('svc', `select apply_receipt_deadline($1,false) j`, [E.id])
  eq('S7: the job gets a quiet skipped:not_itemised, not an error', [sk.e?.message, sk.r?.j.applied, sk.r?.j.skipped], [undefined, false, 'not_itemised'])
  const sk2 = await call(2, `select apply_receipt_deadline($1,false) j`, [E.id])
  eq('S7: the payer too', sk2.r?.j.skipped, 'not_itemised')
  // S9 covered in section 13 (not frozen = no-op)
  // fidelity: RLS on the base tables really applies to clients
  const X = await mkExpense({ trip: T2, payer: 2, amount: 5, desc: 'other trip', lines: [['x', 1, 5]] })
  eq('RLS: a client cannot read an expense of a trip they are not on', (await qa(`select 1`)).length && (await call(3, `select count(*)::int n from expenses where id=$1`, [X.id])).r.n, 0)
  eq('RLS: a client cannot UPDATE a line item (no UPDATE policy)', (await call(2, `with u as (update expense_line_items set name_original='hax' where id=$1 returning 1) select count(*)::int n from u`, [E.lines[0] ?? X.lines[0]])).r.n, 0)
  eq('RLS: a client cannot write another person\'s activity row', (await call(3, `insert into activity_feed(trip_id,actor,verb) values ($1,$2,'x')`, [T, U(2)])).e?.code, '42501')
}

// ======================================================================================================================================
// 15. Final check: closed receipts immutable for clients, table shares only move on explicit acts, lock order, apply preview in person/payer mode, explicit list wins
// ======================================================================================================================================
{
  // ---- 1. closed = immutable (old cached client re-itemise; ai_parsed flip; line item side door); definer paths and whole-expense delete still work
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'closed immutable', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await assign(E, { 0: 3 })
  await SEND(2, E.id)
  await APPLY(2, E.id)
  const snap = async () => JSON.stringify(await q1(`select amount::float a, currency c, paid_by::text p, participant_ids pi, fx_rate f, base_currency_amount b, ai_parsed ai, claims_closed_at is not null cl, claims_sent_at is not null s from expenses where id=$1`, [E.id]))
  const s0 = await snap()
  for (const [label, set] of [['amount', `amount = 45`], ['currency', `currency = 'USD'`], ['paid_by', `paid_by = '${U(3)}'`], ['participant_ids', `participant_ids = ARRAY['${U(2)}']::uuid[]`], ['fx_rate', `fx_rate = 0.5`], ['base_currency_amount', `base_currency_amount = 5`], ['ai_parsed true -> false', `ai_parsed = false`]]) {
    eq(`closed: a client cannot change ${label}`, (await call(2, `update expenses set ${set} where id=$1`, [E.id])).e?.hint, 'claims_closed')
  }
  eq('closed: ... and nothing moved (the old-client convert would have credited the payer extra)', await snap(), s0)
  ok('closed: description / category / receipt_url stay editable', !(await call(3, `update expenses set description='renamed', receipt_url='r.jpg', vendor_name='V' where id=$1`, [E.id])).e)
  eq('closed: a client cannot DELETE a line item (it would cascade to the claims as the owner)', (await call(2, `delete from expense_line_items where id=$1`, [E.lines[1]])).e?.hint, 'claims_closed')
  eq('closed: ... INSERT', (await call(2, `insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,9,'x',1,1,1,1)`, [E.id])).e?.hint, 'claims_closed')
  ok('closed: nothing became unclaimed', (await lineOk(E.id)).length === 0 && (await qa(`select 1 from expense_line_items where expense_id=$1`, [E.id])).length === 2)
  eq('closed: the old-client delete-and-reinsert re-itemise is refused at the FIRST write', (await call(2, `update expenses set amount = 99, ai_parsed = true where id=$1`, [E.id])).e?.hint, 'claims_closed')
  // reopen is a definer path: then edits work again
  await call(2, `select reopen_receipt_claims($1) j`, [E.id])
  ok('reopened: header edits and line changes work again', !(await call(2, `update expenses set amount = 31 where id=$1`, [E.id])).e && !(await call(2, `delete from expense_line_items where id=$1`, [E.lines[1]])).e)
  // not closed but sent: the ai_parsed flip is the documented "convert to plain" and clears the claim state
  await APPLY(2, E.id)
  const del = await call(2, `delete from expenses where id=$1 returning id`, [E.id])
  ok('closed: the payer can still delete the whole expense (cascades run as the owner through the guards)', !del.e && del.r?.id === E.id && (await q1(`select count(*)::int n from expense_line_items where expense_id=$1`, [E.id])).n === 0, del.e?.message)
}
{
  // ---- 2. a person who simply does not reply keeps their table share at apply (NULL-list receipt); explicit removal / not_there moves it
  const E = await mkExpense({ payer: 2, amount: 40, desc: 'table share stays', lines: [['bread', 1, 12], ['main', 1, 28]] })   // NO explicit list: everyone in scope
  await SET(2, E.id, [{ line_item_id: E.lines[0], shared_by_all: true }])
  const holders = async () => (await claimRows(E.id)).filter(r => r.l === E.lines[0]).length
  const n0 = await holders()
  await SEND(2, E.id)
  await respond(E.id, 3, 'done')
  await setLive(E.id, `claim_deadline = now() - interval '1 minute'`)
  const own = async () => JSON.stringify((await claimRows(E.id)).filter(r => r.l === E.lines[0]).map(r => [r.u, +(r.a - r.la).toFixed(2)]))
  const before = await own()
  const ap = await call('svc', `select apply_receipt_deadline($1,false) j`, [E.id])
  ok('apply ran', !ap.e && ap.r.j.applied, ap.e?.message)
  eq('NULL-list receipt: non-repliers keep their table share at apply (nothing moved silently)', [await holders(), await own()], [n0, before])
  // a member who left (row gone) but holds a table share on a NULL-list receipt stays on it too
  const L = await mkExpense({ payer: 2, amount: 20, desc: 'left but holds', lines: [['bread', 1, 8], ['main', 1, 12]] })
  await SET(2, L.id, [{ line_item_id: L.lines[0], shared_by_all: true }])
  const had = (await claimRows(L.id)).filter(r => r.u === U(28)).length
  await db.query(`update trip_participants set active=false where trip_id=$1 and user_id=$2`, [T, U(28)])
  eq('NULL list: an inactive member holding a table share is still on the receipt (the share does not move)', [had, (await q1(`select _receipt_tagged($1) @> ARRAY[$2::uuid] t`, [L.id, U(28)])).t], [1, true])
  await db.query(`update trip_participants set active=true where trip_id=$1 and user_id=$2`, [T, U(28)])
  // explicit list: the list decides (removal is the explicit act)
  const X = await mkExpense({ payer: 2, amount: 30, desc: 'explicit list', tagged: [2, 3, 4], lines: [['bread', 1, 9], ['main', 1, 21]] })
  await SET(2, X.id, [{ line_item_id: X.lines[0], shared_by_all: true }])
  await REIT(2, X.id, { participant_ids: [U(2), U(3)] }, [LN(X.lines[0], 'bread', 1, 9, 9), LN(X.lines[1], 'main', 1, 21, 21)])
  eq('explicit list: removing Carol from the list moves her table share (4.50 / 4.50)', (await claimRows(X.id)).filter(r => r.l === X.lines[0]).map(r => r.a).sort(), [4.5, 4.5])
}
{
  // ---- 5. an explicit list wins: a declined / inactive person ON the list is on the receipt and keeps a working link
  const E = await mkExpense({ payer: 2, amount: 30, desc: 'explicit list wins', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 20]] })
  await SEND(2, E.id)
  const t4 = await issue(E.id, 4)
  await db.query(`update trip_participants set active=true, confirmation_status='declined' where trip_id=$1 and user_id=$2`, [T, U(4)])
  eq('explicit list: a declined person on the list is on the receipt', (await q1(`select _receipt_tagged($1) @> ARRAY[$2::uuid] t`, [E.id, U(4)])).t, true)
  eq('explicit list: ... and their link works', (await peek(t4.hash)).r.j.result, 'ok')
  eq('explicit list: ... and they are charged leftovers like everyone', (await SHARE(2, E.id, 'everyone', null, true)).r.j.people.some(p => p.user_id === U(4)), true)
  await db.query(`update trip_participants set confirmation_status=null where trip_id=$1 and user_id=$2`, [T, U(4)])
  // the same person on a NULL-list receipt (confirmation tracking on, declined) is NOT on it and the link is revoked
  const N = await mkExpense({ payer: 2, amount: 30, desc: 'null list declined', lines: [['a', 1, 10], ['b', 1, 20]] })
  await SEND(2, N.id)
  const n4 = await issue(N.id, 4)
  await db.query(`update trip_participants set confirmation_status='declined' where trip_id=$1 and user_id=$2`, [T, U(4)])
  eq('NULL list: a declined person has no working link', (await peek(n4.hash)).r.j.result, 'revoked')
  await db.query(`update trip_participants set confirmation_status=null where trip_id=$1 and user_id=$2`, [T, U(4)])
}
{
  // ---- 3. respond_to_receipt takes the locks BEFORE the row, with the same refusals
  const E = await mkExpense({ payer: 2, amount: 20, desc: 'respond rpc', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 10]] })
  await assign(E, { 0: 3 })
  await SEND(2, E.id)
  await db.exec('BEGIN')
  const r1 = await call(4, `select respond_to_receipt($1,'done') j`, [E.id])
  const lk = await q1(`select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
                         and ((classid::bigint << 32) | objid::bigint) in (hashtextextended('settlement_freeze:' || $1::text, 0), hashtextextended('receipt_claims:' || $2::text, 0))`, [T, E.id])
  await db.exec('COMMIT')
  eq('respond_to_receipt: done is stored, both locks taken (freeze, expense) before the row', [r1.r?.j.response, r1.r?.j.changed, lk.n, (await respOf(E.id)).length], ['done', true, 2, 1])
  eq('respond_to_receipt: undo', [(await call(4, `select respond_to_receipt($1,'undo') j`, [E.id])).r.j.response, (await respOf(E.id)).length], [null, 0])
  eq('respond_to_receipt: payer cannot be not_there / has_claims / not a member / bad answer / no JWT',
    [(await call(2, `select respond_to_receipt($1,'not_there') j`, [E.id])).e?.hint, (await call(3, `select respond_to_receipt($1,'not_there') j`, [E.id])).e?.hint, (await call(9, `select respond_to_receipt($1,'done') j`, [E.id])).e?.hint, (await call(4, `select respond_to_receipt($1,'maybe') j`, [E.id])).e?.hint, (await call(null, `select respond_to_receipt($1,'done') j`, [E.id])).e?.hint],
    ['payer_not_there', 'has_claims', 'forbidden', 'bad_input', 'auth'])
  await setLive(E.id, `claim_deadline = now() - interval '1 minute'`)
  eq('respond_to_receipt: after the deadline / when closed', [(await call(4, `select respond_to_receipt($1,'done') j`, [E.id])).e?.hint], ['deadline_passed'])
  await setLive(E.id, `claims_closed_at = now()`)
  eq('... closed', (await call(4, `select respond_to_receipt($1,'done') j`, [E.id])).e?.hint, 'claims_closed')
  // the deletion of somebody else's answer never waits on a locked row: a payer edit with a locked response row of the affected person completes
  const D = await mkExpense({ payer: 2, amount: 20, desc: 'skip locked', tagged: [2, 3], lines: [['a', 1, 10], ['b', 1, 10]] })
  await assign(D, { 0: 3 })
  await SEND(2, D.id)
  await respond(D.id, 3, 'done')
  const keep = await q1(`select count(*)::int n from (select 1 from expense_claim_responses where expense_id=$1 for update skip locked) s`, [D.id])
  ok('(sanity) an unlocked answer can be locked and read', keep.n === 1)
}
{
  // ---- 4. apply preview in person / payer mode returns the same rows the real call writes
  for (const [mode, who] of [['person', 4], ['payer', null]]) {
    const E = await mkExpense({ payer: 2, amount: 30, desc: 'preview ' + mode, tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 4], ['rest', 1, 16]] })
    await assign(E, { 0: 2, 1: 3 })
    await SEND(2, E.id)
    await SHARE(2, E.id, mode, who == null ? null : U(who))
    const before = await dumpExp(E.id)
    const pv = await APPLY(2, E.id, true)
    eq(`apply preview (${mode} mode) wrote nothing`, await dumpExp(E.id), before)
    const rl = await APPLY(2, E.id)
    const norm = j => JSON.stringify({ ...j, preview: undefined, closed_at: undefined })
    eq(`apply preview (${mode} mode) == the real call`, norm(pv.r.j), norm(rl.r.j))
    eq(`apply (${mode} mode) keeps the explicit choice and reports it`, [rl.r.j.mode, rl.r.j.people.map(p => p.user_id), rl.r.j.leftover_user_id], [mode, [mode === 'payer' ? U(2) : U(4)], mode === 'person' ? U(4) : null])
    const claimsAfter = await claimRows(E.id)
    eq(`real rows == preview people (${mode})`, claimsAfter.filter(r => r.la > 0).map(r => r.u).sort(), rl.r.j.people.map(p => p.user_id).sort())
  }
}
