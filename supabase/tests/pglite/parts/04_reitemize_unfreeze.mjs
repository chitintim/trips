
// ======================================================================================================================================
// 11. reitemize_expense
// ======================================================================================================================================
const REIT = (u, eid, header, lines, prev = false) => call(u, `select reitemize_expense($1,$2::jsonb,$3::jsonb,$4) j`, [eid, JSON.stringify(header), JSON.stringify(lines), prev])
const LN = (id, name, qty, sub, tot, x = {}) => ({ id, name_original: name, name_english: null, quantity: qty, unit_price: +(sub / qty).toFixed(2), subtotal: sub, tax_amount: 0, service_amount: 0, line_discount_amount: null, total_amount: tot, ...x })
const dumpExp = async eid => JSON.stringify([
  await qa(`select id::text, line_number, name_original, quantity::float, subtotal::float, total_amount::float, shared_by_all from expense_line_items where expense_id=$1 order by id`, [eid]),
  await qa(`select id::text, line_item_id::text, user_id::text, quantity_claimed::float q, amount_owed::float a, source, created_by::text, leftover_quantity::float lq, leftover_amount::float la from expense_item_claims where expense_id=$1 order by id`, [eid]),
  await qa(`select user_id::text, response from expense_claim_responses where expense_id=$1 order by 1`, [eid]),
  await qa(`select amount::float, currency, description, status::text, ai_parsed, leftover_mode, paid_by::text, participant_ids, fx_rate::float, base_currency_amount::float from expenses where id=$1`, [eid]),
  await qa(`select count(*)::int n from activity_feed`), await qa(`select count(*)::int n from expense_splits where expense_id=$1`, [eid]),
])
{
  const mkRI = async () => {
    const RI = await mkExpense({ payer: 2, amount: 100, desc: 'Reitemise me', tagged: [2, 3, 4, 21], lines: [['pizza', 1, 30], ['beers', 3, 30], ['salad', 1, 20], ['wine', 1, 20]] })
    await assign(RI, { 0: 3, 1: [3, 4], 2: 4 })
    await SEND(2, RI.id)
    await respond(RI.id, 3, 'done'); await respond(RI.id, 4, 'done'); await respond(RI.id, 21, 'done')
    return RI
  }
  const RI = await mkRI()
  const cur = async () => qa(`select id::text, name_original from expense_line_items where expense_id=$1 order by line_number`, [RI.id])
  const mk = ids => [LN(ids[0], 'pizza', 1, 30, 33, { tax_amount: 3 }), LN(ids[1], 'beers x3 (craft)', 3, 30, 30), LN(ids[2], 'salad', 1, 20, 20), LN(null, 'dessert', 1, 10, 10)]
  // refusals
  await fails('reitemise: no JWT', null, `select reitemize_expense($1,'{}'::jsonb,'[]'::jsonb)`, [RI.id], { hint: 'auth' })
  await fails('reitemise: service role is not a payer', 'svc', `select reitemize_expense($1,'{}'::jsonb,'[]'::jsonb)`, [RI.id], { hint: 'auth' })
  await fails('reitemise: a tagged non-payer', 3, `select reitemize_expense($1,'{}'::jsonb,$2::jsonb)`, [RI.id, JSON.stringify(mk(RI.lines))], { hint: 'forbidden', code: '42501' })
  await fails('reitemise: an outsider', 9, `select reitemize_expense($1,'{}'::jsonb,$2::jsonb)`, [RI.id, JSON.stringify(mk(RI.lines))], { hint: 'forbidden' })
  await fails('reitemise: unknown expense', 2, `select reitemize_expense($1,'{}'::jsonb,'[]'::jsonb)`, ['99999999-0000-0000-0000-000000000000'], { hint: 'not_found' })
  const bad = async (label, lines, header = {}, hint = 'bad_line') => fails('reitemise: ' + label, 2, `select reitemize_expense($1,$2::jsonb,$3::jsonb)`, [RI.id, JSON.stringify(header), JSON.stringify(lines)], { hint })
  const L0 = mk(RI.lines)
  await bad('empty lines', [])
  await bad('same id twice', [L0[0], { ...L0[0] }])
  await bad('a line of another expense', [{ ...L0[0], id: (await mkExpense({ amount: 5, desc: 'other', lines: [['o', 1, 5]] })).lines[0] }])
  await bad('negative amount', [{ ...L0[0], total_amount: -1 }])
  await bad('too many decimals for the currency', [{ ...L0[0], subtotal: 10.001 }])
  await bad('quantity rounds to zero', [{ ...L0[0], quantity: 0.004 }])
  await bad('blank name', [{ ...L0[0], name_original: '  ' }])
  await bad('text amount', [{ ...L0[0], total_amount: 'abc' }])
  await bad('absurd amount', [{ ...L0[0], total_amount: 1e9 }])
  await bad('paid_by off the trip', L0, { paid_by: U(9) }, 'bad_header')
  await bad('participant off the trip', L0, { participant_ids: [U(2), U(9)] }, 'bad_header')
  await bad('currency shape', L0, { currency: 'EU' }, 'bad_header')
  await bad('fx rate zero', L0, { fx_rate: 0 }, 'bad_header')
  await bad('category not in the enum', L0, { category: 'spaceships' }, 'bad_header')
  await bad('a three-decimal currency', L0, { currency: 'KWD' }, 'currency_unsupported')
  eq('refusals wrote nothing', (await cur()).length, 4)
  // preview == real, preview writes nothing
  const before = await dumpExp(RI.id)
  const header = { description: 'Reitemised dinner', vendor_name: 'Le Bistrot', category: 'food', receipt_url: 'r/1.jpg', trip_id: T2, amount: 5 }
  const pv = await asC(async () => REIT(2, RI.id, header, mk(RI.lines), true))
  ok('preview ok (as authenticated)', !pv.e, pv.e?.message)
  eq('preview wrote nothing at all (lines, claims, responses, expense row, activity, splits)', await dumpExp(RI.id), before)
  const real = await REIT(2, RI.id, header, mk(RI.lines))
  ok('real ok', !real.e, real.e?.message)
  const norm = j => ({ ...j, preview: undefined, line_ids: j.line_ids.map((x, i) => i < 3 ? x : 'new') })
  eq('preview result == real result', norm(pv.r.j), norm(real.r.j))
  const j = real.r.j
  eq('kept 2 (pizza, salad), cleared 2 (the two beer rows), people 3 and 4', [j.kept_claims, j.cleared_claims, j.cleared_user_ids, j.leftovers_cleared], [2, 2, sortU([3, 4]), false])
  eq('line_ids: the three kept ids in order, then a new one', [j.line_ids.slice(0, 3), j.line_ids[3] && !RI.lines.includes(j.line_ids[3])], [RI.lines.slice(0, 3), true])
  const ls = await qa(`select line_number n, name_original nm, total_amount::float t, shared_by_all s from expense_line_items where expense_id=$1 order by line_number`, [RI.id])
  eq('lines renumbered 1..4 in order; the removed wine line is gone', ls.map(x => [x.n, x.nm, x.t]), [[1, 'pizza', 33], [2, 'beers x3 (craft)', 30], [3, 'salad', 20], [4, 'dessert', 10]])
  const cl = await claimRows(RI.id)
  eq('claims: pizza follows its new total (33.00), salad unchanged, nothing left on the changed beers line', cl.map(x => [x.l === RI.lines[0] ? 'pizza' : x.l === RI.lines[2] ? 'salad' : x.l === RI.lines[1] ? 'beers' : '?', x.u, x.a]).sort(), [['pizza', U(3), 33], ['salad', U(4), 20]])
  const e = await q1(`select amount::float a, description, vendor_name, category::text c, receipt_url, ai_parsed, status::text s, trip_id::text t from expenses where id=$1`, [RI.id])
  eq('header: amount = sum of line totals (client amount and trip_id ignored), other allowed keys applied', [e.a, e.description, e.vendor_name, e.c, e.receipt_url, e.ai_parsed, e.t], [93, 'Reitemised dinner', 'Le Bistrot', 'food', 'r/1.jpg', true, T])
  eq('status refreshed last', [e.s, j.status], ['pending_allocation', 'pending_allocation'])
  eq('any line change: EVERY "done" is removed and returned in reconfirm_user_ids (cleared_user_ids keeps its meaning)', [(await qa(`select user_id::text u from expense_claim_responses where expense_id=$1 order by 1`, [RI.id])).map(r => r.u), j.reconfirm_user_ids, j.needs_link], [[], sortU([3, 4, 21]), true])
  eq('claims_sent_at is untouched (still out at the table)', (await q1(`select claims_sent_at is not null s from expenses where id=$1`, [RI.id])).s, true)
  eq('one activity row', (await q1(`select count(*)::int n from activity_feed where verb='expense_reitemised' and entity->>'id'=$1`, [RI.id])).n, 1)
  // reorder (the +100000 shuffle) with everything unchanged: numbering follows the positions, claims intact
  const ids2 = (await cur()).map(x => x.id)
  const sw = await REIT(2, RI.id, {}, [LN(ids2[3], 'dessert', 1, 10, 10), LN(ids2[2], 'salad', 1, 20, 20), LN(ids2[1], 'beers x3 (craft)', 3, 30, 30), LN(ids2[0], 'pizza', 1, 30, 33, { tax_amount: 3 })])
  ok('reverse the order of the lines', !sw.e, sw.e?.message)
  eq('numbering follows the positions', (await cur()).map(x => x.id), [ids2[3], ids2[2], ids2[1], ids2[0]])
  eq('nothing was cleared by a pure reorder', [sw.r.j.cleared_claims, sw.r.j.kept_claims, (await claimRows(RI.id)).length], [0, 2, 2])
  // header only: no money moves
  const ho = await REIT(2, RI.id, { description: 'Renamed again' }, (await cur()).map(x => x.id).map((id, i) => [LN(id, 'dessert', 1, 10, 10), LN(id, 'salad', 1, 20, 20), LN(id, 'beers x3 (craft)', 3, 30, 30), LN(id, 'pizza', 1, 30, 33, { tax_amount: 3 })][i]))
  eq('header-only edit keeps all claims', [ho.r.j.cleared_claims, ho.r.j.kept_claims], [0, 2])
  // frozen / closed
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [T])
  await fails('reitemise while frozen', 2, `select reitemize_expense($1,'{}'::jsonb,$2::jsonb)`, [RI.id, JSON.stringify([LN(ids2[3], 'dessert', 1, 10, 10)])], { hint: 'frozen' })
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
  await db.query(`update expenses set claims_closed_at=now() where id=$1`, [RI.id])
  await fails('reitemise after the deadline was applied', 2, `select reitemize_expense($1,'{}'::jsonb,$2::jsonb)`, [RI.id, JSON.stringify([LN(ids2[3], 'dessert', 1, 10, 10)])], { hint: 'claims_closed' })
  await db.query(`update expenses set claims_closed_at=null where id=$1`, [RI.id])

  // leftovers present + any change: stripped, mode cleared
  const LO = await mkExpense({ payer: 2, amount: 60, desc: 'Leftover reitemise', tagged: [2, 3, 4], lines: [['a', 1, 20], ['b', 1, 20], ['c', 1, 20]] })
  await assign(LO, { 0: 3, 1: 4 })
  await SHARE(2, LO.id, 'everyone')
  ok('leftovers exist', (await claimRows(LO.id)).some(r => r.la > 0))
  const lp = await REIT(2, LO.id, {}, [LN(LO.lines[0], 'a', 1, 20, 20), LN(LO.lines[1], 'b', 1, 20, 20), LN(LO.lines[2], 'c', 1, 20, 22)])
  eq('total change on the unclaimed line: leftovers stripped, mode cleared', [lp.r.j.leftovers_cleared, (await claimRows(LO.id)).some(r => r.la > 0 || r.lq > 0), (await q1(`select leftover_mode m from expenses where id=$1`, [LO.id])).m, (await claimRows(LO.id)).map(r => r.a).sort((a, b) => a - b)], [true, false, null, [20, 20]])
  const lp2 = await REIT(2, LO.id, {}, [LN(LO.lines[0], 'a', 1, 20, 20), LN(LO.lines[1], 'b', 1, 20, 20), LN(LO.lines[2], 'c', 1, 20, 22)])
  eq('no change at all: leftovers_cleared false', lp2.r.j.leftovers_cleared, false)

  // plain -> itemised
  const PL = await mkExpense({ payer: 2, amount: 50, desc: 'Plain dinner', itemised: false, status: 'confirmed', lines: [] })
  await db.query(`insert into expense_splits(expense_id,user_id,amount) values ($1,$2,25),($1,$3,25)`, [PL.id, U(2), U(3)])
  const pl = await asC(async () => REIT(2, PL.id, { description: 'Now itemised', currency: 'EUR', fx_rate: 0.5, participant_ids: [U(2), U(3)] }, [LN(null, 'soup', 1, 20, 22, { tax_amount: 2 }), LN(null, 'steak', 2, 28, 28)]))
  ok('plain -> itemised ok', !pl.e, pl.e?.message)
  const pe = await q1(`select amount::float a, ai_parsed, status::text s, base_currency_amount::float b, participant_ids from expenses where id=$1`, [PL.id])
  eq('converted: amount = sum of lines, ai_parsed, unallocated (not confirmed), base amount = amount x rate', [pe.a, pe.ai_parsed, pe.s, pe.b], [50, true, 'unallocated', 25])
  eq('converted: splits deleted, lines numbered, nothing claimed/cleared', [(await q1(`select count(*)::int n from expense_splits where expense_id=$1`, [PL.id])).n, (await qa(`select line_number n from expense_line_items where expense_id=$1 order by 1`, [PL.id])).map(r => r.n), pl.r.j.cleared_claims, pl.r.j.kept_claims], [0, [1, 2], 0, 0])

  // penny rule
  const PN = await mkExpense({ payer: 2, amount: 70, desc: 'Penny rule', tagged: [2, 3, 4, 21], lines: [['partial', 3, 30], ['thirds', 3, 10], ['legacy', 1, 10], ['same', 1, 10]] })
  const ins = (l, u, q, a) => db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [PN.lines[l], U(u), PN.id, q, a])
  await ins(0, 3, 1, 10); await ins(0, 4, 0.5, 5)                 // partial: 1.5 of 3 units
  await ins(1, 3, 1, 3.34); await ins(1, 4, 1, 3.33); await ins(1, 21, 1, 3.33)   // fully claimed, thirds of 10.00
  for (const u of [3, 4, 21]) await ins(2, u, 0.33, 3.3)          // legacy 0.33 x 3
  await ins(3, 4, 1, 10)
  const legacyBefore = JSON.stringify((await claimRows(PN.id)).filter(r => r.l === PN.lines[2] || r.l === PN.lines[3]))
  const pn = await REIT(2, PN.id, {}, [LN(PN.lines[0], 'partial', 3, 30, 31), LN(PN.lines[1], 'thirds', 3, 10, 10.01), LN(PN.lines[2], 'legacy', 1, 10, 10), LN(PN.lines[3], 'same', 1, 10, 10)])
  ok('penny rule call ok', !pn.e, pn.e?.message)
  const am = l => (cl2 => cl2.filter(r => r.l === PN.lines[l]).map(r => [r.u, r.a]).sort())(PN._cl)
  PN._cl = await claimRows(PN.id)
  eq('partial claim (1.5 of 3): target round(31.00 x 150/300) = 15.50 split on weights 100:50 -> 10.33 / 5.17', am(0), [[U(3), 10.33], [U(4), 5.17]])
  eq('fully claimed thirds follow the whole new total 10.01: lowest ids take the extra penny', am(1), [[U(3), 3.34], [U(4), 3.34], [U(21), 3.33]])
  eq('untouched lines (legacy 0.33 x 3, unchanged total) are byte-identical', JSON.stringify(PN._cl.filter(r => r.l === PN.lines[2] || r.l === PN.lines[3])), legacyBefore)
  // shared_by_all kept on an unchanged line, reset on a changed one
  const SB = await mkExpense({ payer: 2, amount: 30, desc: 'Table item', tagged: [2, 3, 4], lines: [['bread', 1, 9], ['rest', 1, 21]] })
  await SET(2, SB.id, [{ line_item_id: SB.lines[0], shared_by_all: true }, { line_item_id: SB.lines[1], shared_by_all: true }])
  await REIT(2, SB.id, {}, [LN(SB.lines[0], 'bread', 1, 9, 9.3), LN(SB.lines[1], 'rest!', 1, 21, 21)])
  eq('unchanged line keeps shared_by_all (its claims were re-split on the new total); the changed line is reset and cleared', (await qa(`select name_original n, shared_by_all s, (select count(*)::int from expense_item_claims c where c.line_item_id=li.id) c, (select sum(amount_owed)::float from expense_item_claims c where c.line_item_id=li.id) a from expense_line_items li where expense_id=$1 order by line_number`, [SB.id])).map(r => [r.n, r.s, r.c, r.a]), [['bread', true, 3, 9.3], ['rest!', false, 0, null]])
  // currency change: nothing is unchanged
  const CC = await mkExpense({ payer: 2, amount: 20, desc: 'Currency change', tagged: [2, 3], lines: [['a', 1, 20]] })
  await assign(CC, { 0: 3 })
  const cc = await REIT(2, CC.id, { currency: 'GBP' }, [LN(CC.lines[0], 'a', 1, 20, 20)])
  eq('changing the currency clears every claim', [cc.r.j.cleared_claims, cc.r.j.kept_claims, (await claimRows(CC.id)).length], [1, 0, 0])
}

// ---- 11b. FUZZ reitemize_expense -----------------------------------------------------------------------------------------------------------
{
  const CASES = +(process.env.FUZZ_REIT ?? 400)
  const rng = (a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 })(+(process.env.FUZZ_SEED ?? 77))
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
  const hit = { exactFull: 0, exactPartial: 0, same: 0, cleared: 0, leftoversCleared: 0 }
  const bad = { exact: 0, survive: 0, amount: 0, preview: 0, written: 0, legacy: 0, order: 0, counts: 0, threw: 0, noerr: 0 }
  let shown = 0
  const note = (k, c, x) => { bad[k]++; if (shown++ < 6) console.log('REIT BAD', k, 'case', c, JSON.stringify(x).slice(0, 700)) }
  const evenSplit = (tot, k) => Array.from({ length: k }, (_, i) => Math.floor(tot / k) + (i < tot - Math.floor(tot / k) * k ? 1 : 0))
  for (let c = 0; c < CASES; c++) {
    const cur = rng() < 0.75 ? 'EUR' : 'JPY', pw = cur === 'JPY' ? 1 : 100
    const people = [2, 3, 4, 21, 22]
    const n = ri(1, 6)
    const tot = Array.from({ length: n }, () => ri(1, 4) === 1 ? ri(1, 9) : ri(100, 9000) * (pw === 1 ? 1 : 1))   // minor units
    const qty = Array.from({ length: n }, () => rng() < 0.7 ? 1 : ri(2, 4))
    const ex = (await db.query(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,$4,'fz','unallocated',true,$5) returning id`, [T, U(2), tot.reduce((a, b) => a + b, 0) / pw, cur, people.map(U)])).rows[0].id
    const lid = []
    for (let i = 0; i < n; i++) lid.push((await db.query(`insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,$2,$3,$4,$5,$6,$6) returning id`, [ex, i + 1, 'item' + i, qty[i], tot[i] / pw / qty[i], tot[i] / pw])).rows[0].id)
    const legacyLines = new Set()
    for (let i = 0; i < n; i++) {
      const k = rng()
      const ins = (u, q, a) => db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [lid[i], U(u), ex, q, a / pw])
      if (k < 0.2) continue
      if (k < 0.55) { const kk = ri(1, 3); const a = evenSplit(tot[i], kk), q = evenSplit(qty[i] * 100, kk); for (let u = 0; u < kk; u++) await ins(people[u], q[u] / 100, a[u]) }
      else if (k < 0.8 && qty[i] > 1) { await ins(3, 1, Math.round(tot[i] / qty[i])); await ins(4, 0.5, Math.round(tot[i] / qty[i] / 2)) }
      else if (qty[i] === 1) { for (const u of [3, 4, 21]) await ins(u, 0.33, Math.round(tot[i] * 0.33)); legacyLines.add(i) }
      else continue
    }
    if (rng() < 0.4) { await db.query(`update expenses set claims_sent_at=now() where id=$1`, [ex]); for (const u of [3, 4, 21]) if (rng() < 0.6) await db.query(`insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [ex, U(u)]) }
    if (rng() < 0.2) { try { await SHARE(2, ex, 'everyone') } catch {} }
    // the edit
    const plan = [], newLines = []
    const order = [...Array(n).keys()].sort(() => rng() - 0.5)
    for (const i of order) {
      const a = rng()
      if (a < 0.15) { plan.push({ i, kind: 'removed' }); continue }
      if (a < 0.4) { const t2 = Math.max(0, tot[i] + ri(-3, 400)); plan.push({ i, kind: 'totchg', t2 }); newLines.push({ i, ...LN(lid[i], 'item' + i, qty[i], tot[i] / pw, t2 / pw) }); continue }
      if (a < 0.6) { plan.push({ i, kind: 'changed' }); newLines.push({ i, ...LN(lid[i], 'item' + i + ' changed', qty[i], tot[i] / pw, tot[i] / pw) }); continue }
      plan.push({ i, kind: 'same' }); newLines.push({ i, ...LN(lid[i], 'item' + i, qty[i], tot[i] / pw, tot[i] / pw) })
    }
    const adds = ri(0, 2)
    for (let a2 = 0; a2 < adds; a2++) newLines.splice(ri(0, newLines.length), 0, { i: -1, ...LN(null, 'new' + a2, 1, 5, 5) })
    if (newLines.length === 0) newLines.push({ i: -1, ...LN(null, 'only', 1, 5, 5) })
    const body = newLines.map(({ i, ...rest }) => rest)
    const claimsBefore = await qa(`select id::text, line_item_id::text l, user_id::text u, quantity_claimed::float q, amount_owed::float a, leftover_quantity::float lq from expense_item_claims where expense_id=$1 order by id`, [ex])
    const snapBefore = await dumpExp(ex)
    const pv = await REIT(2, ex, {}, body, true)
    const snapAfterPv = await dumpExp(ex)
    if (pv.e) { bad.threw++; console.log('REIT THREW(preview)', c, pv.e.message); await db.query(`delete from expenses where id=$1`, [ex]); continue }
    if (snapAfterPv !== snapBefore) note('written', c, 'preview changed something')
    const rl = await REIT(2, ex, {}, body)
    if (rl.e) { bad.threw++; console.log('REIT THREW', c, rl.e.message); await db.query(`delete from expenses where id=$1`, [ex]); continue }
    const nrm = j => JSON.stringify({ ...j, preview: undefined, line_ids: j.line_ids.map((x, k) => body[k].id ? x : 'new') })
    if (nrm(pv.r.j) !== nrm(rl.r.j)) note('preview', c, { pv: pv.r.j, rl: rl.r.j })
    // invariants
    const lines = await qa(`select id::text, line_number n, total_amount::float t, quantity::float q from expense_line_items where expense_id=$1 order by line_number`, [ex])
    const claims = await qa(`select id::text, line_item_id::text l, user_id::text u, quantity_claimed::float q, amount_owed::float a, leftover_quantity::float lq, leftover_amount::float la from expense_item_claims where expense_id=$1 order by id`, [ex])
    if (lines.map(l => l.n).join() !== lines.map((_, k) => k + 1).join() || rl.r.j.line_ids.join() !== lines.map(l => l.id).join()) note('order', c, { lines, ids: rl.r.j.line_ids })
    const amt = (await q1(`select amount::float a from expenses where id=$1`, [ex])).a
    if (Math.round(amt * pw) !== Math.round(lines.reduce((s, l) => s + Math.round(l.t * pw), 0))) note('amount', c, { amt, lines })
    const changedIds = new Set(plan.filter(p => p.kind === 'changed' || p.kind === 'removed').map(p => lid[p.i]))
    for (const cl of claims) if (changedIds.has(cl.l)) note('survive', c, cl)
    for (const p of plan.filter(p => p.kind === 'totchg')) {
      const rows = claims.filter(x => x.l === lid[p.i])
      if (!rows.length) continue
      const sq = rows.reduce((s, x) => s + Math.round(x.q * 100), 0), Q = qty[p.i] * 100
      const sum = rows.reduce((s, x) => s + Math.round(x.a * pw), 0)
      if (sq >= Q - 1) { hit.exactFull++; if (sum !== p.t2) note('exact', c, { p, rows, sum, sq, Q }) }
      else if ((hit.exactPartial++, Math.abs(sum - Math.round(p.t2 * sq / Q)) > 0)) note('exact', c, { p, rows, sum, sq, Q })
    }
    for (const p of plan.filter(p => p.kind === 'same')) {
      const b0 = JSON.stringify(claimsBefore.filter(x => x.l === lid[p.i]).map(x => [x.id, x.q, x.a])), b1 = JSON.stringify(claims.filter(x => x.l === lid[p.i]).map(x => [x.id, x.q, x.a]))
      hit.same++
      if (b0 !== b1 && !(rl.r.j.leftovers_cleared)) note('legacy', c, { b0, b1 })
    }
    hit.cleared += rl.r.j.cleared_claims; if (rl.r.j.leftovers_cleared) hit.leftoversCleared++
    const ownRows = claims.filter(x => x.q - x.lq > 0).length
    if (ownRows !== rl.r.j.kept_claims) note('counts', c, { ownRows, j: rl.r.j })
    await db.query(`delete from expenses where id=$1`, [ex])
  }
  console.log(JSON.stringify({ cases: CASES, ...bad, hit }))
  ok('reitemise fuzz: fully claimed lines sum to the new total exactly (penny rule)', bad.exact === 0)
  ok('reitemise fuzz: no claim survives on a changed or removed line', bad.survive === 0)
  ok('reitemise fuzz: amount == sum of line totals; numbering and line_ids follow p_lines', bad.amount === 0 && bad.order === 0)
  ok('reitemise fuzz: preview result == real result and preview writes nothing', bad.preview === 0 && bad.written === 0)
  ok('reitemise fuzz: untouched lines (incl. legacy 0.33 rows) are identical; kept_claims counts the surviving own rows', bad.legacy === 0 && bad.counts === 0)
  ok('reitemise fuzz: nothing threw', bad.threw === 0)
}

// ======================================================================================================================================
// 12. leftover rule on a receipt that was never sent: parity with the PHASE-1 definition
// ======================================================================================================================================
{
  const mig1 = fs.readFileSync(MIG1, 'utf8')
  const a = mig1.indexOf('CREATE OR REPLACE FUNCTION public.share_receipt_leftovers(')
  const end = mig1.indexOf('$$;', mig1.indexOf('AS $$', a) + 5) + 3
  let p1 = mig1.slice(a, end).replace('public.share_receipt_leftovers(', 'public.p1_share_receipt_leftovers(').replace('public._receipt_leftover_confirmed(p_expense_id)', 'public._receipt_tagged(p_expense_id)')
  ok('the phase-1 definition was extracted and its "confirmed" is everyone tagged', p1.includes('_receipt_tagged(p_expense_id)') && p1.includes('p1_share_receipt_leftovers'))
  await db.exec(p1)
  const rng = (a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 })(5150)
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
  let diffs = 0, ran = 0
  const build = async spec => {
    const ex = (await db.query(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,'EUR','par','unallocated',true,$4) returning id`, [T, U(2), spec.total / 100, spec.people.map(U)])).rows[0].id
    const ids = []
    for (let i = 0; i < spec.lines.length; i++) ids.push((await db.query(`insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,$2,'l',1,$3,$3,$3) returning id`, [ex, i + 1, spec.lines[i] / 100])).rows[0].id)
    for (const [i, u, amt] of spec.claims) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,$4)`, [ids[i], U(u), ex, amt / 100])
    return ex
  }
  const dump = async ex => ({ rows: (await qa(`select li.line_number n, c.user_id::text u, c.quantity_claimed::float q, c.amount_owed::float a, c.source s, c.leftover_quantity::float lq, c.leftover_amount::float la from expense_item_claims c join expense_line_items li on li.id=c.line_item_id where c.expense_id=$1 order by 1,2`, [ex])), st: (await q1(`select status::text s, leftover_mode m from expenses where id=$1`, [ex])) })
  for (let c = 0; c < 160; c++) {
    const people = [2, 3, 4, 21, 22, 23].slice(0, ri(2, 6))
    const lines = Array.from({ length: ri(1, 6) }, () => ri(1, 5) === 1 ? ri(1, 9) : ri(100, 5000))
    const claims = []
    lines.forEach((t, i) => { const k = rng(); if (k < 0.4) return; const u = people[ri(0, people.length - 1)]; claims.push([i, u, k < 0.8 ? t : Math.max(1, Math.floor(t * rng()))]) })
    const spec = { total: lines.reduce((a, b) => a + b, 0), people, lines, claims }
    const e1 = await build(spec), e2 = await build(spec)
    const mode = ['everyone', 'default', 'everyone'][c % 3]
    const r1 = await call(2, `select p1_share_receipt_leftovers($1,$2) j`, [e1, mode])
    const r2 = await call(2, `select share_receipt_leftovers($1,$2) j`, [e2, mode])
    ran++
    const pick = r => r.e ? 'ERR ' + r.e.message : JSON.stringify({ ...r.r.j, expense_id: undefined, lines: r.r.j.lines.map(l => ({ ...l, line_item_id: undefined })) })
    if (pick(r1) !== pick(r2) || JSON.stringify(await dump(e1)) !== JSON.stringify(await dump(e2))) { diffs++; if (diffs < 4) console.log('PARITY DIFF', c, JSON.stringify(spec), pick(r1).slice(0, 300), pick(r2).slice(0, 300)) }
  }
  ok(`never-sent receipts: share_receipt_leftovers is identical to the phase-1 definition (${ran} random receipts: results, claim rows, status)`, diffs === 0 && ran === 160)
  // and the same receipt once SENT with nobody answering is NOT the same (the rule moved on)
  const NS = await mkExpense({ payer: 2, amount: 30, desc: 'parity contrast', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 1, 4], ['rest', 1, 16]] })
  await assign(NS, { 0: 2, 1: 3 })
  eq('never sent: plain equal split of the 16.00 (5.34 / 5.33 / 5.33)', (await SHARE(2, NS.id, 'everyone', null, true)).r.j.people.map(p => p.amount), [5.34, 5.33, 5.33])
  await db.query(`update expenses set claims_sent_at=now() where id=$1`, [NS.id])
  eq('sent, nobody answered: water-filling (Bob +6, Carol +10)', (await SHARE(2, NS.id, 'everyone', null, true)).r.j.people.map(p => [p.user_id, p.amount]), [[U(3), 6], [U(4), 10]])
}

// ======================================================================================================================================
// 13. unfreeze_settlements (the repo's own settlement guards/triggers/CHECKs are applied in the prelude)
// ======================================================================================================================================
{
  const UT = '10000000-0000-0000-0000-0000000000a1'
  await db.query(`insert into trips(id,created_by) values ($1,$2)`, [UT, U(11)])
  for (const [u, r] of [[1, 'organizer'], [2, 'participant'], [3, 'participant']]) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [UT, U(u), r])
  const mkS = async (status, trip = UT, amount = 5) => (await call(1, `insert into settlements(trip_id,from_user_id,to_user_id,amount,settled_at,created_by,status,currency) values ($1,$2,$3,$4,now(),$5,$6,'GBP') returning id`, [trip, U(2), U(3), amount, U(1), status])).r.id
  const s1 = await mkS('suggested'), s2 = await mkS('suggested', UT, 6), m1 = await mkS('marked_paid', UT, 9), c1 = await mkS('confirmed', UT, 10), r1 = await mkS('marked_paid', UT, 11)
  await call(1, `update settlements set status='suggested' where id=$1`, [r1])                     // a RETRACTED payment (last_retracted_at is stamped by the live guard)
  const other = await mkS('suggested', T, 12)
  ok('the live settlement guard stamped the retraction', (await q1(`select last_retracted_at is not null r from settlements where id=$1`, [r1])).r)
  await db.query(`insert into payment_confirm_tokens(settlement_id,receiver_id,token_hash,amount,currency) values ($1,$2,$3,9,'GBP')`, [m1, U(3), sha()])
  // not frozen: the old no-op (nothing deleted)
  const nf = await call(1, `select unfreeze_settlements($1) j`, [UT])
  eq('NOT frozen: nothing is deleted (suggested rows stay)', [nf.r.j.unfrozen, nf.r.j.deleted_suggested, (await qa(`select id from settlements where trip_id=$1`, [UT])).length], [true, 0, 5])
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [UT])
  await fails('unfreeze: a non-manager', 3, `select unfreeze_settlements($1)`, [UT], { code: '42501' })
  await fails('unfreeze: no JWT', null, `select unfreeze_settlements($1)`, [UT], { code: '42501' })
  await fails('unfreeze: unknown trip', 1, `select unfreeze_settlements($1)`, ['99999999-0000-0000-0000-000000000000'], { code: 'P0002' })
  eq('refusals changed nothing', [(await qa(`select id from settlements where trip_id=$1`, [UT])).length, (await q1(`select settlement_snapshot is not null f from trips where id=$1`, [UT])).f], [5, true])
  const un = await call(1, `select unfreeze_settlements($1) j`, [UT])
  ok('organiser unfreezes (as authenticated, with the live settlement guards and RLS)', !un.e, un.e?.message)
  eq('result is a superset of the live one; every suggested row incl. the retracted one is gone', [un.r.j.unfrozen, un.r.j.deleted_suggested], [true, 3])
  eq('marked_paid (with its live link) and confirmed stay', (await qa(`select id::text from settlements where trip_id=$1 order by amount`, [UT])).map(r => r.id), [m1, c1])
  eq('another trip is untouched', (await qa(`select id::text from settlements where id=$1`, [other])).length, 1)
  eq('snapshot cleared, who/when stamped, activity row with the count', [(await q1(`select settlement_snapshot is null n, settlement_snapshot_by::text b from trips where id=$1`, [UT])), (await q1(`select metadata->>'deleted_suggested' d from activity_feed where verb='unfroze_settlement' and trip_id=$1 order by created_at desc limit 1`, [UT])).d], [{ n: true, b: U(1) }, '3'])
  const again = await call(1, `select unfreeze_settlements($1) j`, [UT])
  eq('idempotent: a second unfreeze deletes nothing more', again.r.j.deleted_suggested, 0)
  const pr = await q1(`select has_function_privilege('anon','unfreeze_settlements(uuid)','EXECUTE') a, has_function_privilege('authenticated','unfreeze_settlements(uuid)','EXECUTE') u, (select prosecdef from pg_proc where proname='unfreeze_settlements') d, (select proconfig::text from pg_proc where proname='unfreeze_settlements') c`)
  eq('live signature, grants and security attributes kept', pr, { a: false, u: true, d: true, c: '{"search_path=public, pg_temp"}' })
}
