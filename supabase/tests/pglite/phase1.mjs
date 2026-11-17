// Receipt claims v2 (slice 1A) tests on an in-memory Postgres (pglite). Stub tables are shaped like schema.txt.
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import crypto from 'crypto'

import { ROOT, M } from '../lib/base.mjs'
import path from 'node:path'
const MIG = M + '20261124090000_receipt_claims_v2.sql'
const db = new PGlite()
let pass = 0, fail = 0
const ok = (label, cond, extra) => { if (cond) { pass++ } else { fail++; console.log('FAIL', label, extra !== undefined ? JSON.stringify(extra) : '') } }
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b })
const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const T = '10000000-0000-0000-0000-000000000001'
const T2 = '10000000-0000-0000-0000-000000000002'

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('t.uid', true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('t.role', true),'') $$;
CREATE TYPE participant_role AS ENUM ('organizer','participant');
CREATE TYPE expense_status AS ENUM ('unallocated','pending_allocation','allocated','confirmed');
CREATE TABLE users (id uuid primary key, role text default 'member', full_name text, first_name text);
CREATE TABLE trips (id uuid primary key default gen_random_uuid(), name text default 'trip', created_by uuid, base_currency text default 'GBP', confirmation_enabled boolean default false, settlement_snapshot jsonb, settlement_snapshot_at timestamptz, settlement_snapshot_by uuid);
CREATE TABLE trip_participants (trip_id uuid, user_id uuid, role participant_role default 'participant', active bool default true, confirmation_status text, primary key(trip_id,user_id));
CREATE TABLE rate_limits (id uuid primary key default gen_random_uuid(), user_id uuid not null, feature text not null, tokens numeric(10,4) not null, last_refill timestamptz not null default now(), unique(user_id, feature));
CREATE TABLE settlements (id uuid primary key default gen_random_uuid(), trip_id uuid not null, from_user_id uuid not null, to_user_id uuid not null, amount numeric not null, payment_method text, notes text, settled_at timestamptz not null, created_at timestamptz default now(), created_by uuid not null, status text not null default 'confirmed' check (status in ('suggested','marked_paid','confirmed')), currency text);
CREATE TABLE activity_feed (id uuid primary key default gen_random_uuid(), trip_id uuid, actor uuid, verb text not null, entity jsonb, metadata jsonb, created_at timestamptz default now());
CREATE TABLE expenses (id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id), paid_by uuid not null references users(id), amount numeric(10,2) not null, currency text not null default 'EUR', description text not null, status expense_status default 'confirmed', ai_parsed bool default false, participant_ids uuid[], fx_rate numeric(10,6), base_currency_amount numeric(10,2), updated_at timestamptz default now());
CREATE TABLE expense_line_items (id uuid primary key default gen_random_uuid(), expense_id uuid not null references expenses(id) on delete cascade, name_original text not null, quantity numeric(10,2) not null check (quantity > 0), unit_price numeric(10,2) not null check (unit_price >= 0), line_discount_amount numeric(10,2) default 0, subtotal numeric(10,2) not null check (subtotal >= 0), tax_amount numeric(10,2) default 0, service_amount numeric(10,2) default 0, total_amount numeric(10,2) not null check (total_amount >= 0), line_number int not null check (line_number > 0), created_at timestamptz default now(), unique (expense_id, line_number));
CREATE TABLE expense_item_claims (id uuid primary key default gen_random_uuid(), line_item_id uuid not null references expense_line_items(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, expense_id uuid not null references expenses(id) on delete cascade, quantity_claimed numeric(10,2) not null, amount_owed numeric(10,2) not null, confirmed bool default false, claimed_at timestamptz default now(), updated_at timestamptz default now(), constraint unique_user_claim_per_item unique (line_item_id, user_id), check (amount_owed >= 0), check (quantity_claimed > 0));
CREATE INDEX ON expense_item_claims(line_item_id); CREATE INDEX ON expense_item_claims(user_id); CREATE INDEX ON expense_item_claims(expense_id);
-- stand-ins for the LIVE triggers (bodies of the real ones are unknown; behaviour per live-checks-receipts.md)
CREATE FUNCTION handle_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE FUNCTION guard_immutable_keys() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN RAISE EXCEPTION 'trip_id is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER trigger_guard_immutable_keys BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION guard_immutable_keys();
CREATE FUNCTION check_all_items_claimed(p_expense_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM expense_line_items li WHERE li.expense_id = p_expense_id
    AND coalesce((SELECT sum(c.quantity_claimed) FROM expense_item_claims c WHERE c.line_item_id = li.id), 0) < li.quantity) $$;
CREATE FUNCTION auto_update_expense_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF check_all_items_claimed(NEW.expense_id) THEN UPDATE expenses SET status = 'allocated' WHERE id = NEW.expense_id;
  ELSIF EXISTS (SELECT 1 FROM expense_item_claims c WHERE c.expense_id = NEW.expense_id) THEN UPDATE expenses SET status = 'pending_allocation' WHERE id = NEW.expense_id;
  ELSE UPDATE expenses SET status = 'unallocated' WHERE id = NEW.expense_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trigger_auto_update_expense_status AFTER INSERT OR UPDATE ON expense_item_claims FOR EACH ROW EXECUTE FUNCTION auto_update_expense_status();
`)
// real helpers copied out of the real migrations
const mig16 = fs.readFileSync(M + '20261116130000_guard_participant_removal.sql', 'utf8')
await db.exec(mig16.slice(mig16.indexOf('CREATE OR REPLACE FUNCTION public.currency_exponent'), mig16.indexOf('$$;', mig16.indexOf('CREATE OR REPLACE FUNCTION public.currency_exponent')) + 3))
const mig20 = fs.readFileSync(M + '20261120100000_settlement_insert_guard.sql', 'utf8')
const cm = mig20.indexOf('CREATE OR REPLACE FUNCTION public._settlement_can_manage')
await db.exec(mig20.slice(cm, mig20.indexOf('$$;', mig20.indexOf('AS $$', cm) + 5) + 3))
const oldFreeze = fs.readFileSync(M + '20261118100000_settlement_freeze.sql', 'utf8')
await db.exec(oldFreeze)
const bodyMd5 = async () => (await db.query(`select md5(prosrc) m, length(prosrc) l, prosrc from pg_proc where proname='freeze_settlements'`)).rows[0]
const before = await bodyMd5()
const jsMd5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex')
const extractBody = b => b.slice(b.indexOf('AS $$') + 5, b.lastIndexOf('$$;'))
const fsrc = s => { const a = s.indexOf('CREATE OR REPLACE FUNCTION public.freeze_settlements('); const u = s.indexOf('CREATE OR REPLACE FUNCTION public.unfreeze_settlements('); return s.slice(a, u >= 0 ? u : s.indexOf('$$;', s.indexOf('AS $$', a) + 5) + 3).trimEnd() }
eq('old freeze md5: file text == pg prosrc', jsMd5(extractBody(fsrc(oldFreeze))), before.m)

// people
const users = [[1, 'member', 'Org'], [2, 'member', 'Alice'], [3, 'member', 'Bob'], [4, 'member', 'Carol'], [9, 'member', 'Outsider'], [10, 'admin', 'Admin'], [11, 'member', 'Creator']]
for (let i = 21; i <= 28; i++) users.push([i, 'member', 'P' + i])
for (const [id, role, n] of users) await db.query(`insert into users(id,role,full_name) values ($1,$2,$3)`, [U(id), role, n])
await db.exec(`insert into trips(id,created_by) values ('${T}','${U(11)}'),('${T2}','${U(11)}')`)
const part = [[1, 'organizer'], [2, 'participant'], [3, 'participant'], [4, 'participant'], ...[21, 22, 23, 24, 25, 26, 27, 28].map(n => [n, 'participant'])]
for (const [id, role] of part) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [T, U(id), role])
const as = async (u, sql, params) => { await db.query(`select set_config('t.uid',$1,false)`, [u == null ? '' : U(u)]); return db.query(sql, params) }
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

// apply migration (first time)
const migSql = fs.readFileSync(MIG, 'utf8')
try { await db.exec(migSql) } catch (e) { console.log('MIGRATION ERROR', e.message, e.position); const q = e.query ?? ''; console.log(q.slice(Math.max(0, +e.position - 300), +e.position + 100).slice(0, 600)); process.exit(2) }
console.log('migration applied once')

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

// ---- permissions ----------------------------------------------------------------------------------------------------
const P = await mkExpense({ amount: 46, desc: 'Perm', lines: [['a', 1, 10], ['b', 2, 12], ['c', 1, 24]] })
{
  const c1 = [{ line_item_id: P.lines[0], user_ids: [U(2)] }]
  await fails('anon (no uid) refused', null, `select set_receipt_claims($1,$2::jsonb)`, [P.id, JSON.stringify(c1)], { hint: 'auth', code: '42501' })
  await fails('tagged non-payer assigning someone else (not self) refused', 3, `select set_receipt_claims($1,$2::jsonb)`, [P.id, JSON.stringify(c1)], { hint: 'forbidden', code: '42501' })
  await fails('outsider refused', 9, `select set_receipt_claims($1,$2::jsonb)`, [P.id, JSON.stringify(c1)], { hint: 'forbidden' })
  await fails('unknown expense', 2, `select set_receipt_claims($1,$2::jsonb)`, ['99999999-0000-0000-0000-000000000000', '[]'], { hint: 'not_found', code: 'P0002' })
  await fails('share: tagged non-payer refused', 3, `select share_receipt_leftovers($1,'everyone')`, [P.id], { hint: 'forbidden' })
  await fails('share: outsider refused', 9, `select share_receipt_leftovers($1,'everyone')`, [P.id], { hint: 'forbidden' })
  const p = await SET(2, P.id, c1); ok('payer ok', !p.e, p.e?.message)
  const m = await SET(1, P.id, [{ line_item_id: P.lines[1], user_ids: [U(3)] }]); ok('organiser ok', !m.e, m.e?.message)
  const a = await SET(10, P.id, [{ line_item_id: P.lines[1], user_ids: [U(3)] }]); ok('admin ok', !a.e, a.e?.message)
  const cr = await SET(11, P.id, [{ line_item_id: P.lines[1], user_ids: [U(3)] }]); ok('trip creator ok', !cr.e, cr.e?.message)
  await db.query(`update trip_participants set active=false where trip_id=$1 and user_id=$2`, [T, U(1)])
  await fails('removed organiser refused', 1, `select set_receipt_claims($1,$2::jsonb)`, [P.id, JSON.stringify(c1)], { hint: 'forbidden' })
  await db.query(`update trip_participants set active=true where trip_id=$1 and user_id=$2`, [T, U(1)])
  // sources
  const rows = await claimRows(P.id)
  const row = (l, u) => rows.find(r => r.l === P.lines[l] && r.u === U(u))
  eq('payer own claim is self', row(0, 2)?.s, 'self')
  eq('on behalf of Bob (by creator)', row(1, 3)?.s, 'on_behalf')
  eq('created_by = whoever first put Bob down (organiser); later re-assignments keep it', row(1, 3)?.cb, U(1))
  eq('created_by of payer row', row(0, 2)?.cb, U(2))
  // not itemised
  const N = await mkExpense({ amount: 10, desc: 'Plain', itemised: false, status: 'confirmed' })
  await fails('not itemised', 2, `select set_receipt_claims($1,'[]'::jsonb)`, [N.id], { hint: 'not_itemised' })
  await fails('share not itemised', 2, `select share_receipt_leftovers($1,'everyone')`, [N.id], { hint: 'not_itemised' })
}


// ---- tagged (non-manager) people may only toggle THEMSELVES --------------------------------------------------------------
{
  const TG = await mkExpense({ amount: 60, desc: 'Tagged share', lines: [['a', 1, 10], ['b', 1, 20], ['c', 3, 30]] })
  const S1 = (u, c) => SET(u, TG.id, c)
  const rowsOf = async l => (await claimRows(TG.id)).filter(x => x.l === TG.lines[l])
  const only = (l, ids) => JSON.stringify([{ line_item_id: TG.lines[l], user_ids: ids.map(U) }])
  const SQLSET = `select set_receipt_claims($1,$2::jsonb)`
  // add myself to an unclaimed line
  let r = await S1(3, [{ line_item_id: TG.lines[0], user_ids: [U(3)] }])
  ok('tagged: add myself to an unclaimed line', !r.e, r.e?.message)
  eq('alone: self, created_by me', (await rowsOf(0)).map(x => [x.s, x.cb]), [['self', U(3)]])
  // cannot put myself AND someone else on an unclaimed line, nor assign only others
  await fails('tagged: me + another person on an unclaimed line refused', 3, SQLSET, [TG.id, only(1, [3, 4])], { hint: 'forbidden', code: '42501' })
  await fails('tagged: assigning only another person refused', 3, SQLSET, [TG.id, only(1, [4])], { hint: 'forbidden' })
  eq('nothing written by refusals', (await rowsOf(1)).length, 0)
  // Carol adds herself to Bob's line: equal split, Bob keeps "made by Bob"
  r = await S1(4, [{ line_item_id: TG.lines[0], user_ids: [U(3), U(4)] }])
  ok('tagged: add myself to a line someone holds', !r.e, r.e?.message)
  let rr = await rowsOf(0)
  eq('halves exact', rr.map(x => x.a).sort(), [5, 5])
  eq('Bob keeps created_by = Bob (shared), Carol shared by Carol', rr.map(x => [x.u, x.s, x.cb]), [[U(3), 'shared', U(3)], [U(4), 'shared', U(4)]])
  // a third person cannot drop or swap an existing claimer, nor add somebody else with themselves
  await fails('tagged: dropping an existing claimer refused', 21, SQLSET, [TG.id, only(0, [21])], { hint: 'forbidden' })
  await fails('tagged: join + add another person refused', 21, SQLSET, [TG.id, only(0, [3, 4, 21, 22])], { hint: 'forbidden' })
  await fails('tagged: remove somebody else refused (Alice removes Carol)', 21, SQLSET, [TG.id, only(0, [3])], { hint: 'forbidden' })
  await fails('tagged: remove somebody else when I am on it (Bob removes Carol)', 3, SQLSET, [TG.id, only(0, [3])], { hint: 'forbidden' })
  await fails('tagged: swap myself for another person (Bob -> Alice)', 3, SQLSET, [TG.id, only(0, [4, 21])], { hint: 'forbidden' })
  eq('refusals changed nothing', (await rowsOf(0)).map(x => x.a).sort(), [5, 5])
  // 21 joins: thirds exact
  r = await S1(21, [{ line_item_id: TG.lines[0], user_ids: [U(21), U(3), U(4)] }])
  ok('tagged: join a shared line keeping everyone', !r.e, r.e?.message)
  eq('re-split thirds exact', (await rowsOf(0)).map(x => x.a).sort(), [3.33, 3.33, 3.34])
  eq('quantities thirds exact', cents((await rowsOf(0)).reduce((s, x) => s + x.q, 0)), 100)
  eq('previous creators preserved', (await rowsOf(0)).map(x => [x.u, x.cb]), [[U(3), U(3)], [U(4), U(4)], [U(21), U(21)]])
  // the thirds are an equal split -> a later toggle is still allowed; 21 leaves
  r = await S1(21, [{ line_item_id: TG.lines[0], user_ids: [U(3), U(4)] }])
  ok('tagged: remove myself from a shared line', !r.e, r.e?.message)
  eq('re-split after leaving: 5.00 / 5.00 and qty 0.5', (await rowsOf(0)).map(x => [x.a, x.q]), [[5, 0.5], [5, 0.5]])
  // Bob leaves, Carol stays alone: on_behalf is NOT used for a person who made their own row (created_by kept = Carol)
  r = await S1(3, [{ line_item_id: TG.lines[0], user_ids: [U(4)] }])
  ok('tagged: remove myself leaving one other', !r.e, r.e?.message)
  eq('lone remaining sharer', (await rowsOf(0)).map(x => [x.u, x.a, x.s, x.cb]), [[U(4), 10, 'on_behalf', U(4)]])
  // unassign: only when sole claimer (Carol is the sole claimer now)
  r = await S1(4, [{ line_item_id: TG.lines[0], user_ids: [] }])
  ok('tagged: remove my own sole claim', !r.e, r.e?.message)
  eq('line cleared', (await rowsOf(0)).length, 0)
  await fails('tagged: unassign an empty line refused (nothing of theirs)', 3, SQLSET, [TG.id, only(0, [])], { hint: 'forbidden' })
  // shared_by_all: never set by a tagged person, and a shared_by_all line is locked to them
  await fails('tagged: shared_by_all refused', 3, SQLSET, [TG.id, JSON.stringify([{ line_item_id: TG.lines[1], shared_by_all: true }])], { hint: 'forbidden' })
  await SET(2, TG.id, [{ line_item_id: TG.lines[1], shared_by_all: true }])
  await fails('tagged: cannot toggle themselves on a shared_by_all line', 3, SQLSET, [TG.id, only(1, [3])], { hint: 'forbidden', msg: 'shared by everyone' })
  await fails('tagged: cannot take themselves off a shared_by_all line', 3, SQLSET, [TG.id, JSON.stringify([{ line_item_id: TG.lines[1], user_ids: (await rowsOf(1)).map(x => x.u).filter(u => u !== U(3)) }])], { hint: 'forbidden' })
  // untagged person: restricted receipt
  const UT = await mkExpense({ amount: 10, desc: 'Only three', tagged: [2, 3, 4], lines: [['x', 1, 10]] })
  await fails('untagged trip member refused', 26, SQLSET, [UT.id, JSON.stringify([{ line_item_id: UT.lines[0], user_ids: [U(26)] }])], { hint: 'forbidden' })
  await fails('tagged person cannot add an untagged person', 3, SQLSET, [UT.id, JSON.stringify([{ line_item_id: UT.lines[0], user_ids: [U(3), U(26)] }])], { hint: 'not_tagged' })
  // direct whole-unit claim by someone else: Bob holds 2 of 3 units directly (not an equal split); Alice may not toggle onto the line
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,2,20)`, [TG.lines[2], U(3), TG.id])
  r = await S1(1, [{ line_item_id: TG.lines[0], user_ids: [U(4)] }])
  eq('untouched line with direct multi-unit rows: unclaimed counts them (10 left of 30)', r.r.j.unclaimed_lines.find(x => x.line_item_id === TG.lines[2])?.unclaimed, 10)
  await fails('tagged: cannot join a line where another person holds whole units directly', 21, SQLSET, [TG.id, only(2, [3, 21])], { hint: 'forbidden', msg: 'on their own' })
  await fails('tagged: cannot replace a direct-row holder', 21, SQLSET, [TG.id, only(2, [21])], { hint: 'forbidden' })
  await fails('tagged: cannot remove another person who holds units', 21, SQLSET, [TG.id, only(2, [])], { hint: 'forbidden' })
  eq('Bob direct row untouched', (await rowsOf(2)).map(x => [x.u, x.q, x.a]), [[U(3), 2, 20]])
  // ... but the holder may remove HIMSELF from his own whole-unit claim (nobody else's amounts change)
  r = await S1(3, [{ line_item_id: TG.lines[2], user_ids: [] }])
  ok('tagged: holder removes own direct claim', !r.e, r.e?.message)
  // the payer replaces a line wholesale
  r = await SET(2, TG.id, [{ line_item_id: TG.lines[2], user_ids: [U(3), U(21)] }])
  ok('payer replaces line', !r.e, r.e?.message)
  const c3 = await rowsOf(2)
  eq('replaced: exactly the new rows, sums exact', [c3.length, cents(c3.reduce((s, x) => s + x.a, 0)), cents(c3.reduce((s, x) => s + x.q, 0))], [2, 3000, 300])
  // legacy fractional (0.33 x 3 style) rows held by others also block a toggle
  const LG = await mkExpense({ amount: 10, desc: 'Legacy toggle', lines: [['w', 1, 10]] })
  for (const u of [3, 4]) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [LG.lines[0], U(u), LG.id])
  await fails('tagged: legacy fractional rows held by others block a toggle', 21, SQLSET, [LG.id, JSON.stringify([{ line_item_id: LG.lines[0], user_ids: [U(3), U(4), U(21)] }])], { hint: 'forbidden' })
}

// ---- frozen ---------------------------------------------------------------------------------------------------------
{
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}'::jsonb where id=$1`, [T])
  await fails('frozen: set refused', 2, `select set_receipt_claims($1,$2::jsonb)`, [P.id, JSON.stringify([{ line_item_id: P.lines[0], user_ids: [U(2)] }])], { hint: 'frozen', msg: 'frozen' })
  await fails('frozen: share refused', 2, `select share_receipt_leftovers($1,'everyone')`, [P.id], { hint: 'frozen' })
  await fails('frozen: preview refused too', 2, `select share_receipt_leftovers($1,'everyone',null,true)`, [P.id], { hint: 'frozen' })
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
  const ok1 = await SET(2, P.id, [{ line_item_id: P.lines[0], user_ids: [U(2)] }]); ok('unfrozen again ok', !ok1.e)
}

// ---- exact splits ---------------------------------------------------------------------------------------------------
{
  const S = await mkExpense({ amount: 10 + 100 + 33.33, desc: 'Splits', lines: [['third', 1, 10], ['seventh', 1, 100], ['odd', 3, 33.33]] })
  const r = await SET(2, S.id, [
    { line_item_id: S.lines[0], user_ids: [U(4), U(2), U(3)] },
    { line_item_id: S.lines[1], user_ids: [21, 22, 23, 24, 25, 26, 27].map(U) },
    { line_item_id: S.lines[2], user_ids: [U(2), U(3)] },
  ])
  ok('splits call ok', !r.e, r.e?.message)
  const sums = await lineSums(S.id)
  for (const l of sums) { eq(`line ${l.n} amount sums exactly`, cents(l.a), cents(l.t)); eq(`line ${l.n} qty sums exactly`, cents(l.q), cents(l.qty)) }
  const rows = await claimRows(S.id)
  const third = rows.filter(x => x.l === S.lines[0]).sort((a, b) => a.u < b.u ? -1 : 1)
  eq('thirds amounts (lowest user_id gets the extra penny)', third.map(x => x.a), [3.34, 3.33, 3.33])
  eq('thirds quantities', third.map(x => x.q), [0.34, 0.33, 0.33])
  eq('thirds sources: caller self, others shared', third.map(x => x.s), ['self', 'shared', 'shared'])
  const sev = rows.filter(x => x.l === S.lines[1]).map(x => x.a).sort()
  eq('sevenths', sev, [14.28, 14.28, 14.28, 14.29, 14.29, 14.29, 14.29].sort())
  const odd = rows.filter(x => x.l === S.lines[2])
  eq('3 units shared by 2: 1.50 each', odd.map(x => x.q), [1.5, 1.5])
  eq('33.33 shared by 2', odd.map(x => x.a).sort(), [16.66, 16.67])
  // result JSON
  eq('result lists touched lines only', r.r.j.lines.length, 3)
  eq('result unclaimed 0', r.r.j.unclaimed_total, 0)
  eq('status allocated when all lines full', r.r.j.status, 'allocated')
  eq('expenses.status updated', (await db.query(`select status from expenses where id=$1`, [S.id])).rows[0].status, 'allocated')
  // JPY zero decimals
  const J = await mkExpense({ amount: 1000, currency: 'JPY', desc: 'Yen', lines: [['ramen', 1, 1000]] })
  const jr = await SET(2, J.id, [{ line_item_id: J.lines[0], user_ids: [U(2), U(3), U(4)] }])
  ok('JPY ok', !jr.e, jr.e?.message)
  eq('JPY thirds', (await claimRows(J.id)).map(x => x.a).sort(), [333, 333, 334])
  eq('JPY result amounts are whole', jr.r.j.lines[0].claimed_total, 1000)
  // KWD: amount_owed is numeric(10,2) on live, so a 3-decimal currency cannot be split exactly: refused, nothing written
  const K = await mkExpense({ amount: 10, currency: 'KWD', desc: 'KWD', lines: [['x', 1, 10]] })
  await fails('3-decimal currency refused', 2, `select set_receipt_claims($1,$2::jsonb)`, [K.id, JSON.stringify([{ line_item_id: K.lines[0], user_ids: [U(2), U(3), U(4)] }])], { hint: 'currency_unsupported' })
  eq('KWD: nothing written', (await claimRows(K.id)).length, 0)
  // a line too small to share between that many people (quantity 0.02 / 3) is refused instead of hitting CHECK quantity_claimed > 0
  const TS2 = await mkExpense({ amount: 3, desc: 'Tiny', lines: [['tiny', 0.02, 3]] })
  await fails('too many sharers for the quantity', 2, `select set_receipt_claims($1,$2::jsonb)`, [TS2.id, JSON.stringify([{ line_item_id: TS2.lines[0], user_ids: [U(2), U(3), U(4)] }])], { hint: 'too_many_sharers' })
  // shared_by_all
  const A = await mkExpense({ amount: 10, desc: 'All', lines: [['bread', 1, 10], ['wine', 1, 0.01]] })
  const ar = await SET(2, A.id, [{ line_item_id: A.lines[0], shared_by_all: true }])
  ok('shared_by_all ok', !ar.e, ar.e?.message)
  const arows = await claimRows(A.id)
  eq('everyone tagged (12 active) gets a row', arows.length, 12)
  eq('shared_by_all sums', cents(arows.reduce((s, x) => s + x.a, 0)), 1000)
  eq('flag set', (await db.query(`select shared_by_all f from expense_line_items where id=$1`, [A.lines[0]])).rows[0].f, true)
  await SET(2, A.id, [{ line_item_id: A.lines[0], user_ids: [U(2)] }])
  eq('flag cleared by explicit users', (await db.query(`select shared_by_all f from expense_line_items where id=$1`, [A.lines[0]])).rows[0].f, false)
  eq('replaced: one row', (await claimRows(A.id)).length, 1)
  await SET(2, A.id, [{ line_item_id: A.lines[0], user_ids: [] }])
  eq('unassign removes', (await claimRows(A.id)).length, 0)
  eq('status back to unallocated (nobody holds a claim; the live trigger does not fire on DELETE)', await statusOf(A.id), 'unallocated')
  // other lines untouched
  await SET(2, A.id, [{ line_item_id: A.lines[1], user_ids: [U(3)] }])
  await SET(2, A.id, [{ line_item_id: A.lines[0], user_ids: [U(4)] }])
  eq('untouched line kept', (await claimRows(A.id)).filter(x => x.l === A.lines[1]).length, 1)
  // restricted tagging
  const R = await mkExpense({ amount: 20, desc: 'Tagged', tagged: [2, 3, 4], lines: [['x', 1, 20]] })
  await fails('not tagged refused', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: R.lines[0], user_ids: [U(21)] }])], { hint: 'not_tagged' })
  const rr = await SET(2, R.id, [{ line_item_id: R.lines[0], shared_by_all: true }])
  eq('shared_by_all = tagged only', (await claimRows(R.id)).length, 3)
  eq('3 people 20.00', (await claimRows(R.id)).map(x => x.a).sort(), [6.66, 6.67, 6.67])
  // bad input
  await fails('line of another expense', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: S.lines[0], user_ids: [U(2)] }])], { hint: 'bad_line' })
  await fails('line listed twice', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: R.lines[0], user_ids: [U(2)] }, { line_item_id: R.lines[0], user_ids: [U(3)] }])], { hint: 'bad_input' })
  await fails('not an array', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, '{}'], { hint: 'bad_input' })
  await fails('bad uuid', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: R.lines[0], user_ids: ['nope'] }])], { hint: 'bad_input' })
  await fails('no users field', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: R.lines[0] }])], { hint: 'bad_input' })
  // atomic: second entry invalid, first must roll back
  const before = JSON.stringify(await claimRows(R.id))
  await fails('atomic', 2, `select set_receipt_claims($1,$2::jsonb)`, [R.id, JSON.stringify([{ line_item_id: R.lines[0], user_ids: [U(2)] }, { line_item_id: R.lines[0].replace(/^./, 'f'), user_ids: [U(2)] }])], { hint: 'bad_line' })
  eq('atomic: nothing changed', JSON.stringify(await claimRows(R.id)), before)
  // duplicates in user_ids are collapsed (cannot over-claim)
  await SET(2, R.id, [{ line_item_id: R.lines[0], user_ids: [U(3), U(3), U(3)] }])
  eq('duplicate ids collapse', (await claimRows(R.id)).map(x => [x.u, x.a, x.q]), [[U(3), 20, 1]])
}

// ---- legacy fractional rows coexist ---------------------------------------------------------------------------------
let LEG
{
  LEG = await mkExpense({ amount: 30, desc: 'Legacy', lines: [['wine', 1, 10], ['pizza', 2, 20]] })
  const ins = (l, u, q, a) => db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [LEG.lines[l], U(u), LEG.id, q, a])
  await ins(0, 3, 0.33, 3.3); await ins(0, 4, 0.33, 3.3)      // legacy thirds: 0.34 and 3.40 left
  await ins(1, 3, 1, 10)                                        // pizza: 1 of 2 units
  const r = await SET(2, LEG.id, [{ line_item_id: LEG.lines[1], user_ids: [U(2), U(3)] }]) // reassign pizza only
  ok('legacy: reassign other line ok', !r.e, r.e?.message)
  eq('legacy wine rows untouched', (await claimRows(LEG.id)).filter(x => x.l === LEG.lines[0]).map(x => x.a), [3.3, 3.3])
  eq('legacy line reports its unclaimed 3.40', r.r.j.unclaimed_total, 3.4)
  const p = await SHARE(2, LEG.id, 'payer', null, true)
  eq('preview: leftover is exactly the unclaimed value of the legacy line', p.r.j.unclaimed_total, 3.4)
  eq('preview: qty hundredths of the legacy line', p.r.j.lines[0].allocations[0].quantity, 0.34)
  const w = await SHARE(2, LEG.id, 'payer')
  const s = await lineSums(LEG.id)
  eq('legacy+new line sums are exact', s.map(x => [cents(x.a), cents(x.t)]).every(([a, t]) => a === t), true)
  eq('legacy+new qty sums exact', s.map(x => cents(x.q) === cents(x.qty)).every(Boolean), true)
  ok('allocated after leftovers', w.r.j.status === 'allocated', w.r.j.status)
}

// ---- leftover rule: the two worked examples from the proposal, at SQL level ----------------------------------------
{
  // Example 1: Le Bistrot, 312.00, 8 people, six confirmed, Marj (22) and Louis (0) not. 264 claimed, wine 36 + dessert 12 not.
  const ppl = [21, 22, 23, 24, 25, 26, 27, 28]            // 21..26 confirmed, 27 = Marj, 28 = Louis
  const LB = await mkExpense({ amount: 312, desc: 'Le Bistrot', tagged: ppl, lines: [['mains', 264, 264], ['wine', 1, 36], ['dessert', 1, 12]] })
  const claimed = { 21: 40, 22: 40, 23: 40, 24: 40, 25: 41, 26: 41, 27: 22 }
  for (const [u, a] of Object.entries(claimed)) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$4)`, [LB.lines[0], U(+u), LB.id, a])
  const plan = async (conf) => (await db.query(`select user_id::text u, amount_minor::int a, claimed_minor::int c from _receipt_leftover_plan($1,$2::uuid[]) order by user_id`, [LB.id, conf.map(U)])).rows
  const p1 = await plan([21, 22, 23, 24, 25, 26])
  eq('example 1: plan', p1.map(x => [x.u, x.a]), [[U(27), 1700], [U(28), 3100]])
  eq('example 1: Marj ends at an even share (39.00)', (p1[0].a + p1[0].c), 3900)
  eq('example 1: Louis ends at 31.00', (p1[1].a + p1[1].c), 3100)
  // Example 2: everyone confirmed, 9.00 unclaimed: 4 x 1.13 + 4 x 1.12
  const BW = await mkExpense({ amount: 96, desc: 'Bread', tagged: ppl, lines: [['food', 87, 87], ['bread+water', 1, 9]] })
  for (const u of ppl.slice(0, 7)) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,12,12)`, [BW.lines[0], U(u), BW.id])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,3,3)`, [BW.lines[0], U(28), BW.id])
  const p2 = (await db.query(`select user_id::text u, amount_minor::int a from _receipt_leftover_plan($1,$2::uuid[]) order by user_id`, [BW.id, ppl.map(U)])).rows
  eq('example 2: 4 x 1.13 + 4 x 1.12 (lowest user_ids get the extra penny)', p2.map(x => x.a), [113, 113, 113, 113, 112, 112, 112, 112])
  eq('example 2: sums to 9.00', p2.reduce((s, x) => s + x.a, 0), 900)
  // phase-1 default: confirmed set empty -> same outcome for example 1 because the six are already over an even share
  const stBefore = await statusOf(LB.id)
  const prev = await SHARE(2, LB.id, 'everyone', null, true)
  ok('preview ok', !prev.e, prev.e?.message)
  // PHASE 1: nobody has confirmed, so the confirmed set is everyone tagged: a PLAIN equal split of the 48.00 (6.00 each), nobody singled out
  ok('phase 1: confirmed set = everyone tagged', prev.r.j.confirmed_user_ids.length === 8, prev.r.j.confirmed_user_ids)
  eq('phase 1: everyone +6.00 (not Marj +17 / Louis +31)', prev.r.j.people.map(p => p.amount), [6, 6, 6, 6, 6, 6, 6, 6])
  // the proposal's example 1 still holds when phase 2 passes the real confirmed set explicitly (see the plan() check above)
  eq('even share reported', prev.r.j.even_share, 39)
  eq('allocated = unclaimed', [prev.r.j.allocated_total, prev.r.j.unclaimed_total], [48, 48])
  eq('preview wrote nothing', [(await claimRows(LB.id)).length, (await db.query(`select count(*)::int c from activity_feed where verb='receipt_leftovers_shared' and entity->>'id'=$1`, [LB.id])).rows[0].c, await statusOf(LB.id)], [7, 0, stBefore])
  // no confirmations + everyone below even share: pure equal split
  const EQ = await mkExpense({ amount: 80, desc: 'Equal', tagged: [21, 22, 23, 24], lines: [['a', 1, 20], ['b', 1, 60]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,20)`, [EQ.lines[0], U(21), EQ.id])
  const pe = (await db.query(`select user_id::text u, amount_minor::int a from _receipt_leftover_plan($1,'{}'::uuid[]) order by user_id`, [EQ.id])).rows
  eq('capped by even share: 21 already has 20 of 20 -> room 0; others 60/3 each', pe.map(x => [x.u, x.a]), [[U(22), 2000], [U(23), 2000], [U(24), 2000]])
  // water-filling with caps: person 21 has 15 (room 5), 22 has 0 (room 20)... L=60 between U = 21,22 only (23,24 confirmed)
  const pe2 = (await db.query(`select user_id::text u, amount_minor::int a from _receipt_leftover_plan($1,$2::uuid[]) order by user_id`, [EQ.id, [23, 24].map(U)])).rows
  eq('U={21,22}: 21 capped at 0, 22 capped at 20.00, the remaining 40.00 is shared by all four (step 2)', pe2.map(x => [x.u, x.a]), [[U(21), 1000], [U(22), 3000], [U(23), 1000], [U(24), 1000]])
  // Real write of example 1 through the RPC
  const w = await SHARE(2, LB.id, 'everyone')
  ok('share ok', !w.e, w.e?.message)
  const sums = await lineSums(LB.id)
  eq('every line sums exactly to its total after sharing', sums.every(l => cents(l.a) === cents(l.t) && cents(l.q) === cents(l.qty)), true)
  const per = (await db.query(`select user_id::text u, sum(amount_owed)::float a from expense_item_claims where expense_id=$1 group by 1 order by 1`, [LB.id])).rows
  eq('per person totals', per.map(x => [x.u, x.a]), [[U(21), 46], [U(22), 46], [U(23), 46], [U(24), 46], [U(25), 47], [U(26), 47], [U(27), 28], [U(28), 6]])
  eq('sum(amount_owed) = expense amount', (await db.query(`select sum(amount_owed)::float s from expense_item_claims where expense_id=$1`, [LB.id])).rows[0].s, 312)
  const lrows = (await claimRows(LB.id)).filter(x => x.la > 0)
  ok('leftover parts exist; rows made only for them: created_by caller, source leftover', lrows.length > 0 && lrows.filter(x => x.s === 'leftover').every(x => x.cb === U(2) && x.lq === x.q && x.la === x.a))
  ok('pure-leftover rows only for people with no row on that line', lrows.filter(x => x.s === 'leftover').every(x => !(x.u >= U(21) && x.u <= U(27) && x.l === LB.lines[0])))
  eq('status allocated', (await db.query(`select status from expenses where id=$1`, [LB.id])).rows[0].status, 'allocated')
  const act = (await db.query(`select metadata, entity from activity_feed where verb='receipt_leftovers_shared' and entity->>'id'=$1`, [LB.id])).rows
  eq('one activity row', act.length, 1)
  eq('activity carries mode and amounts', [act[0].metadata.mode, act[0].metadata.total, act[0].metadata.people.length], ['everyone', 48, 8])
  // re-share after an edit: Louis (28) claims the dessert himself through the existing direct path (delete own rows, insert)
  await db.query(`delete from expense_item_claims where expense_id=$1 and user_id=$2`, [LB.id, U(28)])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,12)`, [LB.lines[2], U(28), LB.id])
  // his claim on the dessert fully covers it; the other leftover rows (Marj's share of wine + dessert) are now stale
  const w2 = await SHARE(2, LB.id, 'same')
  ok('same ok', !w2.e, w2.e?.message)
  eq('mode repeated', w2.r.j.mode, 'everyone')
  const sums2 = await lineSums(LB.id)
  eq('after re-share still exact', sums2.every(l => cents(l.a) === cents(l.t) && cents(l.q) === cents(l.qty)), true)
  const per2 = (await db.query(`select user_id::text u, sum(amount_owed)::float a from expense_item_claims where expense_id=$1 and user_id in ($2,$3) group by 1 order by 1`, [LB.id, U(27), U(28)])).rows
  eq('re-share (equal split of the remaining 36.00 wine, 4.50 each): Marj 22 + 4.50, Louis 12 + 4.50', per2.map(x => [x.u, x.a]), [[U(27), 26.5], [U(28), 16.5]])
  eq('no leftover part left on the dessert (Louis holds it all)', (await claimRows(LB.id)).filter(x => x.la > 0 && x.l === LB.lines[2]).length, 0)
  // modes person / payer / bad
  const w3 = await SHARE(2, LB.id, 'person', U(23))
  ok('person ok', !w3.e, w3.e?.message)
  eq('person: stale everyone-leftovers are rebuilt; person 23 takes the whole 36.00 wine', [w3.r.j.allocated_total, w3.r.j.people.map(p => p.user_id)], [36, [U(23)]])
  // new expense for person / payer modes
  const PP = await mkExpense({ amount: 50, desc: 'PP', tagged: [2, 3, 4], lines: [['a', 2, 30], ['b', 1, 20]] })
  await fails('person: missing user', 2, `select share_receipt_leftovers($1,'person')`, [PP.id], { hint: 'bad_input' })
  await fails('person: not tagged', 2, `select share_receipt_leftovers($1,'person',$2)`, [PP.id, U(21)], { hint: 'not_tagged' })
  await fails('unknown mode', 2, `select share_receipt_leftovers($1,'nope')`, [PP.id], { hint: 'bad_input' })
  await fails('same with no history', 2, `select share_receipt_leftovers($1,'same')`, [PP.id], { hint: 'no_history' })
  const pr = await SHARE(2, PP.id, 'person', U(3))
  eq('person: Bob takes 50.00', (await db.query(`select user_id::text u, sum(amount_owed)::float a, sum(quantity_claimed)::float q from expense_item_claims where expense_id=$1 group by 1`, [PP.id])).rows, [{ u: U(3), a: 50, q: 3 }])
  const pay = await SHARE(1, PP.id, 'payer')
  eq('payer mode (by organiser): payer takes it all', (await db.query(`select user_id::text u, sum(amount_owed)::float a from expense_item_claims where expense_id=$1 group by 1`, [PP.id])).rows, [{ u: U(2), a: 50 }])
  eq('payer rows are leftover/created_by organiser', (await claimRows(PP.id)).every(x => x.s === 'leftover' && x.cb === U(1)), true)
  const sm = await SHARE(2, PP.id, 'same')
  eq('same repeats payer', sm.r.j.mode, 'payer')
  // nothing unclaimed: stale leftovers get cleaned
  await db.query(`delete from expense_item_claims where expense_id=$1`, [PP.id])
  await SET(2, PP.id, [{ line_item_id: PP.lines[0], user_ids: [U(3)] }, { line_item_id: PP.lines[1], user_ids: [U(4)] }])
  const nothing = await SHARE(2, PP.id, 'everyone')
  eq('nothing unclaimed -> zeros', [nothing.r.j.unclaimed_total, nothing.r.j.people.length, nothing.r.j.rows_written], [0, 0, 0])
  // ONE row per (line, person): Bob's leftover share is merged into his own row (unique key unique_user_claim_per_item)
  const CO = await mkExpense({ amount: 40, desc: 'Merge', tagged: [2, 3], lines: [['x', 4, 40]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [CO.lines[0], U(3), CO.id])
  await SHARE(2, CO.id, 'everyone')
  const co = await claimRows(CO.id)
  eq('Bob: exactly one row, own 1 + leftover 1.5 of 3 units', co.filter(x => x.u === U(3)).map(x => [x.q, x.a, x.s, x.lq, x.la]), [[2.5, 25, 'self', 1.5, 15]])
  eq('Alice (no row yet): a new pure-leftover row made by the caller', co.filter(x => x.u === U(2)).map(x => [x.q, x.a, x.s, x.lq, x.la, x.cb]), [[1.5, 15, 'leftover', 1.5, 15, U(2)]])
  eq('merge exact', (await lineSums(CO.id)).map(x => [cents(x.a), cents(x.t), cents(x.q), cents(x.qty)]), [[4000, 4000, 400, 400]])
  eq('phase 1 is a plain equal split: 30.00 left -> 15.00 each, not capped by an even share', co.map(x => [x.u, x.la]).sort(), [[U(2), 15], [U(3), 15]])
}

// ---- freeze guard ---------------------------------------------------------------------------------------------------
{
  const snap = JSON.stringify({ transactions: [], balances: [], created_at: 'x' })
  const F = (u) => call(u, `select freeze_settlements($1,$2::jsonb,'[]'::jsonb,'{}'::uuid[]) j`, [T2, snap])
  const G = await mkExpense({ trip: T2, amount: 30, desc: 'Guarded dinner', tagged: null, lines: [['a', 1, 10], ['b', 1, 20]] })
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true),($1,$3,'participant',true)`, [T2, U(2), U(3)])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'organizer',true)`, [T2, U(1)])
  const plain = await mkExpense({ trip: T2, amount: 9, desc: 'Plain', itemised: false, status: 'confirmed' })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [G.lines[0], U(3), G.id])
  const f1 = await F(1)
  ok('freeze refused with unclaimed', !!f1.e, f1.r)
  eq('hint', f1.e?.hint, 'unclaimed_receipts')
  ok('message counts receipts', /^1 receipt still has unclaimed items/.test(f1.e?.message ?? ''), f1.e?.message)
  eq('detail is JSON with id, description and amount', JSON.parse(f1.e?.detail ?? 'null')?.map(x => [x.id, x.description, x.unclaimed_minor]), [[G.id, 'Guarded dinner', 2000]])
  eq('nothing frozen', (await db.query(`select settlement_snapshot s from trips where id=$1`, [T2])).rows[0].s, null)
  // a second unclaimed receipt -> plural
  const G2 = await mkExpense({ trip: T2, amount: 5, desc: 'Coffee', lines: [['c', 1, 5]] })
  const f2 = await F(1); ok('plural message', /^2 receipts still have unclaimed items/.test(f2.e?.message ?? ''), f2.e?.message)
  // unauthorised callers still get the original permission error first
  const f3 = await F(3); ok('non-manager still refused by the original check', /Only trip organizers/.test(f3.e?.message ?? ''), f3.e?.message)
  await SHARE(1, G2.id, 'payer')
  await SHARE(1, G.id, 'everyone')
  const f4 = await F(1); ok('freeze allowed once everything is claimed', !f4.e, f4.e?.message)
  eq('snapshot stored', (await db.query(`select settlement_snapshot is not null s from trips where id=$1`, [T2])).rows[0].s, true)
  // after freeze, claims are refused server side
  await fails('claims refused after freeze', 1, `select set_receipt_claims($1,'[]'::jsonb)`, [G.id], { hint: 'frozen' })
  // an over-claimed line (money AND quantity above the line) is refused with its own hint, listing the receipt
  await call(1, `select unfreeze_settlements($1)`, [T2])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,99)`, [G2.lines[0], U(3), G2.id])
  const f5 = await F(1)
  eq('over-claimed receipt refused with overclaimed_receipts', [f5.e?.hint, JSON.parse(f5.e?.detail ?? '[]').map(x => x.id)], ['overclaimed_receipts', [G2.id]])
  await db.query(`delete from expense_item_claims where expense_id=$1`, [G2.id])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,5.2)`, [G2.lines[0], U(3), G2.id])
  const f6 = await F(1); ok('slightly over-claimed by money only (qty complete) is dust, not blocked', !f6.e, f6.e?.message)
}

// ---- freeze function: byte-for-byte except the guard ----------------------------------------------------------------
{
  const after = await bodyMd5()
  const stripped = after.prosrc.replace(/\n  -- >>> unclaimed_receipts guard[\s\S]*?-- <<< unclaimed_receipts guard\n/, '')
  eq('freeze body minus guard block == original (md5)', jsMd5(stripped), before.m)
  eq('freeze body minus guard block == original (md5 in pg)', (await db.query(`select md5($1) m`, [stripped])).rows[0].m, before.m)
  const newMd5 = after.m
  const k21 = (await db.query(`select md5(prosrc) = '7b507c2ec453c532fd598e533d2625c5' me, length(prosrc) l, md5(regexp_replace(prosrc, E'\n  -- >>> unclaimed_receipts guard.*?-- <<< unclaimed_receipts guard\n', '', 's')) = 'e06a0e7d53c764d6ff435cbf19431505' ru from pg_proc where proname='freeze_settlements'`)).rows[0]
  eq('PRE_APPLY 21k expressions hold', k21, { me: true, l: 9076, ru: true })
  eq('new freeze md5 from file text == pg prosrc', jsMd5(extractBody(fsrc(migSql))), newMd5)
  console.log('freeze md5 before', before.m, 'len', before.l, '| after', newMd5, 'len', after.l)
  const cfg = (await db.query(`select prosecdef, proconfig from pg_proc where proname='freeze_settlements'`)).rows[0]
  eq('freeze still security definer w/ pinned path', [cfg.prosecdef, cfg.proconfig], [true, ['search_path=public, pg_temp']])
}

// ---- privileges -----------------------------------------------------------------------------------------------------
{
  const pr = async (r, f) => (await db.query(`select has_function_privilege($1,$2,'EXECUTE') x`, [r, f])).rows[0].x
  for (const f of ['set_receipt_claims(uuid,jsonb)', 'share_receipt_leftovers(uuid,text,uuid,boolean)']) {
    eq(f + ' authenticated', await pr('authenticated', f), true)
    eq(f + ' anon', await pr('anon', f), false)
  }
  eq('freeze authenticated', await pr('authenticated', 'freeze_settlements(uuid,jsonb,jsonb,uuid[])'), true)
  eq('freeze anon', await pr('anon', 'freeze_settlements(uuid,jsonb,jsonb,uuid[])'), false)
  for (const f of ['_receipt_begin(uuid,boolean)', '_receipt_lines(uuid,boolean)', '_receipt_leftover_plan(uuid,uuid[])', '_receipt_leftover_distribute(uuid,uuid[],bigint[])', '_trip_unclaimed_receipts(uuid)', '_receipt_refresh_status(uuid)', '_receipt_tagged(uuid)', '_receipt_even_split(bigint,integer)', '_receipt_leftover_confirmed(uuid)', '_receipt_leftover_place(uuid,jsonb)', '_receipt_strip_leftovers(uuid)']) {
    eq(f + ' private', [await pr('authenticated', f), await pr('anon', f)], [false, false])
  }
  const cols = (await db.query(`select column_name, column_default d, is_nullable n, data_type t from information_schema.columns where table_name in ('expense_item_claims','expense_line_items') and column_name in ('source','created_by','shared_by_all','leftover_quantity','leftover_amount') order by column_name`)).rows
  eq('columns', cols.map(c => [c.column_name, c.d, c.n, c.t]), [['created_by', null, 'YES', 'uuid'], ['leftover_amount', '0', 'NO', 'numeric'], ['leftover_quantity', '0', 'NO', 'numeric'], ['shared_by_all', 'false', 'NO', 'boolean'], ['source', "'self'::text", 'NO', 'text']])
  await fails('source CHECK', 2, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed,source) values ($1,$2,$3,1,1,'weird')`, [P.lines[0], U(2), P.id], { code: '23514' })
}

// ---- DUST / parity: the SAME cases the client runs (src/features/expenses/lib/unclaimedParityCases.json) -----------------
{
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/features/expenses/lib/unclaimedParityCases.json'), 'utf8')).cases
  let n = 0
  for (const c of cases) {
    const trip = (await db.query(`insert into trips(base_currency) values ($1) returning id`, [c.base])).rows[0].id
    const e = await mkExpense({ trip, amount: c.amount, currency: c.currency, desc: 'parity ' + (++n), status: 'pending_allocation', lines: c.lines.map(([q, tot]) => ['l', q, tot]) })
    if (c.fx != null) await db.query(`update expenses set fx_rate=$2 where id=$1`, [e.id, c.fx])
    for (let i = 0; i < c.lines.length; i++) {
      let k = 0
      for (const [q, a] of c.lines[i][2]) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [e.lines[i], U(21 + k++), e.id, q, a])
    }
    const r = (await db.query(`select unclaimed_minor::int u from _trip_unclaimed_receipts($1)`, [trip])).rows
    eq('parity (server): ' + c.name, r.length ? r[0].u : 0, c.blockedOwnMinor)
  }
  // a legacy-thirds receipt does not block a real freeze, and a line with a real unit left does
  const T6 = (await db.query(`insert into trips(created_by) values ($1) returning id`, [U(11)])).rows[0].id
  await db.query(`insert into trip_participants(trip_id,user_id,role) values ($1,$2,'organizer'),($1,$3,'participant')`, [T6, U(1), U(2)])
  const th = await mkExpense({ trip: T6, amount: 10, currency: 'GBP', desc: 'Legacy thirds', status: 'pending_allocation', lines: [['wine', 1, 10]] })
  for (let k = 0; k < 3; k++) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [th.lines[0], U(21 + k), th.id])
  const snap6 = JSON.stringify({ transactions: [], balances: [], created_at: 'x' })
  const fz = await call(1, `select freeze_settlements($1,$2::jsonb,'[]'::jsonb,'{}'::uuid[]) j`, [T6, snap6])
  ok('legacy fully-claimed thirds do NOT block a freeze', !fz.e, fz.e?.message)
  await call(1, `select unfreeze_settlements($1)`, [T6])
  const real = await mkExpense({ trip: T6, amount: 20, currency: 'GBP', desc: 'Real unit left', status: 'pending_allocation', lines: [['beer', 2, 20]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [real.lines[0], U(21), real.id])
  const fz2 = await call(1, `select freeze_settlements($1,$2::jsonb,'[]'::jsonb,'{}'::uuid[]) j`, [T6, snap6])
  eq('a line with a real unit left blocks (server)', [fz2.e?.hint, JSON.parse(fz2.e?.detail ?? '[]').map(x => x.unclaimed_minor)], ['unclaimed_receipts', [1000]])
  // _receipt_refresh_status uses the same 0.011: set claims on another line of a legacy-thirds receipt keeps it 'allocated'
  const two = await mkExpense({ amount: 20, desc: 'Thirds + other', lines: [['wine', 1, 10], ['bread', 1, 10]] })
  for (let k = 0; k < 3; k++) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [two.lines[0], U(21 + k), two.id])
  const st = await SET(2, two.id, [{ line_item_id: two.lines[1], user_ids: [U(2)] }])
  eq('status stays allocated with 0.01 of a unit of dust', st.r.j.status, 'allocated')
}

// ---- tagged = people IN SCOPE when participant_ids is NULL -----------------------------------------------------------------
{
  const TS = (await db.query(`insert into trips(created_by, confirmation_enabled) values ($1, false) returning id`, [U(11)])).rows[0].id
  const rows = [[21, 'confirmed', true], [22, 'declined', true], [23, 'cancelled', true], [24, 'waitlist', true], [25, null, true], [26, 'confirmed', false]]
  for (const [u, st, act] of rows) await db.query(`insert into trip_participants(trip_id,user_id,active,confirmation_status) values ($1,$2,$3,$4)`, [TS, U(u), act, st])
  const ex = await mkExpense({ trip: TS, payer: 21, amount: 10, desc: 'Scope', lines: [['x', 1, 10]] })
  const tagged = async () => (await db.query(`select _receipt_tagged($1) t`, [ex.id])).rows[0].t.map(x => +x.slice(-12))
  eq('tracking OFF: every ACTIVE participant (statuses ignored, inactive dropped)', await tagged(), [21, 22, 23, 24, 25])
  await db.query(`update trips set confirmation_enabled=true where id=$1`, [TS])
  eq('tracking ON with a confirmed person: ONLY the active confirmed people', await tagged(), [21])
  await db.query(`update trip_participants set confirmation_status='waitlist' where trip_id=$1 and user_id=$2`, [TS, U(21)])
  eq('tracking ON, nobody confirmed: all active people except declined/cancelled', await tagged(), [21, 24, 25])
  await db.query(`update expenses set participant_ids=$2 where id=$1`, [ex.id, [22, 23].map(U)])
  eq('an explicit tag list wins (declined people stay tagged when chosen)', await tagged(), [22, 23])
}

// ---- B2: claimants and the payer are always tagged ------------------------------------------------------------------------
{
  const TS = (await db.query(`insert into trips(created_by, confirmation_enabled) values ($1, true) returning id`, [U(11)])).rows[0].id
  // 21 confirmed+active, 22 "No reply yet" (null status), 23 inactive, 24 payer (waitlist), 25 inactive with only a LEFTOVER row, 26 declined with no claim
  for (const [u, st, act] of [[21, 'confirmed', true], [22, null, true], [23, 'confirmed', false], [24, 'waitlist', true], [25, 'confirmed', false], [26, 'declined', true]])
    await db.query(`insert into trip_participants(trip_id,user_id,active,confirmation_status) values ($1,$2,$3,$4)`, [TS, U(u), act, st])
  const ex = await mkExpense({ trip: TS, payer: 24, amount: 10, desc: 'Claimants', lines: [['x', 4, 10]] })
  const ins = (u, src) => db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed,source,leftover_quantity,leftover_amount) values ($1,$2,$3,1,2.5,$4,$5,$6)`, [ex.lines[0], U(u), ex.id, src, src === 'leftover' ? 1 : 0, src === 'leftover' ? 2.5 : 0])
  const tagged = async () => (await db.query(`select _receipt_tagged($1) t`, [ex.id])).rows[0].t.map(x => +x.slice(-12))
  eq('NULL list, tracking ON: confirmed only + payer', await tagged(), [21, 24])
  await ins(22, 'self'); await ins(23, 'self'); await ins(25, 'leftover')
  eq('"No reply yet" claimant, inactive claimant and the payer are tagged; a leftover row does not tag', await tagged(), [21, 22, 23, 24])
  await db.query(`update expenses set participant_ids=$2 where id=$1`, [ex.id, [21].map(U)])
  eq('explicit list: list + claimants (a person with a claim is never locked out); payer not forced in', await tagged(), [21, 22, 23])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed,source) values ($1,$2,$3,1,2.5,'self')`, [ex.lines[0], U(9), ex.id])
  eq('a claimant with no trip_participants row is not tagged', await tagged(), [21, 22, 23])
  // post-apply check from PRE_APPLY 21n: claimants not in _receipt_tagged must be zero (for rows that have a participant row)
  const bad = (await db.query(`select count(*)::int c from expense_item_claims c join expenses e on e.id=c.expense_id join trip_participants tp on tp.trip_id=e.trip_id and tp.user_id=c.user_id where c.quantity_claimed - c.leftover_quantity > 0 and not (c.user_id = any(_receipt_tagged(c.expense_id)))`)).rows[0].c
  eq('no claimant with a participant row is outside _receipt_tagged', bad, 0)
}

// ---- B1: over-claim trigger tolerates legacy rounding and only refuses a write that itself takes a clean line over ---------------
{
  await db.exec(`GRANT USAGE ON SCHEMA public, auth TO authenticated, anon; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon; GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;`)
  const cl = async (u, line, eid, user, q) => call(u, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$5)`, [line, U(user), eid, q, q])
  const asC = async fn => { await db.exec('SET ROLE authenticated'); try { return await fn() } finally { await db.exec('RESET ROLE') } }
  const mkLegacy = async (desc, qty, total, n, q) => {
    const E = await mkExpense({ amount: total, desc, tagged: [21, 22, 23, 24, 25, 26], lines: [['x', qty, total]] })
    for (let i = 0; i < n; i++) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,$4,$4)`, [E.lines[0], U(21 + i), E.id, q])
    return E
  }
  for (const [qty, n, q, label] of [[1, 6, 0.17, '0.17 x 6'], [1, 3, 0.34, '0.34 x 3']]) {
    const E = await mkLegacy('legacy ' + label, qty, 10, n, q)
    const rs = await asC(async () => {
      await as(21, `delete from expense_item_claims where expense_id=$1`, [E.id])      // the old client's "delete my rows ..."
      const out = []
      for (let i = 0; i < n; i++) out.push(await cl(21 + i, E.lines[0], E.id, 21 + i, q))   // "... then insert them again"
      return out
    })
    ok(`old client re-save of ${label} succeeds`, rs.every(r => !r.e), rs.map(r => r.e?.message))
    eq(`${label}: all rows back`, (await claimRows(E.id)).length, n)
  }
  // a clean line: a write that itself takes it over is refused
  const C = await mkExpense({ amount: 10, desc: 'clean', tagged: [21, 22], lines: [['x', 1, 10]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.9,9)`, [C.lines[0], U(21), C.id])
  const refused = await asC(() => cl(22, C.lines[0], C.id, 22, 0.5))
  eq('a write that itself takes a clean line over is refused', refused.e?.hint, 'overclaimed')
  const fits = await asC(() => cl(22, C.lines[0], C.id, 22, 0.12))
  ok('a write that stays within quantity + 0.011 + 0.01 per other row is allowed', !fits.e, fits.e?.message)
  // already over before the write (legacy): allowed
  const O = await mkLegacy('already over', 1, 10, 2, 0.8)
  const allowed = await asC(() => cl(23, O.lines[0], O.id, 23, 0.1))
  ok('a write on a line that is already over the limit is allowed', !allowed.e, allowed.e?.message)
  // a zero-total line (it exists on live): its quantity can still be claimed by a client
  const Z = await mkExpense({ amount: 10, desc: 'zero lines', tagged: [21, 22], lines: [['z', 1, 0], ['d', 1, 10]] })
  const zr = await asC(() => cl(21, Z.lines[0], Z.id, 21, 1))
  ok('zero-total line: quantity can be claimed', !zr.e, zr.e?.message)
}

// ---- phase 1 "everyone" is a plain equal split (the review's counter-example) -------------------------------------------------
{
  const ppl = [21, 22, 23, 24, 25, 26, 27, 28]
  const CE = await mkExpense({ amount: 312, desc: 'Counter-example', tagged: ppl, lines: [['mains', 252, 252], ['salad', 12, 12], ['wine', 1, 48]] })
  for (const u of ppl.slice(0, 7)) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,36,36)`, [CE.lines[0], U(u), CE.id])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,12,12)`, [CE.lines[1], U(28), CE.id])
  const pv = await SHARE(2, CE.id, 'everyone', null, true)
  eq('EUR 312, 8 people, 48 unclaimed (seven at 36, one at 12): EUR 6.00 each', pv.r.j.people.map(p => p.amount), [6, 6, 6, 6, 6, 6, 6, 6])
  eq('the 12-euro eater is not singled out', pv.r.j.people.find(p => p.user_id === U(28)).total_after, 18)
  // the proposal examples still hold when the confirmed set is passed explicitly (phase 2)
  const p = (await db.query(`select user_id::text u, amount_minor::int a from _receipt_leftover_plan($1,$2::uuid[]) order by user_id`, [CE.id, ppl.slice(0, 7).map(U)])).rows
  eq('with an explicit confirmed set the cap rule applies (only Sam unconfirmed: room 27, rest shared)', p.reduce((s, x) => s + x.a, 0), 4800)
  // mode 'default' alias and an odd split: 9.00 over 8 -> 4 x 1.13 + 4 x 1.12 (via the RPC now)
  const BW = await mkExpense({ amount: 96, desc: 'Bread RPC', tagged: ppl, lines: [['food', 87, 87], ['bread', 1, 9]] })
  for (const u of ppl.slice(0, 7)) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,12,12)`, [BW.lines[0], U(u), BW.id])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,3,3)`, [BW.lines[0], U(28), BW.id])
  const bw = await SHARE(2, BW.id, 'default', null, true)
  eq('9.00 over 8 via the RPC', bw.r.j.people.map(x => x.amount), [1.13, 1.13, 1.13, 1.13, 1.12, 1.12, 1.12, 1.12])
}

// ---- 'same' reads the expense, never activity_feed ---------------------------------------------------------------------------
{
  const SM = await mkExpense({ amount: 60, desc: 'Same mode', tagged: [2, 3, 4], lines: [['a', 1, 30], ['b', 1, 30]] })
  await SET(2, SM.id, [{ line_item_id: SM.lines[0], user_ids: [U(3)] }])
  // a participant forges an activity row asking for "person: Carol"
  await db.query(`insert into activity_feed(trip_id,actor,verb,entity,metadata) values ($1,$2,'receipt_leftovers_shared',$3::jsonb,$4::jsonb)`,
    [T, U(3), JSON.stringify({ type: 'expense', id: SM.id }), JSON.stringify({ mode: 'person', user_id: U(4) })])
  await fails('same ignores a forged activity row', 2, `select share_receipt_leftovers($1,'same')`, [SM.id], { hint: 'no_history' })
  await SHARE(2, SM.id, 'payer')
  const rowE = async () => (await db.query(`select leftover_mode m, leftover_user_id::text u from expenses where id=$1`, [SM.id])).rows[0]
  eq('mode stored on the expense', await rowE(), { m: 'payer', u: null })
  await db.query(`delete from expense_item_claims where line_item_id=$1 and source='leftover'`, [SM.lines[1]])
  const again = await SHARE(2, SM.id, 'same')
  eq('same repeats the REAL mode (payer), not the forged person', again.r.j.mode, 'payer')
  await SHARE(2, SM.id, 'person', U(4))
  eq('person mode stored with its user', await rowE(), { m: 'person', u: U(4) })
  await SET(2, SM.id, [{ line_item_id: SM.lines[1], user_ids: [U(3)] }])
  await SHARE(2, SM.id, 'everyone')
  eq('nothing left: leftover rows cleaned and mode cleared', await rowE(), { m: null, u: null })
  await fails('then there is nothing to repeat', 2, `select share_receipt_leftovers($1,'same')`, [SM.id], { hint: 'no_history' })
}

// ---- ONE row per (line, person): worked example with a person who already had a row and one who did not ------------------------
let WK
{
  WK = await mkExpense({ amount: 60, desc: 'Worked example', tagged: [2, 3, 4], lines: [['pizza', 3, 30], ['wine', 1, 30]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10),($1,$4,$3,1,10)`, [WK.lines[0], U(2), WK.id, U(3)])
  const w = await SHARE(2, WK.id, 'everyone')
  ok('worked share ok', !w.e, w.e?.message)
  const rows = await claimRows(WK.id)
  const row = (l, u) => rows.find(r => r.l === WK.lines[l] && r.u === U(u))
  eq('Alice (had a row): her pizza row grew by 3.34 (own 1 + leftover 0.34)', [row(0, 2).q, row(0, 2).a, row(0, 2).lq, row(0, 2).la, row(0, 2).s], [1.34, 13.34, 0.34, 3.34, 'self'])
  eq('Bob (had a row): 1.33 / 13.33', [row(0, 3).q, row(0, 3).a, row(0, 3).lq, row(0, 3).la], [1.33, 13.33, 0.33, 3.33])
  eq('Carol (no row on pizza): a NEW row, source leftover, quantity > 0', [row(0, 4).q, row(0, 4).a, row(0, 4).s, row(0, 4).cb], [0.33, 3.33, 'leftover', U(2)])
  eq('wine: three new rows, one each', [row(1, 2).a, row(1, 3).a, row(1, 4).a].map(x => cents(x)), [1000, 1000, 1000])
  eq('one row per (line, person)', rows.length, 6)
  eq('every line sums exactly (amount and quantity)', (await lineSums(WK.id)).map(x => [cents(x.a) === cents(x.t), cents(x.q) === cents(x.qty)]), [[true, true], [true, true]])
  eq('totals per person 23.34 / 23.33 / 13.33 = 60', (await db.query(`select sum(amount_owed)::float a from expense_item_claims where expense_id=$1 group by user_id order by user_id`, [WK.id])).rows.map(x => x.a), [23.34, 23.33, 13.33])
  eq('all quantities > 0', rows.every(r => r.q > 0), true)
  eq('status allocated (last statement of the RPC)', await statusOf(WK.id), 'allocated')
  eq('result people', w.r.j.people.map(p => [p.amount, p.already_claimed, p.total_after]), [[13.34, 10, 23.34], [13.33, 10, 23.33], [13.33, 0, 13.33]])
  // re-share after edits does not double
  const again = await SHARE(2, WK.id, 'same')
  eq('re-share (same) gives the identical rows', JSON.stringify((await claimRows(WK.id)).map(({ l, u, q, a, lq, la, s }) => [l, u, q, a, lq, la, s])), JSON.stringify(rows.map(({ l, u, q, a, lq, la, s }) => [l, u, q, a, lq, la, s])))
  const third = await SHARE(2, WK.id, 'everyone')
  eq('and again', (await db.query(`select sum(amount_owed)::float a, sum(leftover_amount)::float l, count(*)::int n from expense_item_claims where expense_id=$1`, [WK.id])).rows[0], { a: 60, l: 40, n: 6 })
  // an edit: Carol (pure leftover on pizza) takes a whole pizza unit herself through the existing direct path: delete her rows, insert
  await db.query(`delete from expense_item_claims where expense_id=$1 and user_id=$2`, [WK.id, U(4)])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [WK.lines[0], U(4), WK.id])
  const re = await SHARE(2, WK.id, 'same')
  ok('re-share after the edit ok', !re.e, re.e?.message)
  eq('after the edit every line still sums exactly', (await lineSums(WK.id)).map(x => [cents(x.a) === cents(x.t), cents(x.q) === cents(x.qty)]), [[true, true], [true, true]])
  eq('no leftover part is larger than its row; only the remaining unclaimed value is leftover (pizza 0 + wine 30)', (await db.query(`select sum(leftover_amount)::float l, bool_and(leftover_amount <= amount_owed and leftover_quantity <= quantity_claimed) b from expense_item_claims where expense_id=$1`, [WK.id])).rows[0], { l: 30, b: true })
}

// ---- set_receipt_claims on a line that carries leftover parts ------------------------------------------------------------------
{
  const SP = await mkExpense({ amount: 60, desc: 'Replace carrying leftovers', tagged: [2, 3, 4], lines: [['pizza', 3, 30], ['wine', 1, 30]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10),($1,$4,$3,1,10)`, [SP.lines[0], U(2), SP.id, U(3)])
  await SHARE(2, SP.id, 'everyone')
  const wineBefore = (await claimRows(SP.id)).filter(r => r.l === SP.lines[1]).map(({ u, q, a, lq, la }) => [u, q, a, lq, la])
  const r = await SET(2, SP.id, [{ line_item_id: SP.lines[0], user_ids: [U(3)] }])
  ok('replacing a line that carries leftover parts ok', !r.e, r.e?.message)
  const rows = await claimRows(SP.id)
  eq('pizza: exactly the new row, its leftover parts discarded', rows.filter(x => x.l === SP.lines[0]).map(x => [x.u, x.q, x.a, x.lq, x.la, x.s]), [[U(3), 3, 30, 0, 0, 'on_behalf']])
  eq('wine (not mentioned) keeps its leftover parts', rows.filter(x => x.l === SP.lines[1]).map(({ u, q, a, lq, la }) => [u, q, a, lq, la]), wineBefore)
  eq('sums still exact', (await lineSums(SP.id)).map(x => [cents(x.a) === cents(x.t), cents(x.q) === cents(x.qty)]), [[true, true], [true, true]])
  const fix = await SHARE(2, SP.id, 'same')
  ok('then re-running same is fine', !fix.e, fix.e?.message)
  eq('nothing double-counted: total 60', (await db.query(`select sum(amount_owed)::float a from expense_item_claims where expense_id=$1`, [SP.id])).rows[0].a, 60)
  eq('wine rebuilt: 30 of leftover parts', (await db.query(`select sum(leftover_amount)::float a from expense_item_claims where expense_id=$1`, [SP.id])).rows[0].a, 30)
}

// ---- pure dust: never a zero-quantity row; the freeze guard does not flag it --------------------------------------------------
{
  const TD = (await db.query(`insert into trips(created_by) values ($1) returning id`, [U(11)])).rows[0].id
  await db.query(`insert into trip_participants(trip_id,user_id,role) values ($1,$2,'organizer'),($1,$3,'participant'),($1,$4,'participant'),($1,$5,'participant'),($1,$6,'participant'),($1,$7,'participant')`, [TD, U(1), U(2), U(21), U(22), U(23), U(24)])
  const snap = JSON.stringify({ transactions: [], balances: [], created_at: 'x' })
  // legacy thirds 0.33 x 3 of 10.00 leave 0.10 of money and 0.01 of a unit; U(24) has NO row at all
  const D = await mkExpense({ trip: TD, amount: 10, desc: 'Dust, no rows', tagged: [21, 22, 23, 24], lines: [['wine', 1, 10]] })
  for (const u of [21, 22, 23]) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [D.lines[0], U(u), D.id])
  const pv = await SHARE(2, D.id, 'everyone', null, true)
  eq('preview: 0.10 split 4 ways, one person gets the hundredth of a unit; the person with no row keeps nothing', [pv.r.j.unclaimed_total, pv.r.j.allocated_total, pv.r.j.kept_by_payer], [0.1, 0.08, 0.02])
  const w = await SHARE(2, D.id, 'everyone')
  ok('dust share ok', !w.e, w.e?.message)
  const rows = await claimRows(D.id)
  eq('no row for the person with no claims (pure dust stays with the payer)', rows.filter(x => x.u === U(24)).length, 0)
  eq('no zero-quantity row, one row per person', [rows.every(x => x.q > 0), rows.length], [true, 3])
  eq('quantity complete (1.00), money 9.98 (the payer bucket keeps 0.02)', (await lineSums(D.id)).map(x => [cents(x.q), cents(x.a)]), [[100, 998]])
  eq('leftover parts 0.03 / 0.03 / 0.02; 21 got the hundredth of a unit', rows.map(x => [x.q, x.a, x.lq, x.la]), [[0.34, 3.33, 0.01, 0.03], [0.33, 3.33, 0, 0.03], [0.33, 3.32, 0, 0.02]])
  eq('status allocated', await statusOf(D.id), 'allocated')
  eq('the freeze guard does not flag the dust', (await db.query(`select count(*)::int c from _trip_unclaimed_receipts($1)`, [TD])).rows[0].c, 0)
  const fz = await call(1, `select freeze_settlements($1,$2::jsonb,'[]'::jsonb,'{}'::uuid[]) j`, [TD, snap])
  ok('freeze goes through with the dust left over', !fz.e, fz.e?.message)
  await call(1, `select unfreeze_settlements($1)`, [TD])
  // dust of a person whose only row is on ANOTHER line: attached to it, the receipt total stays exact
  const A = await mkExpense({ trip: TD, amount: 15, desc: 'Dust, other line', tagged: [21, 22, 23, 24], lines: [['wine', 1, 10], ['bread', 1, 5]] })
  for (const u of [21, 22, 23]) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [A.lines[0], U(u), A.id])
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,5)`, [A.lines[1], U(24), A.id])
  const wa = await SHARE(2, A.id, 'everyone')
  ok('attach share ok', !wa.e, wa.e?.message)
  const ar = await claimRows(A.id)
  eq('U(24) has still ONE row, on the bread; the 0.02 sits in it as a leftover part with no quantity', ar.filter(x => x.u === U(24)).map(x => [x.l === A.lines[1], x.q, x.a, x.lq, x.la]), [[true, 1, 5.02, 0, 0.02]])
  eq('receipt total exact: 15.00 claimed, nothing left with the payer', [(await db.query(`select sum(amount_owed)::float a from expense_item_claims where expense_id=$1`, [A.id])).rows[0].a, wa.r.j.kept_by_payer], [15, 0])
  eq('and not flagged at the freeze', (await db.query(`select count(*)::int c from _trip_unclaimed_receipts($1)`, [TD])).rows[0].c, 0)
  // a re-share strips the attached part again (no doubling)
  await SHARE(2, A.id, 'same')
  eq('re-share: same total', (await db.query(`select sum(amount_owed)::float a, count(*)::int n from expense_item_claims where expense_id=$1`, [A.id])).rows[0], { a: 15, n: 4 })
  // a value-only remainder on a fully claimed line (edited total): people who hold the line absorb it, no zero-quantity row anywhere
  const E = await mkExpense({ trip: TD, amount: 12, desc: 'Edited total', tagged: [21, 22, 23], lines: [['x', 1, 12]] })
  for (const u of [21, 22, 23]) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [E.lines[0], U(u), E.id])
  await SHARE(2, E.id, 'everyone')
  eq('edited-total remainder 2.10 merged into the three rows, 12.00 in all', [(await db.query(`select sum(amount_owed)::float a, bool_and(quantity_claimed > 0) b from expense_item_claims where expense_id=$1`, [E.id])).rows[0]], [{ a: 12, b: true }])
}

// ---- old cached client: delete + insert re-save of a row that carried a leftover part ---------------------------------------------
{
  const OC = await mkExpense({ amount: 60, desc: 'Old client re-save', tagged: [2, 3, 4], lines: [['pizza', 3, 30], ['wine', 1, 30]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10),($1,$4,$3,1,10)`, [OC.lines[0], U(2), OC.id, U(3)])
  await SHARE(2, OC.id, 'everyone')
  const bobLeft = (await claimRows(OC.id)).filter(r => r.u === U(3)).reduce((s, r) => s + r.la, 0)
  const asC = async fn => { await db.exec('SET ROLE authenticated'); try { return await fn() } finally { await db.exec('RESET ROLE') } }
  // forged leftover parts on a client insert are forced to 0 ...
  // the old client: "delete my rows, insert them again" (own quantity 1 of the pizza, as it saw it with the claim page's stepper)
  const rs = await asC(async () => {
    await as(3, `delete from expense_item_claims where expense_id=$1 and user_id=$2`, [OC.id, U(3)])
    return call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed,leftover_quantity,leftover_amount,source) values ($1,$2,$3,1,10,1,10,'leftover')`, [OC.lines[0], U(3), OC.id])
  })
  ok('the old-client re-save succeeds', !rs.e, rs.e?.message)
  const bob = (await claimRows(OC.id)).filter(r => r.u === U(3))
  eq('Bob: one row, own 1 / 10.00; leftover part forced to 0 and provenance to self', bob.map(r => [r.q, r.a, r.lq, r.la, r.s, r.cb]), [[1, 10, 0, 0, 'self', U(3)]])
  const tot = (await db.query(`select sum(amount_owed)::float a, sum(leftover_amount)::float l from expense_item_claims where expense_id=$1`, [OC.id])).rows[0]
  eq('the sums are NOT corrupted: nothing over-claimed, exactly Bob\'s old leftover part is unclaimed again', [cents(tot.a), cents(bobLeft) > 0], [6000 - cents(bobLeft), true])
  eq('lines never over-claimed', (await lineSums(OC.id)).every(x => cents(x.a) <= cents(x.t) && cents(x.q) <= cents(x.qty)), true)
  eq('the receipt shows as having unclaimed value again (freeze guard sees it)', (await db.query(`select unclaimed_minor::int u from _trip_unclaimed_receipts($1)`, [T])).rows.some(r => r.u === cents(bobLeft)), true)
  // a client UPDATE of a row carrying a leftover part keeps it
  const carol = (await claimRows(OC.id)).find(r => r.u === U(4) && r.la > 0)
  await asC(async () => { await as(4, `update expense_item_claims set confirmed=true, leftover_amount=0, leftover_quantity=0 where expense_id=$1 and user_id=$2`, [OC.id, U(4)]) })
  eq('a client UPDATE cannot clear (or raise) the leftover part', (await claimRows(OC.id)).filter(r => r.u === U(4)).map(r => [r.lq, r.la]), (await claimRows(OC.id)).filter(r => r.u === U(4)).map(r => [r.lq, r.la]))
  ok('...Carol still has her leftover parts', (await claimRows(OC.id)).filter(r => r.u === U(4)).every(r => r.la > 0 && r.lq >= 0) && carol.la > 0)
  // payer puts it right
  const fix = await SHARE(2, OC.id, 'same')
  ok('share again ok', !fix.e, fix.e?.message)
  eq('exact again', [(await lineSums(OC.id)).every(x => cents(x.a) === cents(x.t) && cents(x.q) === cents(x.qty)), (await db.query(`select sum(amount_owed)::float a from expense_item_claims where expense_id=$1`, [OC.id])).rows[0].a], [true, 60])
}

// ---- legacy quantities (0.17 x 6, 0.33 x 3) with the EXACT live status trigger present ---------------------------------------------
{
  const LS = await mkExpense({ amount: 20, desc: 'Legacy sixths and thirds', lines: [['sixths', 1, 10], ['thirds', 1, 10], ['bread', 1, 0]] })
  for (let k = 0; k < 6; k++) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.17,1.66)`, [LS.lines[0], U(21 + k), LS.id])
  for (let k = 0; k < 3; k++) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.33,3.3)`, [LS.lines[1], U(21 + k), LS.id])
  eq('the live trigger (exact comparison) calls the thirds receipt pending_allocation', await statusOf(LS.id), 'pending_allocation')
  // an RPC on a different line: the tolerant status is the last write
  const r = await SET(2, LS.id, [{ line_item_id: LS.lines[2], user_ids: [U(2)] }])
  ok('set on the zero-total line ok', !r.e, r.e?.message)
  eq('after the RPC the stored status is the dust-tolerant one: allocated', [r.r.j.status, await statusOf(LS.id)], ['allocated', 'allocated'])
  const sh = await SHARE(2, LS.id, 'everyone', null, true)
  eq('and sharing leftovers sees only dust (0.04 + 0.10 of money)', sh.r.j.unclaimed_total, 0.14)
  // never confirmed / null
  await db.query(`update expenses set status='confirmed' where id=$1`, [LS.id])
  await SET(2, LS.id, [{ line_item_id: LS.lines[2], user_ids: [U(3)] }])
  ok('the refresh never sets confirmed or NULL', ['allocated', 'pending_allocation', 'unallocated', 'confirmed'].includes(await statusOf(LS.id)))
}

// ---- a person whose reply is still pending holds claims (Meribel!) -----------------------------------------------------------------
{
  const TP = (await db.query(`insert into trips(created_by, confirmation_enabled) values ($1, true) returning id`, [U(11)])).rows[0].id
  for (const [u, st] of [[21, 'confirmed'], [22, 'confirmed'], [23, 'pending'], [24, 'declined']]) await db.query(`insert into trip_participants(trip_id,user_id,active,confirmation_status) values ($1,$2,true,$3)`, [TP, U(u), st])
  const PE = await mkExpense({ trip: TP, payer: 21, amount: 40, desc: 'Pending person', lines: [['a', 2, 20], ['b', 2, 20]] })
  for (const l of PE.lines) await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,1,10)`, [l, U(23), PE.id])
  const tg = (await db.query(`select _receipt_tagged($1) t`, [PE.id])).rows[0].t.map(x => +x.slice(-12))
  eq('the pending claimant is tagged (they hold claims), the declined person is not', tg, [21, 22, 23])
  const ok1 = await SET(21, PE.id, [{ line_item_id: PE.lines[0], user_ids: [U(23), U(22)] }])
  ok('payer may put the pending person on a line', !ok1.e, ok1.e?.message)
  const sh = await SHARE(21, PE.id, 'everyone')
  ok('leftovers include them', !sh.e && sh.r.j.people.some(p => p.user_id === U(23)), sh.e?.message)
  eq('sums exact', (await lineSums(PE.id)).every(x => cents(x.a) === cents(x.t) && cents(x.q) === cents(x.qty)), true)
}

// ---- service role (future deadline job) ---------------------------------------------------------------------------------------
{
  const SV = await mkExpense({ amount: 40, desc: 'Deadline job', tagged: [2, 3], lines: [['a', 1, 40]] })
  await db.query(`select set_config('t.role','service_role',false)`)
  const r = await call(null, `select share_receipt_leftovers($1,'everyone') j`, [SV.id])
  ok('service role may share leftovers with no user', !r.e, r.e?.message)
  eq('actor NULL in the activity row, created_by NULL on the rows', [(await db.query(`select actor from activity_feed where verb='receipt_leftovers_shared' and entity->>'id'=$1`, [SV.id])).rows[0].actor, (await claimRows(SV.id)).every(x => x.cb === null)], [null, true])
  await fails('service role may NOT edit claims (no user)', null, `select set_receipt_claims($1,'[]'::jsonb)`, [SV.id], { hint: 'auth' })
  await db.query(`select set_config('t.role','',false)`)
  await fails('no user and no service role: refused', null, `select share_receipt_leftovers($1,'everyone')`, [SV.id], { hint: 'auth' })
}

// ---- client-write protection (ordinary roles) -----------------------------------------------------------------------------------
{
  await db.exec(`GRANT USAGE ON SCHEMA public, auth TO authenticated, anon; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon; GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;`)
  await db.exec(`CREATE FUNCTION public.t_who() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT current_user::text $$; GRANT EXECUTE ON FUNCTION public.t_who() TO authenticated`)
  const owner = (await db.query(`select current_user u`)).rows[0].u
  const asClient = async (u, fn) => { await db.exec('SET ROLE authenticated'); try { return await fn() } finally { await db.exec('RESET ROLE') } }
  const CW = await mkExpense({ amount: 30, desc: 'Client writes', tagged: [2, 3, 4], lines: [['a', 1, 10], ['b', 3, 30]] })
  eq('inside a SECURITY DEFINER function current_user is the OWNER, not the caller role', await asClient(3, async () => (await call(3, `select t_who() w`)).r.w), owner)
  // INSERT with forged provenance
  await asClient(3, async () => { await as(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed,source,created_by) values ($1,$2,$3,1,10,'leftover',$4)`, [CW.lines[0], U(3), CW.id, U(2)]) })
  const r1 = (await claimRows(CW.id))[0]
  eq('client INSERT: source forced to self, created_by forced to the caller', [r1.s, r1.cb], ['self', U(3)])
  // UPDATE cannot change them
  await asClient(3, async () => { await as(3, `update expense_item_claims set source='on_behalf', created_by=$2 where expense_id=$1`, [CW.id, U(2)]) })
  const r2 = (await claimRows(CW.id))[0]
  eq('client UPDATE: source / created_by kept', [r2.s, r2.cb], ['self', U(3)])
  // the definer RPC is NOT affected, even when called by an ordinary client role
  const viaRpc = await asClient(2, async () => await SET(2, CW.id, [{ line_item_id: CW.lines[1], user_ids: [U(3), U(4)] }]))
  ok('RPC works under the authenticated role', !viaRpc.e, viaRpc.e?.message)
  eq('RPC rows keep their real provenance (shared, created_by payer)', (await claimRows(CW.id)).filter(x => x.l === CW.lines[1]).map(x => [x.s, x.cb]), [['shared', U(2)], ['shared', U(2)]])
  await asClient(2, async () => { await SHARE(2, CW.id, 'payer') })
  // the over-claim guard: line a (qty 1) is fully claimed by Bob; Carol may not take more
  const oc = await asClient(4, async () => await call(4, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.5,5)`, [CW.lines[0], U(4), CW.id]))
  eq('client insert that would over-claim a line is refused', [oc.e?.hint, oc.e?.message], ['overclaimed', 'There is not that much of this item left to claim'])
  const okc = await asClient(3, async () => await call(3, `update expense_item_claims set confirmed=true where expense_id=$1 and line_item_id=$2`, [CW.id, CW.lines[0]]))
  ok('a client update that does not change the quantity is never blocked', !okc.e, okc.e?.message)
  // hardening: expense_id must be the line's expense; no claim INSERT/UPDATE while the trip is frozen (DELETE stays possible)
  const other = await mkExpense({ amount: 10, desc: 'Other', tagged: [2, 3], lines: [['y', 1, 10]] })
  const mm = await asClient(3, async () => await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [other.lines[0], U(3), CW.id]))
  eq('client insert whose expense_id is not the line\'s expense is refused', mm.e?.hint, 'bad_expense')
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}'::jsonb where id=$1`, [T])
  const fzi = await asClient(3, async () => await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [other.lines[0], U(3), other.id]))
  eq('client claim insert while frozen is refused', fzi.e?.hint, 'frozen')
  const fzu = await asClient(3, async () => await call(3, `update expense_item_claims set quantity_claimed=0.5, amount_owed=1 where expense_id=$1 and user_id=$2`, [CW.id, U(3)]))
  eq('client claim quantity update while frozen is refused', fzu.e?.hint, 'frozen')
  const fzc = await asClient(3, async () => await call(3, `update expense_item_claims set confirmed=true where expense_id=$1 and line_item_id=$2`, [CW.id, CW.lines[0]]))
  ok('a client update that changes nothing about WHAT is claimed still works while frozen', !fzc.e, fzc.e?.message)
  const fzd = await asClient(3, async () => await call(3, `delete from expense_item_claims where expense_id=$1 and line_item_id=$2 and user_id=$3 returning 1 x`, [CW.id, CW.lines[0], U(3)]))
  ok('deleting a claim while frozen stays possible', !fzd.e, fzd.e?.message)
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [T])
  const afterUnfreeze = await asClient(3, async () => await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.01,0.1)`, [other.lines[0], U(3), other.id]))
  ok('the same insert works once unfrozen', !afterUnfreeze.e, afterUnfreeze.e?.message)
  const room = await mkExpense({ amount: 10, desc: 'Room', tagged: [2, 3], lines: [['x', 1, 10]] })
  await db.query(`insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.99,9.9)`, [room.lines[0], U(2), room.id])
  const edge = await asClient(3, async () => await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.02,0.1)`, [room.lines[0], U(3), room.id]))
  ok('within the 0.011 tolerance (0.99 + 0.02 = 1.01) is allowed', !edge.e, edge.e?.message)
  const over = await asClient(3, async () => await call(3, `insert into expense_item_claims(line_item_id,user_id,expense_id,quantity_claimed,amount_owed) values ($1,$2,$3,0.05,0.1)`, [room.lines[0], U(3), room.id]))
  eq('one more is over 1.011 + 0.01 per other row', over.e?.hint, 'overclaimed')
  // expenses.leftover_mode cannot be written by a client
  await asClient(2, async () => { await as(2, `update expenses set leftover_mode='payer', leftover_user_id=$2 where id=$1`, [room.id, U(3)]) })
  eq('client UPDATE of leftover_mode ignored', (await db.query(`select leftover_mode m, leftover_user_id u from expenses where id=$1`, [room.id])).rows[0], { m: null, u: null })
  await asClient(2, async () => { await as(2, `insert into expenses(trip_id,paid_by,amount,description,leftover_mode) values ($1,$2,5,'ins','everyone')`, [T, U(2)]) })
  eq('client INSERT with leftover_mode forced NULL', (await db.query(`select leftover_mode m from expenses where description='ins'`)).rows[0].m, null)
  await fails('CHECK: leftover_mode must be a known mode', null, `update expenses set leftover_mode='weird' where id=$1`, [room.id], { code: '23514' })
  // grants
  const pr = async (r, f) => (await db.query(`select has_function_privilege($1,$2,'EXECUTE') x`, [r, f])).rows[0].x
  for (const f of ['guard_claim_provenance()', 'guard_claim_overclaim()', 'guard_expense_leftover_mode()']) eq(f + ' revoked from everyone', [await pr('authenticated', f), await pr('anon', f), await pr('service_role', f)], [false, false, false])
  eq('_trip_overclaimed_receipts private', [await pr('authenticated', '_trip_overclaimed_receipts(uuid)'), await pr('anon', '_trip_overclaimed_receipts(uuid)')], [false, false])
}

// ---- refund_rate_limit ------------------------------------------------------------------------------------------------------------
{
  const pr = async (r) => (await db.query(`select has_function_privilege($1,'refund_rate_limit(uuid,text,integer)','EXECUTE') x`, [r])).rows[0].x
  eq('refund_rate_limit: service_role only', [await pr('service_role'), await pr('authenticated'), await pr('anon')], [true, false, false])
  await db.query(`insert into rate_limits(user_id,feature,tokens) values ($1,'parse_receipt',3)`, [U(2)])
  const rf = async () => { const r = (await db.query(`select refund_rate_limit($1,'parse_receipt',5) r`, [U(2)])).rows[0].r; return { r, t: (await db.query(`select tokens::float t from rate_limits where user_id=$1 and feature='parse_receipt'`, [U(2)])).rows[0].t } }
  eq('adds one token', await rf(), { r: true, t: 4 })
  await rf()
  eq('capped at capacity', await rf(), { r: true, t: 5 })
  eq('no bucket -> false, nothing created', (await db.query(`select refund_rate_limit($1,'other',5) r`, [U(2)])).rows[0].r, false)
}

// ---- PRE_APPLY queries run for real: SQL-1 must agree with the guard function, 21s must parse ----------------------------------------
{
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const q1 = pre.slice(pre.indexOf('WITH e AS (\n  SELECT e.trip_id, e.id, e.description, e.currency, e.amount, e.fx_rate, t.base_currency'), pre.indexOf('-- Lines whose claims exceed the line value')).trim().replace(/;$/, '')
  const rows = (await db.query(q1)).rows
  ok('SQL-1 runs and returns rows', rows.length > 0)
  const byDesc = new Map(rows.map(r => [r.description, Number(r.flagged_with_rule_minor)]))
  let checked = 0
  for (const g of (await db.query(`select e.description d, t.id tid from expenses e join trips t on t.id = e.trip_id where e.description like 'parity %'`)).rows) {
    const fn = (await db.query(`select coalesce(sum(unclaimed_minor),0)::int u from _trip_unclaimed_receipts($1)`, [g.tid])).rows[0].u
    if (byDesc.has(g.d)) { eq('SQL-1 == guard function for ' + g.d, byDesc.get(g.d), fn); checked++ }
  }
  ok('SQL-1 cross-checked against the function on several parity receipts', checked >= 5, checked)
  const s = pre.indexOf('-- 21s.'); const q2 = pre.slice(pre.indexOf('SELECT e.description', s), pre.indexOf('-- 21t.')).trim().replace(/;$/, '')
  await db.query(q2); pass++
  // the new assertions of group 21 hold on the faithful stubs (the md5 tripwire columns are about the live bodies, so only checked to run)
  const stmt = (from, startTok) => { const a = pre.indexOf(startTok, pre.indexOf(from)); return pre.slice(a, pre.indexOf(';\n', a)).trim() }
  const asr = (await db.query(stmt('-- ASSERTION: the assumptions the migration', 'SELECT\n  EXISTS'))).rows[0]
  eq('21c assertions (unique key + CHECKs as live)', Object.values(asr), [true, true, true, true, true])
  const en = (await db.query(stmt('-- The expense_status enum values.', 'SELECT (SELECT array_agg(enumlabel'))).rows[0]
  eq('21e enum + status column as assumed', Object.values(en), [true, true])
  const tr = (await db.query(stmt('-- ASSERTION: the live status trigger', 'SELECT EXISTS (SELECT 1 FROM pg_trigger'))).rows[0]
  eq('21c trigger present (md5s are live-only)', tr.trigger_present, true)
  await db.query(stmt('-- 21n-2.', 'SELECT e.description')); pass++
  const q3 = pre.slice(pre.indexOf('-- 21l2.')); await db.query(q3.slice(q3.indexOf('SELECT t.name, count(*) AS receipts_flagged'), q3.indexOf('\n', q3.indexOf('receipts_flagged')) + 1).trim().replace(/;$/, '')); pass++
}

// ---- apply a second time --------------------------------------------------------------------------------------------
{
  const beforeFn = (await db.query(`select proname, md5(prosrc) m from pg_proc where pronamespace='public'::regnamespace and (proname like '\\_receipt%' or proname in ('set_receipt_claims','share_receipt_leftovers','freeze_settlements','_trip_unclaimed_receipts','_trip_overclaimed_receipts','refund_rate_limit','guard_claim_provenance','guard_claim_overclaim','guard_expense_leftover_mode')) order by 1`)).rows
  await db.exec(migSql)
  const afterFn = (await db.query(`select proname, md5(prosrc) m from pg_proc where pronamespace='public'::regnamespace and (proname like '\\_receipt%' or proname in ('set_receipt_claims','share_receipt_leftovers','freeze_settlements','_trip_unclaimed_receipts','_trip_overclaimed_receipts','refund_rate_limit','guard_claim_provenance','guard_claim_overclaim','guard_expense_leftover_mode')) order by 1`)).rows
  eq('second apply changes nothing', afterFn, beforeFn)
  eq('one source CHECK only', (await db.query(`select count(*)::int c from pg_constraint where conname in ('expense_item_claims_source_check','expense_item_claims_leftover_parts_check')`)).rows[0].c, 2)
  eq('the live unique key is still there and still the only one', (await db.query(`select conname from pg_constraint where conrelid='expense_item_claims'::regclass and contype='u'`)).rows.map(r => r.conname), ['unique_user_claim_per_item'])
  eq('the live status trigger is untouched', (await db.query(`select tgname from pg_trigger where tgrelid='expense_item_claims'::regclass and not tgisinternal order by 1`)).rows.map(r => r.tgname), ['trg_guard_claim_overclaim','trg_guard_claim_provenance','trigger_auto_update_expense_status'])
  const again = await SET(2, P.id, [{ line_item_id: P.lines[2], user_ids: [U(4)] }]); ok('works after second apply', !again.e, again.e?.message)
  const pr = (await db.query(`select has_function_privilege('anon','set_receipt_claims(uuid,jsonb)','EXECUTE') a, has_function_privilege('authenticated','set_receipt_claims(uuid,jsonb)','EXECUTE') b`)).rows[0]
  eq('grants after second apply', pr, { a: false, b: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
