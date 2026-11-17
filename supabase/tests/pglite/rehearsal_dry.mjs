// Generated-suite header: assembled with the other parts by run.mjs into ONE module (the checks share their variables).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, M, U, T, T2, bootstrapBase, oldFreezeSrc } from '../lib/base.mjs'
import { openDb } from '../lib/openDb.mjs'

const MIG1 = M + '20261124090000_receipt_claims_v2.sql'
const MIG2 = M + '20261126090000_receipt_deadline_tokens.sql'
const MIG3 = M + '20261128090000_freeze_enforcement.sql'
const MIG4 = M + '20261128100000_own_claims_rpc.sql'
const db = await openDb()
let pass = 0, fail = 0
const ok = (label, cond, extra) => { if (cond) { pass++ } else { fail++; console.log('FAIL', label, extra !== undefined ? JSON.stringify(extra) : '') } }
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b })
const jsMd5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex')
const extractBody = b => b.slice(b.indexOf('AS $$') + 5, b.lastIndexOf('$$;'))
// u: a number = that signed-in person; null = no JWT at all; 'svc' = the service role (no sub); 'anon'
const jwt = async u => {
  const sub = typeof u === 'number' ? U(u) : ''
  const role = typeof u === 'number' ? 'authenticated' : u === 'svc' ? 'service_role' : u === 'anon' ? 'anon' : ''
  await db.query(`select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','',false), set_config('request.jwt.claims',$2,false)`, [sub, role ? JSON.stringify(sub ? { sub, role } : { role }) : ''])
}
// "Clients" are real: a number runs the statement as the non-superuser role `authenticated` (RLS applies, current_user is authenticated, so every client-only guard runs);
// 'anon' as anon; 'svc' as service_role (BYPASSRLS, like Supabase); null = no JWT, as the table owner (superuser) for fixtures and "no user" calls.
const as = async (u, sql, params) => {
  await jwt(u)
  const role = typeof u === 'number' ? 'authenticated' : u === 'anon' ? 'anon' : u === 'svc' ? 'service_role' : null
  if (!role) return db.query(sql, params)
  await db.exec(`SET ROLE ${role}`)
  try { return await db.query(sql, params) } finally { await db.exec('RESET ROLE') }
}
const call = async (u, sql, params) => { try { return { r: (await as(u, sql, params)).rows[0] } } catch (e) { return { e } } }
const fails = async (label, u, sql, params, want = {}) => {
  const x = await call(u, sql, params)
  if (!x.e) { ok(label + ' (should have failed)', false, x.r); return }
  if (want.hint) eq(label + ' hint', x.e.hint, want.hint)
  if (want.msg) ok(label + ' msg', x.e.message.includes(want.msg), x.e.message)
  if (want.code) eq(label + ' code', x.e.code, want.code)
  if (!want.hint && !want.msg && !want.code) pass++
}
const exec = (u, sql, params) => as(u, sql, params)
const SET = (u, eid, claims) => call(u, `select set_receipt_claims($1,$2::jsonb) j`, [eid, JSON.stringify(claims)])
const SHARE = (u, eid, mode, who = null, prev = false) => call(u, `select share_receipt_leftovers($1,$2,$3,$4) j`, [eid, mode, who, prev])
await bootstrapBase(db)
{
  const oldFreeze = oldFreezeSrc()
  const fsrc = s => { const a = s.indexOf('CREATE OR REPLACE FUNCTION public.freeze_settlements('); const u = s.indexOf('CREATE OR REPLACE FUNCTION public.unfreeze_settlements('); return s.slice(a, u >= 0 ? u : s.indexOf('$$;', s.indexOf('AS $$', a) + 5) + 3).trimEnd() }
  const cur = (await db.query(`select md5(prosrc) m from pg_proc where proname='freeze_settlements'`)).rows[0]
  eq('old freeze md5: file text == pg prosrc', jsMd5(extractBody(fsrc(oldFreeze))), cur.m)
}

// ---- fixtures -------------------------------------------------------------------------------------------------------
const mkExpense = async ({ trip = T, payer = 2, amount, currency = 'EUR', desc, itemised = true, status = 'unallocated', tagged = null, lines = [] }) => {
  const id = (await db.query(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [trip, U(payer), amount, currency, desc, status, itemised, tagged ? tagged.map(U) : null])).rows[0].id
  const ids = []
  let n = 0
  for (const [name, qty, total] of lines) {
    ids.push((await db.query(`insert into expense_line_items(expense_id,name_original,quantity,unit_price,subtotal,total_amount,line_number) values ($1,$2,$3,$4,$5,$5,$6) returning id`, [id, name, qty, total / qty, total, ++n])).rows[0].id)
  }
  return { id, lines: ids }
}
const claimRows = async eid => (await db.query(`select line_item_id l, user_id::text u, quantity_claimed::float q, amount_owed::float a, source s, created_by::text cb, leftover_quantity::float lq, leftover_amount::float la from expense_item_claims where expense_id=$1 order by line_item_id, user_id, source`, [eid])).rows
const statusOf = async eid => (await db.query(`select status::text s from expenses where id=$1`, [eid])).rows[0].s
const lineSums = async eid => (await db.query(`select li.line_number n, li.total_amount::float t, li.quantity::float qty, coalesce(sum(c.amount_owed),0)::float a, coalesce(sum(c.quantity_claimed),0)::float q from expense_line_items li left join expense_item_claims c on c.line_item_id=li.id where li.expense_id=$1 group by li.id order by li.line_number`, [eid])).rows
const near = (a, b) => Math.abs(a - b) < 1e-9
const cents = x => Math.round(x * 100)

await db.exec(fs.readFileSync(MIG1, 'utf8'))
if (process.env.REH_FILE && !process.env.REH_FILE.startsWith('20261124') && !process.env.REH_FILE.startsWith('20261126')) await db.exec(fs.readFileSync(MIG2, 'utf8'))
if (process.env.REH_FILE && process.env.REH_FILE.startsWith('20261129')) { await db.exec(fs.readFileSync(M + '20261128090000_freeze_enforcement.sql', 'utf8')); await db.exec(fs.readFileSync(M + '20261128100000_own_claims_rpc.sql', 'utf8')) }   // chat rehearsal starts from the LIVE phase-4 state   // phase-4 rehearsals start from the LIVE phase-2 state     // LIVE since 2026-11-17
const TT = 'be551bc4-a524-4b6a-a0c9-b74a7168ced4'
await db.query(`insert into trips(id,name,created_by,base_currency) values ($1,'TEST payment email - delete me',$2,'GBP')`, [TT, U(1)])
await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'organizer',true),($1,$3,'participant',true)`, [TT, U(1), U(2)])
if (process.env.FROZEN) await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [TT])
await db.query(`insert into notifications(trip_id,user_id,kind,dedupe_key) values ($1,$2,'action_due_7d','existing:1')`, [TT, U(1)])
const snap = async () => JSON.stringify([
  (await db.query(`select (select count(*) from expenses) e, (select count(*) from expense_line_items) li, (select count(*) from expense_item_claims) c, (select count(*) from activity_feed) a, (select count(*) from notifications) n, (select settlement_snapshot is not null from trips where id='${TT}') frozen`)).rows[0],
  (await db.query(`select count(*)::int n, md5(string_agg(proname||pg_get_function_identity_arguments(oid)||md5(prosrc), ',' order by proname, oid::text)) m from pg_proc where pronamespace='public'::regnamespace`)).rows[0],
  (await db.query(`select string_agg(table_name||'.'||column_name, ',' order by table_name, column_name) c from information_schema.columns where table_schema='public'`)).rows[0],
  (await db.query(`select string_agg(tgname, ',' order by tgname) t from pg_trigger where not tgisinternal`)).rows[0],
  (await db.query(`select string_agg(conname, ',' order by conname) c from pg_constraint where connamespace='public'::regnamespace`)).rows[0],
  (await db.query(`select string_agg(relname, ',' order by relname) t from pg_class where relnamespace='public'::regnamespace`)).rows[0],
  (await db.query(`select count(*)::int n from pg_policies`)).rows[0],
  (await db.query(`select to_regclass('pg_temp._rehearsal') is null as no_temp`)).rows[0],
])
const snapBefore = await snap()
const script = fs.readFileSync(process.env.REH ?? path.join(ROOT, 'supabase/rehearsal/' + (process.env.REH_FILE ?? '20261126090000_receipt_deadline_rehearsal.sql')), 'utf8')
let msg = null
try { await db.exec(script) } catch (e) { msg = e.message }
try { await db.exec('ROLLBACK') } catch {}
console.log('MESSAGE LENGTH', msg?.length)
console.log(msg)
ok('ends in a REHEARSAL error', !!msg && msg.startsWith('REHEARSAL'))
ok('reports PASS', !!msg && msg.startsWith('REHEARSAL PASS'))
ok('message under ~6,200 chars', !!msg && msg.length < 6300, msg?.length)
const snapAfter = await snap()
ok('nothing left behind (rows, functions, columns, tables, triggers, constraints, policies, frozen flag)', snapBefore === snapAfter, snapBefore === snapAfter ? '' : { snapBefore, snapAfter })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
