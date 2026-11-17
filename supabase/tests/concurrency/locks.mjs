// REAL two-connection lock-order tests for the receipt / settlement area.
//
//   TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres node supabase/tests/concurrency/locks.mjs
//
// Needs a REAL Postgres 17 (CI: a postgres:17 service container, .github/workflows/db.yml). Without TEST_PG_URL the script falls back to PGlite and runs the same scenarios
// SEQUENTIALLY (a smoke test of the scenario code and of the final-money invariants only; it proves nothing about locks).
//
// What it does: bootstraps the stubbed base schema (lib/base.mjs) and applies the repo's receipt migrations 20261124090000, 20261126090000, 20261128090000, 20261128100000 on a
// fresh database (skipped when already bootstrapped), then runs each scenario LOCS_ITER times (default 50). Every scenario races two (or three) transactions on SEPARATE
// connections, each one starting after a random offset and holding its locks a random moment (pg_sleep) before it commits. Asserted every time:
//   * no deadlock (SQLSTATE 40P01) and no lock timeout, except the one DOCUMENTED case (e) where a trip DELETE races a client expense write: at most one side may be aborted;
//   * every error is one of the expected refusals (frozen / claims_closed / ... hints), never an unexpected failure;
//   * the money is right at the end: expenses.amount = sum of the line totals, a fully claimed line adds up to its total, and nothing negative.
//
// Lock order under test (20261126090000 header): (1) trip freeze advisory lock, (2) per-expense advisory lock, (3) rows; the frozen-trip row triggers take only a FOR SHARE on trips.
import { openConn } from './conn.mjs'
import { bootstrapBase, M, U, T } from '../lib/base.mjs'
import fs from 'node:fs'

const ITER = +(process.env.LOCKS_ITER ?? 50)
const REAL = !!process.env.TEST_PG_URL
const MIGS = ['20261124090000_receipt_claims_v2.sql', '20261126090000_receipt_deadline_tokens.sql', '20261128090000_freeze_enforcement.sql', '20261128100000_own_claims_rpc.sql']
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
let pass = 0, fail = 0
const ok = (label, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '') } }
const tally = { deadlocks: 0, refusals: {}, other: [] }

// ---- setup -----------------------------------------------------------------------------------------------------------------------------------------------------------
const admin = await openConn()
if (!(await admin.query(`select to_regclass('public.expenses') t`)).rows[0].t) {
  await bootstrapBase(admin)
  for (const f of MIGS) await admin.exec(fs.readFileSync(M + f, 'utf8'))
  console.log('bootstrapped', REAL ? 'real postgres' : 'pglite (sequential smoke mode)')
}
const q = (sql, p) => admin.query(sql, p).then(r => r.rows)

let seq = 0
const newTrip = async () => {
  const id = (await q(`insert into trips(name,created_by,base_currency) values ($1,$2,'EUR') returning id`, ['lock trip ' + (++seq), U(11)]))[0].id
  for (const [u, r] of [[1, 'organizer'], [2, 'participant'], [3, 'participant'], [4, 'participant'], [21, 'participant']]) await q(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [id, U(u), r])
  return id
}
const newReceipt = async (trip, { lines = [['a', 1, 10], ['b', 1, 20], ['c', 3, 30]] } = {}) => {
  const amount = lines.reduce((s, l) => s + l[2], 0)
  const e = (await q(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,'EUR','lock receipt','unallocated',true,$4) returning id`, [trip, U(2), amount, [2, 3, 4, 21].map(U)]))[0].id
  const ids = []
  let n = 0
  for (const [name, qty, total] of lines) ids.push((await q(`insert into expense_line_items(expense_id,line_number,name_original,quantity,unit_price,subtotal,total_amount) values ($1,$2,$3,$4,$5,$6,$6) returning id`, [e, ++n, name, qty, total / qty, total]))[0].id)
  return { trip, e, lines: ids, amount }
}

// one transaction on its own connection: impersonate, run, hold, commit. who: a number (signed in), 'svc' (service role claims only: the technique the rehearsals use) or 'owner'
async function run(conn, who, work, opts = {}) {
  return conn.exclusive(() => runTx(conn, who, work, opts))
}
async function runTx(conn, who, work, { holdMs = 0 } = {}) {
  try {
    await conn.query('BEGIN')
    await conn.exec("SET LOCAL lock_timeout = '8s'")        // a hang fails fast (55P03 is reported as unexpected) instead of stalling the job
    await conn.exec("SET LOCAL statement_timeout = '30s'")
    if (typeof who === 'number') {
      await conn.query(`select set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true), set_config('request.jwt.claim.role','authenticated',true)`, [JSON.stringify({ sub: U(who), role: 'authenticated' }), U(who)])
      await conn.exec('SET LOCAL ROLE authenticated')
    } else if (who === 'svc') {
      await conn.query(`select set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','service_role',true)`, [JSON.stringify({ role: 'service_role' })])
      await conn.exec('SET LOCAL ROLE service_role')          // the real service role (BYPASSRLS, no superuser): not just claims
    }
    const out = await work(conn)
    if (holdMs) await conn.query(`select pg_sleep($1)`, [holdMs / 1000])
    await conn.query('COMMIT')
    return { ok: true, out }
  } catch (e) {
    try { await conn.query('ROLLBACK') } catch { /* connection already aborted */ }
    return { ok: false, code: e.code, hint: e.hint, msg: e.message }
  }
}
const classify = (label, r, allowed) => {
  if (r.ok) return
  if (r.code === '40P01') { tally.deadlocks++; tally.refusals['DEADLOCK ' + label] = (tally.refusals['DEADLOCK ' + label] ?? 0) + 1; return }
  const key = r.hint || r.code
  tally.refusals[key] = (tally.refusals[key] ?? 0) + 1
  if (!allowed.includes(r.hint) && !allowed.includes(r.code)) tally.other.push({ label, code: r.code, hint: r.hint, msg: (r.msg ?? '').slice(0, 160) })
}
// race two or three operations on separate connections with random start offsets
async function race(label, ops, allowed, conns) {
  const res = await Promise.all(ops.map(async (op, i) => { await sleep(rnd(0, 25)); return run(conns[i], op.who, op.work, { holdMs: op.hold ?? rnd(0, 30) }) }))
  res.forEach((r, i) => classify(label + '/' + (ops[i].name ?? i), r, allowed))
  return res
}
const conns = []
for (let i = 0; i < 3; i++) conns.push(await openConn())

// ---- final-money invariants ----------------------------------------------------------------------------------------------------------------------------------------
async function checkMoney(label, r) {
  const x = (await q(`select e.amount::float a, (select coalesce(sum(total_amount),0)::float from expense_line_items where expense_id=e.id) s from expenses e where e.id=$1`, [r.e]))[0]
  if (x) ok(label + ': amount = sum of the line totals', Math.abs(x.a - x.s) < 0.005 || r.plain, x)
  const bad = await q(`select li.line_number, li.total_amount::float t, coalesce(sum(c.amount_owed),0)::float a, coalesce(sum(c.quantity_claimed),0)::float q, li.quantity::float lq
                       from expense_line_items li left join expense_item_claims c on c.line_item_id=li.id where li.expense_id=$1 group by li.id
                       having coalesce(sum(c.amount_owed),0) > li.total_amount + 0.05 or coalesce(sum(c.quantity_claimed),0) > li.quantity + 0.05`, [r.e])
  ok(label + ': no line is claimed above its total or quantity', bad.length === 0, bad)
  ok(label + ': nothing negative', (await q(`select 1 from expense_item_claims where expense_id=$1 and (amount_owed < 0 or quantity_claimed <= 0)`, [r.e])).length === 0)
}
const claimLine = async (r, line, users, who = 2) => run(conns[0], who, c => c.query(`select set_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: r.lines[line], user_ids: users.map(U) }])]))
const freezeArgs = trip => [trip, JSON.stringify({ transactions: [{ from: U(3), to: U(2), amount: 1, currency: 'EUR' }] }), JSON.stringify([{ from: U(3), to: U(2), amount: 1, currency: 'EUR' }]), []]

const scenarios = {
  // (a) freeze vs a client expense UPDATE, both orders
  async a() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    for (const [i, u] of [[0, [2]], [1, [3]], [2, [4]]]) await claimLine(r, i, u)
    const res = await race('a', [
      { name: 'freeze', who: 1, work: c => c.query(`select freeze_settlements($1,$2::jsonb,$3::jsonb,$4::uuid[])`, freezeArgs(trip)) },
      { name: 'client update', who: 2, work: c => c.query(`update expenses set amount = amount where id=$1`, [r.e]).then(() => c.query(`update expenses set status = status where id=$1`, [r.e])) },
    ], ['frozen', 'unclaimed_receipts', 'overclaimed_receipts', 'stale', 'duplicate_payments'], conns)
    const frozen = (await q(`select settlement_snapshot is not null f from trips where id=$1`, [trip]))[0].f
    if (frozen) {
      const late = await run(conns[2], 2, c => c.query(`update expenses set amount = amount + 1 where id=$1`, [r.e]))
      ok('a: after the freeze committed a client money write is refused', !late.ok && late.hint === 'frozen', late)
    }
    await checkMoney('a', r)
    return res
  },
  // (b) the payer's set_receipt_claims vs the claim page's direct DELETE (an old client) on the same line
  async b() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    await claimLine(r, 0, [3])
    await race('b', [
      { name: 'set_receipt_claims', who: 2, work: c => c.query(`select set_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: r.lines[0], user_ids: [U(3), U(4)] }])]) },
      { name: 'direct delete', who: 3, work: c => c.query(`delete from expense_item_claims where expense_id=$1 and user_id=$2`, [r.e, U(3)]) },
    ], [], conns)
    // the only two legitimate end states: the payer assigned LAST (Bob 5.00 + Carol 5.00 = the whole line) or Bob's delete came last (Carol 5.00 alone)
    const rows = await q(`select user_id::text u, amount_owed::float a from expense_item_claims where line_item_id=$1 order by user_id`, [r.lines[0]])
    const key = JSON.stringify(rows.map(x => [x.u, x.a]))
    ok('b: the line ends in exactly one of the two legitimate states (to the penny)', key === JSON.stringify([[U(3), 5], [U(4), 5]]) || key === JSON.stringify([[U(4), 5]]), rows)
    await checkMoney('b', r)
  },
  // (c) an answer ("I wasn't there") vs the payer re-itemising: the old undo-vs-edit deadlock
  async c() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    await db_send(r)
    await run(conns[0], 21, c => c.query(`select respond_to_receipt($1,'done')`, [r.e]))
    const lines = (await q(`select id::text, name_original, quantity::float qty, subtotal::float sub, total_amount::float t from expense_line_items where expense_id=$1 order by line_number`, [r.e]))
    const body = lines.map((l, i) => ({ id: l.id, name_original: l.name_original + (i === 0 ? ' x' : ''), name_english: null, quantity: l.qty, unit_price: l.sub / l.qty, subtotal: l.sub, tax_amount: 0, service_amount: 0, line_discount_amount: null, total_amount: l.t }))
    await race('c', [
      { name: 'respond', who: 21, work: c => c.query(`select respond_to_receipt($1,$2)`, [r.e, ['undo', 'not_there', 'done'][rnd(0, 2)]]) },
      { name: 'reitemize', who: 2, work: c => c.query(`select reitemize_expense($1,'{}'::jsonb,$2::jsonb,false)`, [r.e, JSON.stringify(body)]) },
      { name: 'direct undo (old path)', who: 21, work: c => c.query(`delete from expense_claim_responses where expense_id=$1 and user_id=$2`, [r.e, U(21)]) },
    ], ['forbidden', '42501', 'has_claims', 'claims_closed', 'frozen', 'deadline_passed'], conns)
    await checkMoney('c', r)
  },
  // (d) a link toggle (service role act) vs the payer's set_receipt_claims
  async d() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    await db_send(r)
    const hash = [...Array(64)].map(() => '0123456789abcdef'[rnd(0, 15)]).join('')
    await run(conns[0], 'svc', c => c.query(`select issue_receipt_claim_token($1,$2,$3)`, [r.e, U(3), hash]))
    await race('d', [
      { name: 'link toggle', who: 'svc', work: c => c.query(`select receipt_claim_act($1,'toggle',$2::jsonb)`, [hash, JSON.stringify({ line_item_id: r.lines[0], on: true })]) },
      { name: 'payer set_receipt_claims', who: 2, work: c => c.query(`select set_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: r.lines[0], user_ids: [U(2), U(4)] }])]) },
    ], ['forbidden'], conns)
    await checkMoney('d', r)
  },
  // (e) DOCUMENTED: deleting a whole trip vs a client expense write: at most one side may be aborted by the deadlock detector
  async e() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    const res = await race('e', [
      { name: 'delete trip', who: 'owner', work: c => c.query(`delete from trips where id=$1`, [trip]) },
      { name: 'client update', who: 2, work: c => c.query(`update expenses set description = 'x' where id=$1`, [r.e]) },
    ], ['frozen', 'P0002'], conns)
    ok('e: at most one side is aborted (documented, accepted)', res.filter(x => !x.ok && x.code === '40P01').length <= 1, res)
  },
  // (f) the daily job applying vs the payer extending the deadline
  async f() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    await claimLine(r, 0, [2])
    await db_send(r)
    await q(`update expenses set claim_deadline = now() - interval '1 minute' where id=$1`, [r.e])
    await race('f', [
      { name: 'apply (service)', who: 'svc', work: c => c.query(`select apply_receipt_deadline($1,false)`, [r.e]) },
      { name: 'extend (payer)', who: 2, work: c => c.query(`select extend_receipt_deadline($1,now() + interval '2 days')`, [r.e]) },
    ], ['claims_closed', 'bad_deadline'], conns)
    const x = (await q(`select claims_closed_at is not null c, claim_deadline > now() ext from expenses where id=$1`, [r.e]))[0]
    ok('f: closed, or extended into the future (or both orders resolved consistently)', x.c || x.ext, x)
    await checkMoney('f', r)
  },
  // (g) reopen vs apply, send vs claim
  async g() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    await claimLine(r, 0, [2]); await db_send(r)
    await run(conns[0], 2, c => c.query(`select apply_receipt_deadline($1,false)`, [r.e]))
    await race('g', [
      { name: 'reopen', who: 2, work: c => c.query(`select reopen_receipt_claims($1, now() + interval '2 days')`, [r.e]) },
      { name: 'apply again', who: 2, work: c => c.query(`select apply_receipt_deadline($1,false)`, [r.e]) },
      { name: 'my claims', who: 3, work: c => c.query(`select set_my_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: r.lines[1], quantity: 1 }])]) },
    ], ['claims_closed', 'not_closed', 'frozen'], conns)
    await checkMoney('g', r)
  },
  // (h) unfreeze vs a client write vs a claim
  async h() {
    const trip = await newTrip(); const r = await newReceipt(trip)
    for (const [i, u] of [[0, [2]], [1, [3]], [2, [4]]]) await claimLine(r, i, u)
    await run(conns[0], 1, c => c.query(`select freeze_settlements($1,$2::jsonb,$3::jsonb,$4::uuid[])`, freezeArgs(trip)))
    await race('h', [
      { name: 'unfreeze', who: 1, work: c => c.query(`select unfreeze_settlements($1)`, [trip]) },
      { name: 'client update', who: 2, work: c => c.query(`update expenses set amount = amount where id=$1`, [r.e]).then(() => c.query(`update expenses set description = 'y' where id=$1`, [r.e])) },
      { name: 'my claims', who: 3, work: c => c.query(`select set_my_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: r.lines[1], quantity: 1 }])]) },
    ], ['frozen'], conns)
    await checkMoney('h', r)
  },
}
async function db_send(r) { await run(conns[0], 2, c => c.query(`select send_receipt_to_table($1)`, [r.e])) }

// ---- chaos: three random operations on one receipt ----------------------------------------------------------------------------------------------------------------------
async function chaos() {
  const trip = await newTrip(); const r = await newReceipt(trip)
  await db_send(r)
  const line = () => r.lines[rnd(0, 2)]
  const menu = [
    () => ({ name: 'send', who: 2, work: c => c.query(`select send_receipt_to_table($1, now() + interval '3 days')`, [r.e]) }),
    () => ({ name: 'claim', who: [2, 3, 4][rnd(0, 2)], work: c => c.query(`select set_my_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: line(), quantity: rnd(0, 1) }])]) }),
    () => ({ name: 'respond', who: [3, 4, 21][rnd(0, 2)], work: c => c.query(`select respond_to_receipt($1,$2)`, [r.e, ['done', 'not_there', 'undo'][rnd(0, 2)]]) }),
    () => ({ name: 'apply', who: rnd(0, 1) ? 'svc' : 2, work: c => c.query(`select apply_receipt_deadline($1,false)`, [r.e]) }),
    () => ({ name: 'extend', who: 2, work: c => c.query(`select extend_receipt_deadline($1, now() + interval '4 days')`, [r.e]) }),
    () => ({ name: 'reopen', who: 2, work: c => c.query(`select reopen_receipt_claims($1)`, [r.e]) }),
    () => ({ name: 'reitemize', who: 2, work: async c => {
      const ls = (await c.query(`select id::text, name_original, quantity::float qty, subtotal::float sub, total_amount::float t from expense_line_items where expense_id=$1 order by line_number`, [r.e])).rows
      return c.query(`select reitemize_expense($1,'{}'::jsonb,$2::jsonb,false)`, [r.e, JSON.stringify(ls.map(l => ({ id: l.id, name_original: l.name_original, quantity: l.qty, unit_price: l.sub / l.qty, subtotal: l.sub, tax_amount: 0, service_amount: 0, total_amount: l.t + rnd(0, 1) })))])
    } }),
    () => ({ name: 'freeze', who: 1, work: c => c.query(`select freeze_settlements($1,$2::jsonb,$3::jsonb,$4::uuid[])`, freezeArgs(trip)) }),
    () => ({ name: 'unfreeze', who: 1, work: c => c.query(`select unfreeze_settlements($1)`, [trip]) }),
    () => ({ name: 'payer assigns', who: 2, work: c => c.query(`select set_receipt_claims($1,$2::jsonb)`, [r.e, JSON.stringify([{ line_item_id: line(), user_ids: [[2], [3], [3, 4]][rnd(0, 2)].map(U) }])]) }),
  ]
  const ops = [menu[rnd(0, menu.length - 1)](), menu[rnd(0, menu.length - 1)](), menu[rnd(0, menu.length - 1)]()]
  // refusals are legitimate in a random mix: anything with a hint is a business refusal; only deadlocks, lock timeouts and hint-less failures are wrong
  const res = await Promise.all(ops.map(async (op, i) => { await sleep(rnd(0, 25)); return run(conns[i], op.who, op.work, { holdMs: rnd(0, 30) }) }))
  res.forEach((x, i) => {
    if (x.ok) return
    if (x.code === '40P01') { tally.deadlocks++; tally.refusals['DEADLOCK chaos ' + ops.map(o => o.name).join('+')] = (tally.refusals['DEADLOCK chaos ' + ops.map(o => o.name).join('+')] ?? 0) + 1; return }
    if (x.code === '55P03') { tally.other.push({ label: 'chaos lock timeout', ops: ops.map(o => o.name) }); return }
    if (!x.hint && !['22023', '42501', 'P0002'].includes(x.code)) tally.other.push({ label: 'chaos ' + ops[i].name, code: x.code, msg: (x.msg ?? '').slice(0, 160) })
    else tally.refusals[x.hint || x.code] = (tally.refusals[x.hint || x.code] ?? 0) + 1
  })
  await checkMoney('chaos ' + ops.map(o => o.name).join('+'), r)
}

// ---- run ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
for (const [name, fn] of Object.entries(scenarios)) {
  for (let i = 0; i < ITER; i++) await fn()
  console.log('scenario', name, 'x', ITER, 'done')
}
for (let i = 0; i < ITER * 2; i++) await chaos()
console.log('chaos x', ITER * 2, 'done')

console.log(JSON.stringify({ real_postgres: REAL, iterations: ITER, deadlocks: tally.deadlocks, refusals: tally.refusals, unexpected: tally.other.slice(0, 8) }))
// the documented deadlock (e) is allowed; every other scenario and the chaos mix must have none
const unexpectedDeadlocks = Object.entries(tally.refusals).filter(([k]) => k.startsWith('DEADLOCK') && !k.startsWith('DEADLOCK e/'))
ok('no deadlock outside the documented trip-delete case', unexpectedDeadlocks.length === 0, unexpectedDeadlocks)
ok('no unexpected error (every failure was a business refusal with a hint)', tally.other.length === 0, tally.other.slice(0, 6))
console.log(`\n${pass} passed, ${fail} failed`)
for (const c of conns) await c.close()
await admin.close()
process.exit(fail ? 1 : 0)
