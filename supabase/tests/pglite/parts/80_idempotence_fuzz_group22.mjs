
// ---- 8. apply the migration a SECOND time: nothing changes ---------------------------------------------------------------------------------
{
  const snapFn = async () => (await qa(`select proname, pg_get_function_identity_arguments(oid) a, md5(prosrc) m, prosecdef s, proconfig::text c, proacl::text acl from pg_proc where pronamespace='public'::regnamespace order by 1,2`))
  const snapPol = async () => (await qa(`select tablename, policyname, cmd, roles::text r, qual, with_check from pg_policies where schemaname='public' order by 1,2`))
  const snapMisc = async () => ({
    trg: (await qa(`select tgrelid::regclass::text t, tgname from pg_trigger where not tgisinternal order by 1,2`)),
    con: (await qa(`select conrelid::regclass::text t, conname from pg_constraint where connamespace='public'::regnamespace order by 1,2`)),
    col: (await qa(`select table_name, column_name, column_default, is_nullable from information_schema.columns where table_schema='public' order by 1,2`)),
    idx: (await qa(`select indexname from pg_indexes where schemaname='public' order by 1`)),
    tacl: (await qa(`select relname, relacl::text a, relrowsecurity r from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`)),
  })
  const a = [await snapFn(), await snapPol(), await snapMisc()]
  await applyFile(MIG2, 'MIG2 (second apply)')
  const b = [await snapFn(), await snapPol(), await snapMisc()]
  eq('second apply: functions identical (bodies, security, search_path, ACLs)', b[0], a[0])
  eq('second apply: policies identical', b[1], a[1])
  eq('second apply: triggers, constraints, columns, indexes, table ACLs identical', JSON.stringify(b[2]), JSON.stringify(a[2]))
  eq('the phase-1 functions replaced besides _receipt_begin (documented) are the two rule functions',
    JSON.stringify((await qa(`select proname, md5(prosrc) m from pg_proc where pronamespace='public'::regnamespace and proname in ('_receipt_tagged','_receipt_leftover_confirmed') order by 1`)).map(r => [r.proname, r.m !== phase1Md5[r.proname]])), JSON.stringify([['_receipt_leftover_confirmed', true], ['_receipt_tagged', true]]))
  // the replaced _receipt_tagged differs from phase 1 only by the added WHERE (the union text is verbatim)
  const mig1 = fs.readFileSync(MIG1, 'utf8'), mig2 = fs.readFileSync(MIG2, 'utf8')
  const unionOf = t => t.slice(t.indexOf('  FROM (', t.indexOf('CREATE OR REPLACE FUNCTION public._receipt_tagged')) + 8, t.indexOf('  ) s', t.indexOf('CREATE OR REPLACE FUNCTION public._receipt_tagged')))
  const norm = t => t.split('\n').map(l => l.trim()).filter(l => !/cli\.|^-- PHASE 2|^-- \(the payer removing/.test(l)).join('\n').trim()
  eq('the union of "who is on the receipt" is the phase-1 text verbatim (indentation aside; the one added JOIN on table items removed)', norm(unionOf(mig2)), norm(unionOf(mig1)))
  {
    const body = (src, name) => { const a = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '('); const o = src.indexOf('AS $$', a) + 5; return src.slice(o, src.indexOf('$$;', o)) }
    const b2 = body(mig2, '_receipt_begin')
    const stripped = b2.replace(/  -- PHASE 2 \(the only change[\s\S]*?HINT = 'claims_closed';\n  END IF;\n/, '')
    eq('_receipt_begin = the phase-1 body plus exactly the closed-receipt block (removing it gives the phase-1 text back)', jsMd5(stripped), jsMd5(body(mig1, '_receipt_begin')))
    ok('... and the block is really there', b2.length > stripped.length)
  }
  // freeze_settlements is not touched by phase 2
  eq('freeze_settlements is not redefined in phase 2', mig2.includes('FUNCTION public.freeze_settlements('), false)
  // the live status trigger and phase-1 triggers still all there
  eq('triggers on claims unchanged', (await qa(`select tgname from pg_trigger where tgrelid='expense_item_claims'::regclass and not tgisinternal order by 1`)).map(r => r.tgname), ['trg_clear_done_on_claim_change', 'trg_guard_claim_closed', 'trg_guard_claim_overclaim', 'trg_guard_claim_provenance', 'trigger_auto_update_expense_status'])
  eq('triggers on expenses', (await qa(`select tgname from pg_trigger where tgrelid='expenses'::regclass and not tgisinternal order by 1`)).map(r => r.tgname), ['set_updated_at', 'trg_guard_expense_claim_state', 'trg_guard_expense_leftover_mode', 'trigger_guard_immutable_keys'])
  ok('still works after the second apply', (await SEND(2, (await mkExpense({ payer: 2, amount: 10, desc: 'After 2nd apply', tagged: [2, 3], lines: [['x', 1, 10]] })).id)).r.j.first_send === true)
}

// ---- 9. FUZZ: _receipt_leftover_plan with a random CONFIRMED set + the public path -------------------------------------------------------
{
  const CASES = +(process.env.FUZZ_CASES ?? 2400), PUB = +(process.env.FUZZ_PUBLIC ?? 250)
  const seed0 = +(process.env.FUZZ_SEED ?? 20261126)
  const rng = (a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 })(seed0)
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
  const bad = { sum: 0, neg: 0, capped: 0, confirmedEarly: 0, spill: 0, level: 0, threw: 0, line: 0, personSum: 0 }
  let examples = 0
  const note = (k, c, x) => { bad[k]++; if (examples++ < 6) console.log('BAD', k, 'case', c, JSON.stringify(x)) }
  for (let c = 0; c < CASES + PUB; c++) {
    const n = ri(2, 8)
    const people = Array.from({ length: n }, (_, i) => 100 + i)
    const nLines = ri(1, 9)
    const totals = Array.from({ length: nLines }, () => { const k = rng(); return k < 0.15 ? ri(1, 9) : k < 0.4 ? ri(100, 900) : ri(100, 6000) })   // minor units
    const amount = totals.reduce((a, b) => a + b, 0)
    const ex = (await db.query(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,'GBP','fuzz','unallocated',true,$4) returning id`, [T, U(people[0]), amount / 100, people.map(U)])).rows[0].id
    const lids = []
    for (let i = 0; i < nLines; i++) lids.push((await db.query(`insert into expense_line_items(expense_id,name_original,quantity,unit_price,subtotal,total_amount,line_number) values ($1,'l',1,$2,$2,$2,$3) returning id`, [ex, totals[i] / 100, i + 1])).rows[0].id)
    // random claims: each line is unclaimed, partly or fully claimed by ONE person (a partial claim keeps the line's quantity open)
    const claimed = new Map(people.map(p => [p, 0]))
    let L = 0
    for (let i = 0; i < nLines; i++) {
      const k = rng()
      if (k < 0.35) { L += totals[i]; continue }
      const who = people[ri(0, n - 1)]
      const frac = k < 0.75 ? 1 : rng()
      const amt = Math.max(1, Math.floor(totals[i] * frac))
      const qty = amt === totals[i] ? 1 : Math.max(0.01, Math.round(amt / totals[i] * 100) / 100)
      await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [lids[i], U(who), ex, qty, amt / 100])
      claimed.set(who, claimed.get(who) + amt)
      L += totals[i] - amt
    }
    // random confirmed subset (any size, including empty and everyone)
    const pc = rng()
    const confirmed = people.filter(() => rng() < (pc < 0.15 ? 0 : pc > 0.85 ? 1 : pc))
    if (!confirmed.includes(people[0])) confirmed.push(people[0])   // a SENT receipt: the payer counts as confirmed
    const F = Math.floor(amount / n)
    const room = new Map(people.map(p => [p, Math.max(0, F - claimed.get(p))]))
    const unconf = people.filter(p => !confirmed.includes(p))
    let rows
    try { rows = (await db.query(`select user_id::text u, amount_minor::int a from _receipt_leftover_plan($1,$2::uuid[])`, [ex, confirmed.map(U)])).rows } catch (e) { bad.threw++; console.log('THREW', c, e.message); await db.query(`delete from expenses where id=$1`, [ex]); continue }
    const alloc = new Map(people.map(p => [p, 0])); for (const r of rows) alloc.set(+r.u.slice(-12), r.a)
    const ctx = { n, amount, F, L, claimed: [...claimed], confirmed, alloc: [...alloc] }
    if ([...alloc.values()].reduce((a, b) => a + b, 0) !== L) note('sum', c, ctx)
    if ([...alloc.values()].some(v => v < 0)) note('neg', c, ctx)
    const sumRoom = unconf.reduce((s, p) => s + room.get(p), 0)
    if (L <= sumRoom) {
      // everything stays inside U, nobody above their room, confirmed people get nothing
      for (const p of people) { if (confirmed.includes(p) && alloc.get(p) > 0) note('confirmedEarly', c, ctx); if (!confirmed.includes(p) && alloc.get(p) > room.get(p)) note('capped', c, ctx) }
      // water-filling: the uncapped people sit within one penny of each other, and every capped person's room is not above that level
      const unc = unconf.filter(p => alloc.get(p) < room.get(p))
      if (unc.length) {
        const hi = Math.max(...unc.map(p => alloc.get(p))), lo = Math.min(...unc.map(p => alloc.get(p)))
        if (hi - lo > 1) note('level', c, ctx)
        if (unconf.some(p => alloc.get(p) >= room.get(p) && room.get(p) > hi + 1)) note('level', c, ctx)
      }
    } else {
      // every unconfirmed person is at their cap, the excess is shared by everyone on the receipt within one penny
      const excess = L - sumRoom
      for (const p of unconf) if (alloc.get(p) < room.get(p)) note('spill', c, ctx)
      const shares = people.map(p => alloc.get(p) - (confirmed.includes(p) ? 0 : room.get(p)))
      if (shares.some(s => s < 0) || Math.max(...shares) - Math.min(...shares) > 1 || shares.reduce((a, b) => a + b, 0) !== excess) note('spill', c, ctx)
      // confirmed people only receive when every unconfirmed person is at the cap: true by construction in this branch
    }
    // the PUBLIC path on a subset: record the responses, share through share_receipt_leftovers, every line exact
    if (c >= CASES) {
      await db.query(`update expenses set claims_sent_at=now() where id=$1`, [ex])
      for (const p of confirmed) await db.query(`insert into expense_claim_responses(expense_id,user_id,response) values ($1,$2,'done')`, [ex, U(p)])
      const r = await SHARE(people[0], ex, 'everyone')
      if (r.e) { bad.threw++; console.log('PUBLIC THREW', c, r.e.message, JSON.stringify(ctx)) }
      else {
        // phase 1 may merge a penny-sized remainder into the person's row on ANOTHER line (see "DUST" in 20261124090000): lines can be off in opposite directions, the RECEIPT is exact (minus what stays with the payer's pending bucket)
        const rt = (await q1(`select (e.amount - coalesce((select sum(amount_owed) from expense_item_claims where expense_id=e.id),0))::float d from expenses e where e.id=$1`, [ex])).d
        const kept = r.r.j.kept_by_payer
        if (Math.abs(rt - kept) > 0.0051) note('line', c, { ...ctx, rt, kept })
        // the payer never receives leftovers while a non-responder still has room (explicit payer mode is not used here)
        const nonresp = people.slice(1).filter(p => !confirmed.includes(p)), sumRoomNR = nonresp.reduce((s, p) => s + room.get(p), 0)
        const payerLeft = (await q1(`select coalesce(sum(leftover_amount),0)::float a from expense_item_claims where expense_id=$1 and user_id=$2`, [ex, U(people[0])])).a
        if (nonresp.length && L <= sumRoomNR && payerLeft > 0.005) note('personSum', c, { ...ctx, payerLeft, nonresp })
        const per = new Map((await qa(`select user_id::text u, sum(leftover_amount)::float a from expense_item_claims where expense_id=$1 group by 1`, [ex])).map(r => [r.u, r.a]))
        for (const p of r.r.j.people) if (Math.abs((per.get(p.user_id) ?? 0) - p.amount) > 0.0051) note('personSum', c, { ...ctx, p, got: per.get(p.user_id) })
      }
    }
    await db.query(`delete from expenses where id=$1`, [ex])
  }
  console.log(JSON.stringify({ cases: CASES, public: PUB, ...bad }))
  ok('fuzz: plan sums to the unclaimed value exactly', bad.sum === 0)
  ok('fuzz: no negative allocation', bad.neg === 0)
  ok('fuzz: nobody unconfirmed is pushed above the even share while another unconfirmed person is below it (caps hold until step 2)', bad.capped === 0 && bad.spill === 0 && bad.level === 0)
  ok('fuzz: confirmed people receive only when every unconfirmed person is at the cap', bad.confirmedEarly === 0 && bad.spill === 0)
  ok('fuzz: public path never throws, lines stay exact, per-person leftovers = the plan', bad.threw === 0 && bad.line === 0 && bad.personSum === 0)
}

// ---- 10. PRE_APPLY group 22 runs (every statement parses and executes on the post-apply stubs) -------------------------------------------
{
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const g22 = pre.slice(pre.indexOf('-- 22. Migration 20261126090000'), pre.indexOf('-- 23. Migration 20261128090000'))
  // statements that read tables the stubs do not have are skipped (auth.users etc. are not used in group 22; pg_stat_activity is fine)
  try { await db.exec(g22); pass++ } catch (e) { fail++; console.log('FAIL group 22 does not run:', e.message) }
  const mat = (await qa(`select p.proname, md5(p.prosrc) = case p.proname when '_receipt_tagged' then '3fb9669b56045306d97fae8ad1394f5b' when '_receipt_leftover_confirmed' then 'a09c7c73162dbe9a106fd8485b29bd28' when '_receipt_leftover_plan' then '78d56ee682298fc639463112cd4bdf3e' when '_receipt_begin' then '71b9ad95120b15ad653bc59c2c15f587' when '_receipt_lines' then '38cec07fd2f82d6c9a4e31e8c41b8c14' when '_receipt_even_split' then 'bafa1641b301fce2022de718d2d68d68' when 'set_receipt_claims' then '6e7e9da9f8581b4929a2558475330282' when 'share_receipt_leftovers' then '52a35443baae3f7f5df46a9a0ae171bf' end m, length(p.prosrc) l from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('_receipt_tagged','_receipt_leftover_confirmed','_receipt_leftover_plan','_receipt_begin','_receipt_lines','_receipt_even_split','set_receipt_claims','share_receipt_leftovers') order by 1`))
  eq('22c: after phase 2 only the three replaced functions differ from the shipped phase-1 text', mat.map(r => [r.proname, r.m]), [['_receipt_begin', false], ['_receipt_even_split', true], ['_receipt_leftover_confirmed', false], ['_receipt_leftover_plan', true], ['_receipt_lines', true], ['_receipt_tagged', false], ['set_receipt_claims', true], ['share_receipt_leftovers', true]])
  eq('22c: the lengths written in the comment match the shipped bodies', mat.filter(r => r.m).map(r => [r.proname, r.l]), [['_receipt_even_split', 400], ['_receipt_leftover_plan', 3438], ['_receipt_lines', 958], ['set_receipt_claims', 11048], ['share_receipt_leftovers', 9408]])
  eq('22c: phase-1 md5s captured from the pglite apply equal the ones in the file', [phase1Md5._receipt_tagged, phase1Md5._receipt_leftover_confirmed], ['3fb9669b56045306d97fae8ad1394f5b', 'a09c7c73162dbe9a106fd8485b29bd28'])
  eq('22l: no payer not_there / own-claim not_there rows after all the tests', [(await qa(`select 1 from expense_claim_responses r join expenses e on e.id=r.expense_id where r.response='not_there' and e.paid_by=r.user_id`)).length], [0])
  const un = await q1(`select md5(prosrc) m from pg_proc where proname='unfreeze_settlements'`)
  const oldU = (t => { const a = t.indexOf('CREATE OR REPLACE FUNCTION public.unfreeze_settlements('); const o = t.indexOf('AS $$', a) + 5; return t.slice(o, t.indexOf('$$;', o)) })(fs.readFileSync(M + '20261118100000_settlement_freeze.sql', 'utf8'))
  eq('22q: the repo-text md5 in PRE_APPLY equals the body that pglite had before phase 2 (old unfreeze), and the new body differs', [jsMd5(oldU), un.m !== jsMd5(oldU)], ['1ec90283bba01dfbbb4b4a7bd26df64b', true])
  eq('22d: triggers on expenses after apply', (await qa(`select tgname from pg_trigger where tgrelid='expenses'::regclass and not tgisinternal order by 1`)).length, 4)
}

