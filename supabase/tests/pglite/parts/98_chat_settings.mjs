// ======================================================================================================================================
// TRIP CHAT SWITCHES (20261130090000): chat_site_settings + trip_chat_settings + 4 RPCs. Runs on top of the three chat migrations of 97_chat.mjs.
// ======================================================================================================================================
{
  const TEST_TRIP = 'be551bc4-a524-4b6a-a0c9-b74a7168ced4'
  const TA = '10000000-0000-0000-0000-0000000000d1'   // organiser U1, participants U2 U3
  const TB = '10000000-0000-0000-0000-0000000000d2'   // organiser U2, U1 is a plain participant
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const g26 = pre.slice(pre.indexOf('-- 26. Trip chat switches'))
  ok('PRE_APPLY group 26 exists', g26.length > 500)

  // ---- pre-flight fails loudly on the wrong state, and group 26 runs before the apply (all objects absent)
  const bad = async (label, setup, want, undo) => {
    await db.exec(setup)
    let msg = null
    try { await db.exec(fs.readFileSync(MIG8, 'utf8')) } catch (e) { msg = e.message }
    await db.exec(undo)
    ok(label, !!msg && msg.includes(want), msg)
  }
  await bad('pre-flight: chat_actions missing (migration 1 not applied) -> clear failure', 'ALTER TABLE chat_actions RENAME TO chat_actions_x', 'apply 20261129090000', 'ALTER TABLE chat_actions_x RENAME TO chat_actions')
  await bad('pre-flight: trips.end_date of another type -> clear failure', 'ALTER TABLE trips ALTER COLUMN end_date TYPE timestamptz', 'trips.start_date / end_date must be date', 'ALTER TABLE trips ALTER COLUMN end_date TYPE date USING end_date::date')
  await bad('pre-flight: a different chat_site_settings already there -> clear failure', 'CREATE TABLE chat_site_settings (x int)', 'different shape', 'DROP TABLE chat_site_settings')
  await bad('pre-flight: a different trip_chat_settings already there -> clear failure', 'CREATE TABLE trip_chat_settings (x int)', 'different shape', 'DROP TABLE trip_chat_settings')
  eq('group 26 (pre-apply): the objects are absent', [(await qa(`select relname from pg_class where relnamespace='public'::regnamespace and relname in ('chat_site_settings','trip_chat_settings')`)).length, (await qa(`select 1 from pg_proc where pronamespace='public'::regnamespace and proname in ('get_chat_availability','set_trip_chat_settings','admin_get_chat_settings','admin_set_chat_settings','_chat_effective')`)).length], [0, 0])
  try { await db.exec(g26.slice(0, g26.indexOf('-- 26e.'))); pass++ } catch (e) { fail++; console.log('FAIL group 26 (a-d) does not run pre-apply:', e.message) }

  // ---- the trips: TA (U1 organiser, U2/U3 participants), TB (U2 organiser, U1 participant); dates are set per scenario
  await db.query(`insert into trips(id,name,created_by,created_at) values ($1,'Trip A',$3,now() - interval '2 days'),($2,'Trip B',$3,now() - interval '1 day')`, [TA, TB, U(11)])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'organizer',true),($1,$3,'participant',true),($1,$4,'participant',true),($5,$3,'organizer',true),($5,$2,'participant',true)`, [TA, U(1), U(2), U(3), TB])
  // the test trip does NOT exist yet: the seed must not create a row for it
  await applyFile(MIG8, 'MIG8')
  eq('seed: site row = actions / upcoming; no test-trip row while the trip does not exist', [(await qa(`select id, mode, actions_scope from chat_site_settings`)), (await qa(`select 1 from trip_chat_settings`)).length], [[{ id: true, mode: 'actions', actions_scope: 'upcoming' }], 0])
  await db.query(`insert into trips(id,name,created_by) values ($1,'TEST payment email - delete me',$2)`, [TEST_TRIP, U(1)])
  await applyFile(MIG8, 'MIG8 re-apply')
  eq('seed: with the test trip present, a re-run adds ONLY its row (chat inherit, actions on)', await qa(`select trip_id::text t, chat, actions from trip_chat_settings`), [{ t: TEST_TRIP, chat: 'inherit', actions: 'on' }])
  await db.query(`update chat_site_settings set mode='answers', actions_scope='all'`); await db.query(`update trip_chat_settings set actions='off'`)
  await applyFile(MIG8, 'MIG8 re-apply 2')
  eq('re-apply is idempotent: it never overwrites what an admin chose', [(await q1(`select mode, actions_scope from chat_site_settings`)), (await q1(`select actions from trip_chat_settings`)).actions], [{ mode: 'answers', actions_scope: 'all' }, 'off'])
  await db.query(`update chat_site_settings set mode='actions', actions_scope='upcoming'`); await db.query(`delete from trip_chat_settings`)
  try { await db.exec(g26); pass++ } catch (e) { fail++; console.log('FAIL group 26 does not run post-apply:', e.message) }

  // ---- structure: RLS on, no policy, no client privilege, singleton, privileges
  eq('structure: RLS on, NO policies, no client privilege on either table; service role has it', await qa(`select relname, relrowsecurity rls, (select count(*)::int from pg_policies p where p.tablename=c.relname) pol, has_table_privilege('anon', c.oid,'SELECT') a, has_table_privilege('authenticated', c.oid,'SELECT') s,
      has_table_privilege('authenticated', c.oid,'INSERT') i, has_table_privilege('authenticated', c.oid,'UPDATE') u, has_table_privilege('authenticated', c.oid,'DELETE') d, has_table_privilege('service_role', c.oid,'SELECT') sv
    from pg_class c where relnamespace='public'::regnamespace and relname in ('chat_site_settings','trip_chat_settings') order by 1`),
    [{ relname: 'chat_site_settings', rls: true, pol: 0, a: false, s: false, i: false, u: false, d: false, sv: true }, { relname: 'trip_chat_settings', rls: true, pol: 0, a: false, s: false, i: false, u: false, d: false, sv: true }])
  eq('clients cannot read or write the tables directly (42501), not even an admin', [
    (await call(2, `select * from chat_site_settings`)).e?.code, (await call(10, `update chat_site_settings set mode='off'`)).e?.code, (await call(10, `insert into trip_chat_settings(trip_id) values ($1)`, [TA])).e?.code,
    (await call(1, `select * from trip_chat_settings`)).e?.code, (await call('anon', `select * from chat_site_settings`)).e?.code], ['42501', '42501', '42501', '42501', '42501'])
  eq('singleton: a second row is impossible (id false -> CHECK 23514; id true again -> 23505); the row cannot be deleted (P0001)', [
    (await call(null, `insert into chat_site_settings(id) values (false)`)).e?.code, (await call(null, `insert into chat_site_settings(id) values (true)`)).e?.code, (await call(null, `delete from chat_site_settings`)).e?.code], ['23514', '23505', 'P0001'])
  eq('CHECKs: bad values refused at the table', [(await call(null, `update chat_site_settings set mode='maybe'`)).e?.code, (await call(null, `update chat_site_settings set actions_scope='some'`)).e?.code,
    (await call(null, `insert into trip_chat_settings(trip_id,chat) values ($1,'on')`, [TA])).e?.code, (await call(null, `insert into trip_chat_settings(trip_id,actions) values ($1,'maybe')`, [TA])).e?.code], ['23514', '23514', '23514', '23514'])
  const fnPriv = async f => { const r = await q1(`select has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') s`, [f]); return [r.a, r.s] }
  const pubFns = ['get_chat_availability(uuid)', 'set_trip_chat_settings(uuid,text,text)', 'admin_get_chat_settings()', 'admin_set_chat_settings(text,text)']
  const intFns = ['_chat_trip_upcoming(date,date)', '_chat_effective(text,text,text,text,date,date)', '_chat_is_site_admin(uuid)', '_chat_availability_json(uuid,uuid)', '_chat_admin_json()', 'guard_chat_site_settings_delete()']
  eq('privileges: the four RPCs are authenticated-only (never anon); the helpers are for nobody', [await Promise.all(pubFns.map(fnPriv)), await Promise.all(intFns.map(fnPriv))], [pubFns.map(() => [false, true]), intFns.map(() => [false, false])])
  eq('security: the RPCs are SECURITY DEFINER with a pinned search_path', await qa(`select proname, prosecdef d, coalesce(proconfig::text,'') c from pg_proc where pronamespace='public'::regnamespace and proname in ('get_chat_availability','set_trip_chat_settings','admin_get_chat_settings','admin_set_chat_settings') order by 1`),
    ['admin_get_chat_settings', 'admin_set_chat_settings', 'get_chat_availability', 'set_trip_chat_settings'].map(proname => ({ proname, d: true, c: '{"search_path=public, pg_temp"}' })))

  // ---- effective-value matrix: site mode x scope x trip chat x trip actions x dates, against an independent JS model
  const today = (await q1(`select (now() at time zone 'utc')::date::text d`)).d
  const shift = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const datesCases = [['future', shift(40), shift(45)], ['ends today', shift(-3), today], ['ended 30 days ago', shift(-40), shift(-30)], ['ended 31 days ago', shift(-40), shift(-31)], ['no end, start 30 ago', shift(-30), null], ['no end, start 31 ago', shift(-31), null], ['no dates', null, null]]
  const upcomingJs = (start, end) => { const ref = end ?? start; return ref === null ? true : ref >= shift(-30) }
  const effJs = (mode, scope, tc, ta, start, end) => { const chat = mode !== 'off' && tc !== 'off'; return { chat, actions: chat && mode === 'actions' && ta !== 'off' && (ta === 'on' || scope === 'all' || upcomingJs(start, end)) } }
  let matrixBad = 0, matrixN = 0
  for (const [, start, end] of datesCases) {
    await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, start, end])
    for (const mode of ['off', 'answers', 'actions']) for (const scope of ['upcoming', 'all']) for (const tc of ['inherit', 'off']) for (const ta of ['inherit', 'off', 'on']) {
      await db.query(`update chat_site_settings set mode=$1, actions_scope=$2`, [mode, scope])
      await db.query(`insert into trip_chat_settings(trip_id,chat,actions) values ($1,$2,$3) on conflict (trip_id) do update set chat=excluded.chat, actions=excluded.actions`, [TA, tc, ta])
      const want = effJs(mode, scope, tc, ta, start, end)
      const got = (await call(2, `select get_chat_availability($1) j`, [TA])).r?.j
      const adm = (await call(10, `select admin_get_chat_settings() j`)).r?.j.trips.find(t => t.trip_id === TA)
      matrixN++
      if (!got || got.chat !== want.chat || got.actions !== want.actions || adm?.effective_chat !== want.chat || adm?.effective_actions !== want.actions) { matrixBad++; if (matrixBad < 6) console.log('MATRIX FAIL', { mode, scope, tc, ta, start, end, want, got, adm }) }
    }
  }
  ok(`effective-value matrix: ${matrixN} combinations (3 modes x 2 scopes x chat inherit/off x actions inherit/off/on x ${datesCases.length} date cases) all match the rule, in both RPCs`, matrixBad === 0 && matrixN === 3 * 2 * 2 * 3 * datesCases.length, { matrixBad, matrixN })
  // the answer's envelope
  await db.query(`update chat_site_settings set mode='actions', actions_scope='upcoming'`); await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(5), shift(9)]); await db.query(`delete from trip_chat_settings where trip_id=$1`, [TA])
  const sortK = o => Array.isArray(o) ? o.map(sortK) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortK(o[k])])) : o   // jsonb does not keep key order
  eq('get_chat_availability: the envelope for a participant (no trip row = inherit / inherit)', sortK((await call(2, `select get_chat_availability($1) j`, [TA])).r.j),
    sortK({ chat: true, actions: true, can_manage: false, can_force_on: false, trip: { chat: 'inherit', actions: 'inherit' }, site: { mode: 'actions', actions_scope: 'upcoming' } }))
  eq('get_chat_availability: organiser can_manage but not can_force_on; admin both', [(await call(1, `select get_chat_availability($1) j`, [TA])).r.j, (await call(10, `select get_chat_availability($1) j`, [TA])).r.j].map(j => [j.can_manage, j.can_force_on]), [[true, false], [true, true]])
  eq('an organiser of ANOTHER trip is only a participant here', (await call(1, `select get_chat_availability($1) j`, [TB])).r.j.can_manage, false)

  // ---- upcoming rule: SQL == tripIsUpcoming in flags.ts (30 days is upcoming, 31 is not; end_date wins over start_date; no dates is upcoming)
  {
    const flagsSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/trip-chat/flags.ts'), 'utf8')
    ok('flags.ts rule text unchanged (30 days, end ?? start, UTC today, no dates = upcoming)', /UPCOMING_GRACE_DAYS = 30\b/.test(flagsSrc) && flagsSrc.includes('const ref = end ?? start') && flagsSrc.includes('if (ref === null) return true')
      && flagsSrc.includes('now.getUTCDate() - UPCOMING_GRACE_DAYS') && flagsSrc.includes('return ref >= cutoff'))
    let ts = null
    try { ts = await import('file://' + path.join(ROOT, 'supabase/functions/trip-chat/flags.ts')) } catch { /* Node without type stripping (CI uses Node 20): the text check above covers it */ }
    const upSql = async (start, end) => (await q1(`select _chat_trip_upcoming($1::date,$2::date) u`, [start, end])).u
    const cases = []
    for (let n = -35; n <= 3; n++) { cases.push([shift(-60), shift(n)]); cases.push([shift(n), null]); cases.push([shift(n), shift(n + 4)]) }
    cases.push([null, null], [shift(-90), null], [null, shift(-31)], [null, shift(-30)])
    let bad = 0
    for (const [s, e] of cases) {
      const sql = await upSql(s, e), js = upcomingJs(s, e), real = ts ? ts.tripIsUpcoming({ start_date: s, end_date: e }, new Date()) : js
      if (sql !== js || sql !== real) { bad++; console.log('UPCOMING MISMATCH', { s, e, sql, js, real }) }
    }
    ok(`upcoming rule: ${cases.length} date pairs agree between _chat_trip_upcoming, the JS port${ts ? ' and the real tripIsUpcoming()' : ' (real tripIsUpcoming skipped: no TS import on this Node)'}`, bad === 0)
    eq('upcoming boundary: ended 30 days ago is upcoming, 31 days ago is not', [await upSql(null, shift(-30)), await upSql(null, shift(-31))], [true, false])
  }

  // ---- permissions
  const SET = (u, trip, chat, actions) => call(u, `select set_trip_chat_settings($1,$2,$3) j`, [trip, chat, actions])
  await db.query(`delete from trip_chat_settings where trip_id=$1`, [TA]); await db.query(`update chat_site_settings set mode='actions', actions_scope='upcoming'`)
  eq('get: no JWT -> auth; anon -> no EXECUTE (42501); a non-participant -> forbidden; a participant of another trip -> forbidden',
    [(await call(null, `select get_chat_availability($1)`, [TA])).e?.hint, (await call('anon', `select get_chat_availability($1)`, [TA])).e?.code, (await call(9, `select get_chat_availability($1)`, [TA])).e?.hint, (await call(3, `select get_chat_availability($1)`, [TB])).e?.hint], ['auth', '42501', 'forbidden', 'forbidden'])
  eq('get: an unknown trip -> forbidden for a member (existence is not leaked), not_found for an admin', [(await call(2, `select get_chat_availability($1)`, ['10000000-0000-0000-0000-0000000000ff'])).e?.hint, (await call(10, `select get_chat_availability($1)`, ['10000000-0000-0000-0000-0000000000ff'])).e?.hint], ['forbidden', 'not_found'])
  eq('get: a site admin who is not on the trip can read it', (await call(10, `select get_chat_availability($1) j`, [TA])).r?.j.chat, true)
  eq('set: no JWT -> auth; anon -> 42501', [(await SET(null, TA, 'off', null)).e?.hint, (await SET('anon', TA, 'off', null)).e?.code], ['auth', '42501'])
  eq('set: a participant cannot set anything; neither can an outsider; an organiser of another trip cannot touch this one', [(await SET(2, TA, 'off', null)).e?.hint, (await SET(9, TA, 'off', null)).e?.hint, (await SET(2, TA, null, 'off')).e?.hint, (await SET(3, TB, 'off', null)).e?.hint], ['forbidden', 'forbidden', 'forbidden', 'forbidden'])
  ok('set: ... and nothing was written by the refusals', (await qa(`select 1 from trip_chat_settings where trip_id=$1`, [TA])).length === 0)
  const o1 = await SET(1, TA, 'off', 'off')
  eq('set: the organiser can switch chat and actions off for their own trip; the answer reflects it', [o1.r?.j.trip, o1.r?.j.chat, o1.r?.j.actions, o1.r?.j.can_manage], [{ chat: 'off', actions: 'off' }, false, false, true])
  eq('set: the organiser can go back to inherit', (await SET(1, TA, 'inherit', 'inherit')).r?.j.trip, { chat: 'inherit', actions: 'inherit' })
  eq('set: the organiser may NOT force actions on (admin_only); nothing changes', [(await SET(1, TA, null, 'on')).e?.hint, (await q1(`select actions a from trip_chat_settings where trip_id=$1`, [TA])).a], ['admin_only', 'inherit'])
  eq('set: NULL means unchanged', [(await SET(1, TA, 'off', null)).r?.j.trip, (await SET(1, TA, null, 'off')).r?.j.trip], [{ chat: 'off', actions: 'inherit' }, { chat: 'off', actions: 'off' }])
  eq('set: invalid values -> invalid (22023)', [(await SET(1, TA, 'on', null)).e?.hint, (await SET(1, TA, null, 'maybe')).e?.code, (await SET(10, TA, 'maybe', null)).e?.code], ['invalid', '22023', '22023'])
  eq('set: unknown trip -> forbidden for an organiser, not_found for an admin', [(await SET(1, '10000000-0000-0000-0000-0000000000ff', 'off', null)).e?.hint, (await SET(10, '10000000-0000-0000-0000-0000000000ff', 'off', null)).e?.hint], ['forbidden', 'not_found'])
  const a1 = await SET(10, TA, 'inherit', 'on')
  eq('set: a site admin may force actions on (updated_by recorded); the answer says can_force_on', [a1.r?.j.trip, a1.r?.j.can_force_on, (await q1(`select updated_by::text u from trip_chat_settings where trip_id=$1`, [TA])).u], [{ chat: 'inherit', actions: 'on' }, true, U(10)])
  eq('set: an organiser can resend an admin\'s "on" unchanged (a form can submit all fields) ...', (await SET(1, TA, 'off', 'on')).r?.j.trip, { chat: 'off', actions: 'on' })
  eq('set: ... and can switch it off again', (await SET(1, TA, null, 'off')).r?.j.trip, { chat: 'off', actions: 'off' })
  await SET(10, TA, 'inherit', 'inherit')
  // old trip + force on
  await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(-100), shift(-90)])
  eq('forced on beats the upcoming scope for an ended trip (and only then)', [(await call(2, `select get_chat_availability($1) j`, [TA])).r.j.actions, (await SET(10, TA, null, 'on')).r.j.actions, (await SET(10, TA, null, 'inherit')).r.j.actions], [false, true, false])
  eq('... but site mode answers or off still wins over a forced-on trip', [(await call(10, `select admin_set_chat_settings('answers', null) j`)).r.j.trips.find(t => t.trip_id === TA).effective_actions, (await SET(10, TA, null, 'on')).r.j.actions], [false, false])
  await call(10, `select admin_set_chat_settings('actions', 'upcoming')`); await SET(10, TA, 'inherit', 'inherit')
  await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(5), shift(9)])
  // frozen trip
  await db.query(`update trips set settlement_snapshot='{"transactions":[]}' where id=$1`, [TA])
  eq('a FROZEN trip: the organiser can still change the assistant switches (not a money change)', [(await SET(1, TA, 'off', null)).r?.j.chat, (await SET(1, TA, 'inherit', null)).r?.j.chat], [false, true])
  await db.query(`update trips set settlement_snapshot=null where id=$1`, [TA])
  // a deactivated organiser is no organiser
  await db.query(`update trip_participants set active=false where trip_id=$1 and user_id=$2`, [TA, U(1)])
  eq('an inactive organiser cannot set', (await SET(1, TA, 'off', null)).e?.hint, 'forbidden')
  await db.query(`update trip_participants set active=true where trip_id=$1 and user_id=$2`, [TA, U(1)])

  // ---- admin RPCs
  eq('admin_get / admin_set: members, organisers, no JWT and anon are refused', [(await call(2, `select admin_get_chat_settings()`)).e?.hint, (await call(1, `select admin_set_chat_settings('off', null)`)).e?.hint, (await call(null, `select admin_get_chat_settings()`)).e?.hint, (await call('anon', `select admin_get_chat_settings()`)).e?.code, (await call('anon', `select admin_set_chat_settings('off', null)`)).e?.code], ['forbidden', 'forbidden', 'forbidden', '42501', '42501'])
  ok('... and the refused organiser changed nothing', (await q1(`select mode from chat_site_settings`)).mode === 'actions')
  const ag = (await call(10, `select admin_get_chat_settings() j`)).r.j
  eq('admin_get: site fields + every trip, newest first, with the documented keys', [ag.mode, ag.actions_scope, typeof ag.updated_at, ag.trips.map(t => t.name).filter(n => n.startsWith('Trip ')), Object.keys(ag.trips[0]).sort()],
    ['actions', 'upcoming', 'string', ['Trip B', 'Trip A'], ['actions', 'chat', 'effective_actions', 'effective_chat', 'end_date', 'name', 'start_date', 'trip_id']])
  const n1 = (await call(10, `select admin_set_chat_settings('answers', 'all') j`)).r.j
  eq('admin_set: changes both, returns the admin envelope, records who', [n1.mode, n1.actions_scope, (await q1(`select updated_by::text u from chat_site_settings`)).u], ['answers', 'all', U(10)])
  eq('admin_set: NULL leaves a field unchanged', [(await call(10, `select admin_set_chat_settings(null, 'upcoming') j`)).r.j.mode, (await call(10, `select admin_set_chat_settings('off', null) j`)).r.j.actions_scope], ['answers', 'upcoming'])
  eq('admin_set: invalid values refused (invalid)', [(await call(10, `select admin_set_chat_settings('loud', null)`)).e?.hint, (await call(10, `select admin_set_chat_settings(null, 'never')`)).e?.hint], ['invalid', 'invalid'])
  eq('mode off: every trip reads chat false / actions false, including a trip forced on; a member sees it through get_chat_availability', [(await call(10, `select admin_get_chat_settings() j`)).r.j.trips.every(t => !t.effective_chat && !t.effective_actions), (await call(2, `select get_chat_availability($1) j`, [TA])).r.j.chat], [true, false])
  await call(10, `select admin_set_chat_settings('actions', 'upcoming')`)
  // ---- confirming an already-proposed card is gated in SQL too (begin_chat_action replaced by this migration)
  {
    const mkCard = async () => (await db.query(`insert into chat_actions(trip_id,user_id,turn_id,kind,params,preview,basis,requires,expires_at) values ($1,$2,gen_random_uuid(),'add_todo','{"title":"Book ferry"}','{"line":"Add to-do"}','{"v":1}','tap',now() + interval '1 day') returning id::text`, [TA, U(2)])).rows[0].id
    const BEGIN2 = id => call(2, `select begin_chat_action($1) j`, [id])
    await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(5), shift(9)]); await call(10, `select admin_set_chat_settings('actions','upcoming')`); await SET(10, TA, 'inherit', 'inherit')
    const c1 = await mkCard()
    eq('begin_chat_action: allowed while the effective actions value is true', (await BEGIN2(c1)).r?.j.started, true)
    const refusals = []
    for (const [label, setup] of [
      ['trip actions off', () => SET(1, TA, null, 'off')], ['trip chat off', () => SET(1, TA, 'off', null)], ['site mode answers', () => call(10, `select admin_set_chat_settings('answers', null)`)],
      ['site mode off', () => call(10, `select admin_set_chat_settings('off', null)`)], ['ended trip, scope upcoming', () => db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(-100), shift(-90)])]]) {
      await call(10, `select admin_set_chat_settings('actions','upcoming')`); await SET(10, TA, 'inherit', 'inherit'); await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(5), shift(9)])
      const id = await mkCard(); await setup()
      const r = await BEGIN2(id)
      refusals.push([label, r.e?.hint, (await q1(`select status from chat_actions where id=$1`, [id])).status])
    }
    eq('begin_chat_action: refused (actions_off) and the card stays proposed when actions are switched off afterwards, by every route', refusals.map(r => r[0] + ':' + r[1] + ':' + r[2]),
      ['trip actions off', 'trip chat off', 'site mode answers', 'site mode off', 'ended trip, scope upcoming'].map(l => l + ':actions_off:proposed'))
    // an admin force-on lets an ended trip's card be confirmed again
    const idf = await mkCard(); await SET(10, TA, 'inherit', 'on')
    eq('begin_chat_action: an admin force-on beats the upcoming scope', (await BEGIN2(idf)).r?.j.started, true)
    eq('dismiss still works when actions are off', (await (async () => { const id = await mkCard(); await SET(10, TA, 'inherit', 'off'); return call(2, `select dismiss_chat_action($1) j`, [id]) })()).r?.j.dismissed, true)
    await call(10, `select admin_set_chat_settings('actions','upcoming')`); await SET(10, TA, 'inherit', 'inherit'); await db.query(`update trips set start_date=$2, end_date=$3 where id=$1`, [TA, shift(5), shift(9)])
  }
  // ---- an unchanged field (NULL) never overwrites: a stale form that only changes chat leaves an admin's force-on alone
  await SET(10, TA, 'inherit', 'on')
  eq('set: changing only chat (actions NULL) keeps an admin force-on', (await SET(1, TA, 'off', null)).r?.j.trip, { chat: 'off', actions: 'on' })
  await SET(10, TA, 'inherit', 'inherit')
  // cascade
  await db.query(`insert into trip_chat_settings(trip_id,chat,actions) values ($1,'off','on') on conflict (trip_id) do nothing`, [TB])
  await db.query(`delete from trips where id=$1`, [TB])
  eq('deleting a trip deletes its settings row', (await qa(`select 1 from trip_chat_settings where trip_id=$1`, [TB])).length, 0)
  // the final post-apply group 26 read-outs
  try { await db.exec(g26); pass++ } catch (e) { fail++; console.log('FAIL group 26 does not run (final):', e.message) }
}
