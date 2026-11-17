// Generated-suite header: assembled with the other parts by run.mjs into ONE module (the checks share their variables).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, M, U, T, T2, bootstrapBase, oldFreezeSrc } from '../../lib/base.mjs'
import { openDb } from '../../lib/openDb.mjs'

const MIG1 = M + '20261124090000_receipt_claims_v2.sql'
const MIG2 = M + '20261126090000_receipt_deadline_tokens.sql'
const MIG3 = M + '20261128090000_freeze_enforcement.sql'
const MIG4 = M + '20261128100000_own_claims_rpc.sql'
const MIG5 = M + '20261129090000_chat_actions.sql'
const MIG6 = M + '20261129100000_chat_private_threads.sql'
const MIG7 = M + '20261129110000_admin_ai_usage.sql'
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
