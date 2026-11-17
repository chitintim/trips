
// ======================================================================================================================================
// TRIP CHAT A1: chat_actions + RPCs (20261129090000), private threads (20261129100000), admin usage (20261129110000)
// ======================================================================================================================================
const CH = '10000000-0000-0000-0000-0000000000c1'
{
  // pre-flight FAILS LOUDLY on the wrong live state (before anything is applied)
  const bad = async (label, setup, want, undo) => {
    await db.exec(setup)
    let msg = null
    try { await db.exec(fs.readFileSync(MIG6, 'utf8')) } catch (e) { msg = e.message }
    await db.exec(undo)
    ok(label, !!msg && msg.includes(want), msg)
  }
  await bad('pre-flight: RLS off on trip_chat_messages -> clear failure', 'ALTER TABLE trip_chat_messages DISABLE ROW LEVEL SECURITY', 'row level security is OFF', 'ALTER TABLE trip_chat_messages ENABLE ROW LEVEL SECURITY')
  await bad('pre-flight: no permissive SELECT policy -> clear failure', 'ALTER POLICY "stub: participants can view chat messages" ON trip_chat_messages RENAME TO stubpol; ALTER TABLE trip_chat_messages DISABLE ROW LEVEL SECURITY; DROP POLICY stubpol ON trip_chat_messages; ALTER TABLE trip_chat_messages ENABLE ROW LEVEL SECURITY', 'NO permissive SELECT policy',
    'CREATE POLICY "stub: participants can view chat messages" ON trip_chat_messages FOR SELECT USING (is_trip_participant(trip_id, auth.uid()))')
  await bad('pre-flight: a wrong-typed turn_id column -> clear failure', 'ALTER TABLE trip_chat_messages ADD COLUMN turn_id text', 'other than uuid', 'ALTER TABLE trip_chat_messages DROP COLUMN turn_id')
  let m7 = null
  try { await db.exec(fs.readFileSync(MIG7, 'utf8')) } catch (e) { m7 = e.message }
  ok('pre-flight: admin usage before chat_actions exists -> clear failure', !!m7 && m7.includes('apply 20261129090000'), m7)
}
await applyFile(MIG5, 'MIG5'); await applyFile(MIG6, 'MIG6'); await applyFile(MIG7, 'MIG7')
{
  const snap = async () => JSON.stringify([await qa(`select proname, md5(prosrc) m, proacl::text a from pg_proc where pronamespace='public'::regnamespace order by 1,2`), await qa(`select tablename, policyname, cmd, permissive from pg_policies where schemaname='public' order by 1,2`), await qa(`select relname, relacl::text a from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`), await qa(`select indexname from pg_indexes where schemaname='public' order by 1`)])
  const a = await snap()
  for (const f of [MIG5, MIG6, MIG7]) await applyFile(f, 'chat re-apply')
  eq('chat migrations: a second apply changes nothing', await snap(), a)
  await db.query(`insert into trips(id,name,created_by) values ($1,'chat trip',$2)`, [CH, U(11)])
  for (const [u, r] of [[1, 'organizer'], [2, 'participant'], [3, 'participant'], [10, 'participant']]) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [CH, U(u), r])
}
{
  // ---- private threads
  const ins = (u, role, text, turn = null, thread = u) => db.query(`insert into trip_chat_messages(trip_id,user_id,role,content,thread_user_id,turn_id) values ($1,$2,$3,$4,$5,$6) returning id`, [CH, u == null ? null : U(u), role, text, thread == null ? null : U(thread), turn])
  await db.query(`insert into trip_chat_messages(trip_id,user_id,role,content) values ($1,$2,'user','legacy shared question')`, [CH, U(2)])
  await ins(2, 'user', 'Alice private question', crypto.randomUUID()); await ins(3, 'user', 'Bob private question', crypto.randomUUID()); await ins(null, 'assistant', 'answer to Bob', crypto.randomUUID(), 3)
  const seen = async u => (await call(u, `select content from trip_chat_messages where trip_id=$1 order by content`, [CH]).then(() => null), (await qa(`select 1`)), null)
  const rows = async u => { await jwt(u); await db.exec('SET ROLE authenticated'); try { return (await db.query(`select content from trip_chat_messages where trip_id=$1 order by content`, [CH])).rows.map(r => r.content) } finally { await db.exec('RESET ROLE') } }
  eq('threads: Alice sees her own thread plus the legacy history, never Bob\'s', await rows(2), ['Alice private question', 'legacy shared question'])
  eq('threads: Bob sees his question, the assistant answer in his thread and the legacy history', await rows(3), ['Bob private question', 'answer to Bob', 'legacy shared question'])
  eq('threads: a member with no thread sees only the legacy history', await rows(10), ['legacy shared question'])
  eq('threads: a non-member sees nothing', await rows(9), [])
  // clients cannot forge or change
  eq('threads: a client cannot insert a legacy (null-thread) row or write into someone else\'s thread', [(await call(3, `insert into trip_chat_messages(trip_id,user_id,role,content) values ($1,$2,'user','forged legacy')`, [CH, U(3)])).e?.code, (await call(3, `insert into trip_chat_messages(trip_id,user_id,role,content,thread_user_id) values ($1,$2,'user','forged into Alice',$3)`, [CH, U(3), U(2)])).e?.code], ['42501', '42501'])
  await db.exec('GRANT UPDATE, DELETE ON trip_chat_messages TO authenticated'); await db.exec('CREATE POLICY "stub: members change chat" ON trip_chat_messages FOR ALL USING (is_trip_participant(trip_id, auth.uid()))')
  ok('threads: legacy rows are read-only even if a permissive write policy exists', (await call(3, `with d as (delete from trip_chat_messages where trip_id=$1 and thread_user_id is null returning 1) select count(*)::int n from d`, [CH])).r.n === 0)
  ok('threads: nobody can delete or edit another person\'s thread row', (await call(3, `with d as (update trip_chat_messages set content='x' where trip_id=$1 and thread_user_id=$2 returning 1) select count(*)::int n from d`, [CH, U(2)])).r.n === 0)
  ok('threads: ... but you can change your own', (await call(3, `with d as (update trip_chat_messages set content='edited' where trip_id=$1 and thread_user_id=$2 returning 1) select count(*)::int n from d`, [CH, U(3)])).r.n === 2)
  await db.exec('DROP POLICY "stub: members change chat" ON trip_chat_messages')
  // dedupe
  const turn = crypto.randomUUID()
  await ins(2, 'user', 'q', turn); await ins(null, 'assistant', 'a', turn, 2)
  let dup = null; try { await ins(2, 'user', 'q again', turn) } catch (e) { dup = e.code }
  eq('dedupe: the same turn_id cannot be stored twice per thread and role (23505); the other role and another thread are fine', [dup, (await ins(3, 'user', 'q', turn)).rows.length], ['23505', 1])
  // new_chat / mark_chat_seen
  eq('new_chat sets cleared_at for the caller only', [(await call(2, `select new_chat($1) j`, [CH])).r.j.cleared_at !== null, (await qa(`select user_id::text u from trip_chat_threads where trip_id=$1`, [CH])).map(r => r.u)], [true, [U(2)]])
  eq('mark_chat_seen keeps cleared_at', [(await call(2, `select mark_chat_seen($1) j`, [CH])).r.j.last_seen_at !== null, (await q1(`select cleared_at is not null c from trip_chat_threads where trip_id=$1 and user_id=$2`, [CH, U(2)])).c], [true, true])
  eq('new_chat: outsider / no JWT', [(await call(9, `select new_chat($1)`, [CH])).e?.hint, (await call(null, `select new_chat($1)`, [CH])).e?.hint], ['forbidden', 'auth'])
  eq('trip_chat_threads: clients read their own row only and cannot write', [(await call(3, `select count(*)::int n from trip_chat_threads`)).r.n, (await call(2, `insert into trip_chat_threads(trip_id,user_id) values ($1,$2)`, [CH, U(2)])).e?.code], [0, '42501'])
}
{
  // ---- chat_actions
  const mk = async (u, over = {}) => (await db.query(`insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires,expires_at) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9) returning id::text`,
    [CH, U(u), crypto.randomUUID(), over.kind ?? 'add_todo', JSON.stringify({ title: 'Book ferry' }), JSON.stringify({ line: 'Add to-do' }), JSON.stringify({ v: 1 }), over.requires ?? 'tap', over.expires ?? new Date(Date.now() + 86400e3).toISOString()])).rows[0].id
  const BEGIN = (u, id) => call(u, `select begin_chat_action($1) j`, [id]), FIN = (u, id, ok2 = true, res = { id: 'x' }, err = null) => call(u, `select finish_chat_action($1,$2,$3::jsonb,$4) j`, [id, ok2, res == null ? null : JSON.stringify(res), err]), DIS = (u, id) => call(u, `select dismiss_chat_action($1) j`, [id])
  const a1 = await mk(2)
  eq('clients: read their own proposals only', [(await call(2, `select count(*)::int n from chat_actions`)).r.n, (await call(3, `select count(*)::int n from chat_actions`)).r.n], [1, 0])
  eq('clients: cannot insert, update or delete a proposal', [(await call(2, `insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires) values ($1,$2,gen_random_uuid(),'x1','{}','{}','{}','tap')`, [CH, U(2)])).e?.code, (await call(2, `update chat_actions set params='{"title":"EVIL"}' where id=$1`, [a1])).e?.code, (await call(2, `delete from chat_actions where id=$1`, [a1])).e?.code], ['42501', '42501', '42501'])
  eq('everyone (service role too): id / user / kind / params / requires are frozen', [(await call('svc', `update chat_actions set params='{"title":"EVIL"}' where id=$1`, [a1])).e?.hint, (await call('svc', `update chat_actions set user_id=$2 where id=$1`, [a1, U(3)])).e?.hint, (await call('svc', `update chat_actions set kind='other_kind' where id=$1`, [a1])).e?.hint], ['immutable', 'immutable', 'immutable'])
  eq('kind must be lower_snake', (await call('svc', `insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires) values ($1,$2,gen_random_uuid(),'Bad Kind','{}','{}','{}','tap')`, [CH, U(2)])).e?.code, '23514')
  // begin: owner only, atomic, once
  eq('begin: another person gets not_found (indistinguishable from an unknown id), no JWT gets auth', [(await BEGIN(3, a1)).e?.hint, (await BEGIN(null, a1)).e?.hint, (await BEGIN(2, '99999999-0000-0000-0000-000000000000')).e?.hint], ['not_found', 'auth', 'not_found'])
  const b1 = await BEGIN(2, a1)
  eq('begin: the owner starts it', [b1.r.j.started, b1.r.j.action.status, b1.r.j.action.started_at !== null, b1.r.j.action.params], [true, 'executing', true, { title: 'Book ferry' }])
  const b2 = await BEGIN(2, a1)
  eq('begin twice (double tap / second device): runs once, the second says already_started', [b2.r.j.started, b2.r.j.reason, b2.r.j.action.status], [false, 'already_started', 'executing'])
  // finish
  eq('finish: a non-owner gets not_found; a never-started action is refused', [(await FIN(3, a1)).e?.hint, (await FIN(2, await mk(2))).e?.hint], ['not_found', 'not_started'])
  eq('finish: bad result refused', [(await FIN(2, a1, true, { big: 'x'.repeat(20000) })).e?.hint, (await call(2, `select finish_chat_action($1,true,'[1]'::jsonb) j`, [a1])).e?.hint], ['bad_input', 'bad_input'])
  const f1 = await FIN(2, a1, true, { todo_id: 'abc' })
  eq('finish: done with the result stored', [f1.r.j.finished, f1.r.j.action.status, f1.r.j.action.result, f1.r.j.action.finished_at !== null], [true, 'done', { todo_id: 'abc' }, true])
  eq('finish twice: idempotent, nothing overwritten', [(await FIN(2, a1, false, { other: 1 }, 'late')).r.j.reason, (await q1(`select status s, result r from chat_actions where id=$1`, [a1]))], ['already_finished', { s: 'done', r: { todo_id: 'abc' } }])
  const a2 = await mk(2); await BEGIN(2, a2)
  const f2 = await FIN(2, a2, false, null, 'x'.repeat(900))
  eq('finish: failed keeps a truncated error', [f2.r.j.action.status, f2.r.j.action.error.length], ['failed', 500])
  // dismiss
  const a3 = await mk(2)
  eq('dismiss: owner only, idempotent, not after started', [(await DIS(3, a3)).e?.hint, (await DIS(2, a3)).r.j.dismissed, (await DIS(2, a3)).r.j.dismissed, (await DIS(2, a1)).r.j.reason], ['not_found', true, true, 'not_proposed'])
  eq('begin on a dismissed action: not_proposed', (await BEGIN(2, a3)).r.j.reason, 'not_proposed')
  // expiry
  const a4 = await mk(2, { expires: new Date(Date.now() - 1000).toISOString() })
  const e1 = await BEGIN(2, a4)
  eq('begin on an expired proposal: expired (and stored as expired)', [e1.r.j.started, e1.r.j.reason, (await q1(`select status s from chat_actions where id=$1`, [a4])).s], [false, 'expired', 'expired'])
  const a5 = await mk(2, { expires: new Date(Date.now() - 1000).toISOString() }), a6 = await mk(3, { expires: new Date(Date.now() - 1000).toISOString() })
  eq('dismiss / mark on an expired proposal says expired', [(await DIS(2, a5)).r.j.reason, (await call(3, `select mark_chat_action_edited($1) j`, [a6])).r.j.reason], ['expired', 'expired'])
  eq('expire_stale: service role only; expires the rest', [(await call(2, `select chat_actions_expire_stale() j`)).e?.code, (await call('svc', `select chat_actions_expire_stale() j`)).r.j], ['42501', 0])
  // edited elsewhere
  const a7 = await mk(2)
  const ed = await call(2, `select mark_chat_action_edited($1,$2::jsonb) j`, [a7, JSON.stringify({ saved: true })])
  eq('mark_chat_action_edited: proposed -> edited_elsewhere, edited true; again is idempotent; begin then says not_proposed', [ed.r.j.action.status, ed.r.j.action.edited, (await call(2, `select mark_chat_action_edited($1) j`, [a7])).r.j.marked, (await BEGIN(2, a7)).r.j.reason], ['edited_elsewhere', true, true, 'not_proposed'])
  // undone
  const un1 = await call(2, `select mark_chat_action_undone($1) j`, [a1])
  eq('undone: only a done action; sets result.undone_at once (idempotent), result otherwise intact', [un1.r.j.undone, un1.r.j.action.result.todo_id, typeof un1.r.j.action.result.undone_at, (await call(2, `select mark_chat_action_undone($1) j`, [a1])).r.j.action.result.undone_at === un1.r.j.action.result.undone_at, (await call(2, `select mark_chat_action_undone($1) j`, [a3])).r.j.reason, (await call(3, `select mark_chat_action_undone($1) j`, [a1])).e?.hint, (await call(null, `select mark_chat_action_undone($1) j`, [a1])).e?.hint], [true, 'abc', 'string', true, 'not_done', 'not_found', 'auth'])
  eq('undone: a client still cannot write result directly', (await call(2, `update chat_actions set result='{}' where id=$1`, [a1])).e?.code, '42501')
  eq('duplicate proposal in one turn is rejected by the unique index (23505); a different params value is fine', await (async () => { const t = crypto.randomUUID(); const ins = p => call('svc', `insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires) values ($1,$2,$3,'add_todo',$4::jsonb,'{}','{}','tap')`, [CH, U(2), t, JSON.stringify(p)]); return [(await ins({ a: 1 })).e, (await ins({ a: 1 })).e?.code, (await ins({ a: 2 })).e] })(), [undefined, '23505', undefined])
  // no longer on the trip
  const a8 = await mk(10)
  await db.query(`delete from trip_participants where trip_id=$1 and user_id=$2`, [CH, U(10)])
  eq('begin: someone who left the trip is refused', (await BEGIN(10, a8)).e?.hint, 'forbidden')
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true)`, [CH, U(10)])
  // the daily cap: 25 confirmed in 24h
  await db.query(`delete from chat_actions where user_id=$1`, [U(3)])
  for (let i = 0; i < 25; i++) { const id = await mk(3); const r = await BEGIN(3, id); if (!r.r?.j.started) { ok('cap: the first 25 start', false, r.e?.message); break } }
  const over = await mk(3)
  eq('cap: the 26th confirmed action in 24h is refused (daily_cap) and stays proposed', [(await BEGIN(3, over)).e?.hint, (await q1(`select status s from chat_actions where id=$1`, [over])).s], ['daily_cap', 'proposed'])
  const again = await db.query(`select id::text from chat_actions where user_id=$1 and status='executing' limit 1`, [U(3)])
  eq('cap: a retry of an already started action does not consume another / is not refused', (await BEGIN(3, again.rows[0].id)).r.j.reason, 'already_started')
  await db.query(`update chat_actions set started_at = now() - interval '25 hours' where user_id=$1`, [U(3)])
  eq('cap: counted over a rolling 24 hours', (await BEGIN(3, over)).r.j.started, true)
  eq('privileges: the RPCs are authenticated only; expire_stale service only', await (async () => { const o = {}; for (const f of ['begin_chat_action(uuid)', 'finish_chat_action(uuid,boolean,jsonb,text)', 'dismiss_chat_action(uuid)', 'mark_chat_action_edited(uuid,jsonb)', 'mark_chat_action_undone(uuid)', 'new_chat(uuid)', 'mark_chat_seen(uuid)', 'admin_ai_usage_summary(integer)', 'chat_actions_expire_stale()', '_chat_action_own(uuid)']) { const p = await q1(`select has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') u`, ['public.' + f]); o[f] = [p.a, p.u] } return o })(),
    { 'begin_chat_action(uuid)': [false, true], 'finish_chat_action(uuid,boolean,jsonb,text)': [false, true], 'dismiss_chat_action(uuid)': [false, true], 'mark_chat_action_edited(uuid,jsonb)': [false, true], 'mark_chat_action_undone(uuid)': [false, true], 'new_chat(uuid)': [false, true], 'mark_chat_seen(uuid)': [false, true], 'admin_ai_usage_summary(integer)': [false, true], 'chat_actions_expire_stale()': [false, false], '_chat_action_own(uuid)': [false, false] })
  eq('cascade: deleting the trip removes proposals, threads and messages', await (async () => { await db.query(`delete from trips where id=$1`, [CH]); return [(await q1(`select count(*)::int n from chat_actions where trip_id=$1`, [CH])).n, (await q1(`select count(*)::int n from trip_chat_messages where trip_id=$1`, [CH])).n, (await q1(`select count(*)::int n from trip_chat_threads where trip_id=$1`, [CH])).n] })(), [0, 0, 0])
}
{
  // ---- admin_ai_usage_summary
  const AT = '10000000-0000-0000-0000-0000000000c2'
  await db.query(`insert into trips(id,name,created_by) values ($1,'usage trip',$2)`, [AT, U(11)])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true)`, [AT, U(2)])
  await db.query(`insert into ai_usage(user_id,trip_id,function_name,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_usd,created_at) values
    ($1,$2,'trip-chat','claude-sonnet-5-5',1000,200,8000,1000,0.03,now()), ($1,$2,'trip-chat','claude-sonnet-5-5',1000,100,0,0,0.01,now()), ($1,$2,'parse-receipt','claude-sonnet-5-5',500,50,0,0,0.002,now() - interval '3 days'), ($1,$2,'trip-chat','old-model',9,9,9,9,9,now() - interval '60 days')`, [U(2), AT])
  await db.query(`insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires,status,started_at) values ($1,$2,gen_random_uuid(),'add_todo','{}','{}','{}','tap','done',now()), ($1,$2,gen_random_uuid(),'add_todo','{}','{}','{}','tap','dismissed',null), ($1,$2,gen_random_uuid(),'answer','{}','{}','{}','tap','failed',now())`, [AT, U(2)])
  eq('admin usage: members and no-JWT are refused', [(await call(2, `select admin_ai_usage_summary(30) j`)).e?.hint, (await call(null, `select admin_ai_usage_summary(30) j`)).e?.hint], ['forbidden', 'forbidden'])
  const r = await call(10, `select admin_ai_usage_summary(30) j`)
  ok('admin usage: a site admin gets the summary', !r.e, r.e?.message)
  const u0 = r.r.j.usage.filter(x => x.function_name === 'trip-chat')
  eq('admin usage: per day x function x model with totals and the cache-read share', [u0.length, u0[0].calls, u0[0].input_tokens, u0[0].cache_read_tokens, u0[0].cache_read_share, u0[0].cost_usd], [1, 2, 2000, 8000, 0.7273, 0.04])
  eq('admin usage: the 60-day-old row is outside the 30-day window; the 3-day-old receipt row is inside', [r.r.j.usage.some(x => x.model === 'old-model'), r.r.j.usage.some(x => x.function_name === 'parse-receipt')], [false, true])
  eq('admin usage: the chat_actions funnel per kind', r.r.j.actions.map(a => [a.kind, a.proposed, a.started, a.done, a.failed, a.dismissed]), [['add_todo', 2, 1, 1, 0, 1], ['answer', 1, 1, 0, 1, 0]])
  eq('admin usage: p_days is clamped (1..180)', [(await call(10, `select admin_ai_usage_summary(0) j`)).r.j.days, (await call(10, `select admin_ai_usage_summary(9999) j`)).r.j.days], [1, 180])
}

// ---- PRE_APPLY group 25 executes on the stubs (post-apply state) ----------------------------------------------------------------------------------------------------
{
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const g = pre.slice(pre.indexOf('-- 25. Trip chat A1'))
  const stub = g.replace(/SELECT enum_range\(NULL::public\.user_role\)[^\n]*\n/, '').replace(/SELECT pubname FROM pg_publication_tables[^\n]*\n/, '')
  try { await db.exec(stub); pass++ } catch (e) { fail++; console.log('FAIL group 25 does not run:', e.message) }
}
