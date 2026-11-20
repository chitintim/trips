// ======================================================================================================================================
// OWN TRAVEL AND PLANS (20261201090000): set_my_travel + save_my_plan_item. trip_timeline_events keeps its four organiser-only policies; members write only through the two RPCs.
// Runs after 98_chat_settings (sorted order) and before 99_end. Stub: base.mjs (trip_timeline_events + the four live policies verbatim, timeline_event_category, places).
// ======================================================================================================================================
{
  const MIG9 = M + '20261201090000_own_travel_and_plans.sql'
  const TR = '10000000-0000-0000-0000-0000000000e1'    // trip 10 to 11 Dec 2026; U1 organiser; U2 confirmed (first name Alice); U3 pending; U4 declined; U21 inactive; U22 cancelled; U23 no status; U24 interested; U9 outsider
  const TR2 = '10000000-0000-0000-0000-0000000000e2'   // second trip: U2 is a plain participant, U1 not on it
  const pre = fs.readFileSync(path.join(ROOT, 'supabase/PRE_APPLY_CHECKS.sql'), 'utf8')
  const g27 = pre.slice(pre.indexOf('-- 27. Own travel and plans'))
  ok('PRE_APPLY group 27 exists', g27.length > 500)

  // ---- pre-flight fails loudly on the wrong state
  const bad = async (label, setup, want, undo) => {
    await db.exec(setup)
    let msg = null
    try { await db.exec(fs.readFileSync(MIG9, 'utf8')) } catch (e) { msg = e.message }
    await db.exec(undo)
    ok(label, !!msg && msg.includes(want), msg)
  }
  await bad('pre-flight: trip_timeline_events missing -> clear failure', 'ALTER TABLE trip_timeline_events RENAME TO trip_timeline_events_x', 'are missing', 'ALTER TABLE trip_timeline_events_x RENAME TO trip_timeline_events')
  await bad('pre-flight: event_date of another type -> clear failure', 'ALTER TABLE trip_timeline_events ALTER COLUMN event_date TYPE timestamptz', 'trip_timeline_events.event_date', 'ALTER TABLE trip_timeline_events ALTER COLUMN event_date TYPE date USING event_date::date')
  await bad('pre-flight: participant_ids of another type -> clear failure', 'ALTER TABLE trip_timeline_events ALTER COLUMN participant_ids TYPE text[] USING participant_ids::text[]', 'participant_ids must be uuid[]', 'ALTER TABLE trip_timeline_events ALTER COLUMN participant_ids TYPE uuid[] USING participant_ids::uuid[]')
  await bad('pre-flight: metadata not jsonb -> clear failure', 'ALTER TABLE trip_timeline_events ALTER COLUMN metadata DROP DEFAULT, ALTER COLUMN metadata TYPE json USING metadata::json', 'trip_timeline_events.metadata', `ALTER TABLE trip_timeline_events ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb, ALTER COLUMN metadata SET DEFAULT '{}'::jsonb`)
  await bad('pre-flight: a needed column missing (place_id) -> clear failure', 'ALTER TABLE trip_timeline_events RENAME COLUMN place_id TO place_x', 'trip_timeline_events.place_id', 'ALTER TABLE trip_timeline_events RENAME COLUMN place_x TO place_id')
  await bad('pre-flight: users.first_name missing -> clear failure', 'ALTER TABLE users RENAME COLUMN first_name TO first_x', 'users.first_name', 'ALTER TABLE users RENAME COLUMN first_x TO first_name')
  await bad('pre-flight: trip_participants.active missing -> clear failure', 'ALTER TABLE trip_participants RENAME COLUMN active TO active_x', 'trip_participants.active', 'ALTER TABLE trip_participants RENAME COLUMN active_x TO active')
  await bad('pre-flight: is_trip_participant missing -> clear failure', 'ALTER FUNCTION is_trip_participant(uuid, uuid) RENAME TO is_trip_participant_x', 'is_trip_participant(uuid, uuid) are missing', 'ALTER FUNCTION is_trip_participant_x(uuid, uuid) RENAME TO is_trip_participant')
  await bad('pre-flight: is_trip_organizer missing -> clear failure', 'ALTER FUNCTION is_trip_organizer(uuid, uuid) RENAME TO is_trip_organizer_x', 'is_trip_organizer(uuid, uuid)', 'ALTER FUNCTION is_trip_organizer_x(uuid, uuid) RENAME TO is_trip_organizer')
  await bad('pre-flight: RLS off on the table -> clear failure', 'ALTER TABLE trip_timeline_events DISABLE ROW LEVEL SECURITY', 'row level security is OFF', 'ALTER TABLE trip_timeline_events ENABLE ROW LEVEL SECURITY')
  await bad('pre-flight: enum label transfer missing -> clear failure', `ALTER TYPE timeline_event_category RENAME VALUE 'transfer' TO 'transfer_x'`, 'must contain flight, transfer, transport', `ALTER TYPE timeline_event_category RENAME VALUE 'transfer_x' TO 'transfer'`)
  await bad('pre-flight: category is plain text -> clear failure', `ALTER TABLE trip_timeline_events ALTER COLUMN category DROP DEFAULT, ALTER COLUMN category TYPE text USING category::text`, 'trip_timeline_events.category', `ALTER TABLE trip_timeline_events ALTER COLUMN category TYPE timeline_event_category USING category::timeline_event_category, ALTER COLUMN category SET DEFAULT 'other'`)
  await bad('pre-flight: set_my_travel taken with another signature -> clear failure', 'CREATE FUNCTION set_my_travel(x int) RETURNS int LANGUAGE sql AS $$ select 1 $$', 'different signature', 'DROP FUNCTION set_my_travel(int)')
  await bad('pre-flight: save_my_plan_item taken with another signature -> clear failure', 'CREATE FUNCTION save_my_plan_item(x text) RETURNS int LANGUAGE sql AS $$ select 1 $$', 'different signature', 'DROP FUNCTION save_my_plan_item(text)')
  await bad('pre-flight: a trigger on the table -> clear failure', 'CREATE FUNCTION tl_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER tl_t BEFORE INSERT ON trip_timeline_events FOR EACH ROW EXECUTE FUNCTION tl_trg()', 'a trigger has appeared', 'DROP TRIGGER tl_t ON trip_timeline_events; DROP FUNCTION tl_trg()')
  // the confirmation_status enum without the labels declined / cancelled (live: an enum); the rows are saved and put back
  await db.exec(`CREATE TABLE _cs_save AS SELECT trip_id, user_id, confirmation_status FROM trip_participants; CREATE TYPE cs_bad AS ENUM ('pending','confirmed'); ALTER TABLE trip_participants ALTER COLUMN confirmation_status TYPE cs_bad USING NULL`)
  {
    let msg = null
    try { await db.exec(fs.readFileSync(MIG9, 'utf8')) } catch (e) { msg = e.message }
    await db.exec(`ALTER TABLE trip_participants ALTER COLUMN confirmation_status TYPE text USING NULL; UPDATE trip_participants tp SET confirmation_status = s.confirmation_status FROM _cs_save s WHERE s.trip_id = tp.trip_id AND s.user_id = tp.user_id; DROP TABLE _cs_save; DROP TYPE cs_bad`)
    ok('pre-flight: confirmation_status enum without declined / cancelled -> clear failure', !!msg && msg.includes('declined and cancelled'), msg)
  }
  eq('nothing was created by the failed pre-flights', (await qa(`select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('set_my_travel','save_my_plan_item','_own_travel_date','_own_clean','_own_ctrl','_own_is_travel')`)).length, 0)

  // ---- group 27 a to e run before the apply
  eq('group 27a (pre-apply): the names are free', (await qa(`select 1 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('set_my_travel','save_my_plan_item','_own_travel_date')`)).length, 0)
  eq('group 27b (pre-apply): exactly the four live policies', (await qa(`select policyname, cmd from pg_policies where schemaname='public' and tablename='trip_timeline_events' order by policyname`)),
    [{ policyname: 'organizers_delete_timeline', cmd: 'DELETE' }, { policyname: 'organizers_insert_timeline', cmd: 'INSERT' }, { policyname: 'organizers_update_timeline', cmd: 'UPDATE' }, { policyname: 'participants_view_timeline', cmd: 'SELECT' }])
  try { await db.exec(g27.slice(0, g27.indexOf('-- 27f.'))); pass++ } catch (e) { fail++; console.log('FAIL group 27 (a-e) does not run pre-apply:', e.message) }
  const policies0 = JSON.stringify(await qa(`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' and tablename='trip_timeline_events' order by policyname`))

  // ---- fixtures
  await db.query(`insert into trips(id,name,created_by,start_date,end_date) values ($1,'Own travel A',$3,'2026-12-10','2026-12-11'),($2,'Own travel B',$3,'2026-12-10','2026-12-11')`, [TR, TR2, U(11)])
  await db.query(`insert into trip_participants(trip_id,user_id,role,active,confirmation_status) values
    ($1,$2,'organizer',true,'confirmed'),($1,$3,'participant',true,'confirmed'),($1,$4,'participant',true,'pending'),($1,$5,'participant',true,'declined'),($1,$6,'participant',false,'confirmed'),
    ($1,$7,'participant',true,'cancelled'),($1,$8,'participant',true,NULL),($1,$9,'participant',true,'interested'),($10,$3,'participant',true,'confirmed')`, [TR, U(1), U(2), U(3), U(4), U(21), U(22), U(23), U(24), TR2])
  await db.query(`update users set first_name='Alice' where id=$1`, [U(2)])
  await db.query(`update users set first_name=NULL, full_name='  Bob Builder ' where id=$1`, [U(3)])
  await db.query(`update users set first_name='', full_name=NULL where id=$1`, [U(23)])
  const afBefore = (await q1(`select count(*)::int n from activity_feed`)).n
  await applyFile(MIG9, 'MIG9')
  await applyFile(MIG9, 'MIG9 re-apply')
  eq('the table policies are unchanged by the migration (same four, same text)', JSON.stringify(await qa(`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' and tablename='trip_timeline_events' order by policyname`)), policies0)
  try { await db.exec(g27); pass++ } catch (e) { fail++; console.log('FAIL group 27 does not run post-apply:', e.message) }
  eq('group 27f (post-apply): two RPCs security definer, volatile, authenticated only; helper for nobody', await qa(`select p.proname, p.prosecdef d, p.provolatile v, coalesce(p.proconfig::text,'') c, has_function_privilege('anon', p.oid,'EXECUTE') a, has_function_privilege('authenticated', p.oid,'EXECUTE') s
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('set_my_travel','save_my_plan_item','_own_travel_date') order by 1`),
    [{ proname: '_own_travel_date', d: false, v: 'i', c: '{"search_path=public, pg_temp"}', a: false, s: false }, { proname: 'save_my_plan_item', d: true, v: 'v', c: '{"search_path=public, pg_temp"}', a: false, s: true }, { proname: 'set_my_travel', d: true, v: 'v', c: '{"search_path=public, pg_temp"}', a: false, s: true }])
  eq('PUBLIC cannot execute either RPC (no leftover default grant)', await qa(`select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('set_my_travel','save_my_plan_item') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) order by 1`), [])

  // ---- helpers
  // the strict "own travel row" ids as a fresh client would have loaded them (known = 'auto'), or an explicit list / null
  const ownIds = async (u, trip) => (await qa(`select id::text from trip_timeline_events where trip_id=$1 and participant_ids = ARRAY[$2::uuid] and source_option_id is null and public._own_is_travel(metadata)`, [trip, U(u)])).map(x => x.id)
  const TRAVEL = async (u, legs, trip = TR, known = 'auto') => call(u, `select set_my_travel($1, $2::jsonb, $3::uuid[]) j`, [trip, legs === null ? null : JSON.stringify(legs), known === 'auto' ? (typeof u === 'number' ? await ownIds(u, trip) : []) : known])
  const PLAN = (u, id, item, trip = TR) => call(u, `select save_my_plan_item($1, $2, $3::jsonb) j`, [trip, id, item === null ? null : JSON.stringify(item)])
  const arrival = (o = {}) => ({ direction: 'arrival', leg: 'main', date: '2026-12-08', time: '10:00', ...o })
  const departure = (o = {}) => ({ direction: 'departure', leg: 'main', date: '2026-12-13', time: '01:55', ...o })
  const extra = (o = {}) => ({ direction: 'arrival', leg: 'extra', title: 'Flight to Tokyo', date: '2026-12-04', ...o })
  const rowsOf = (u, trip = TR) => qa(`select id, title, category::text cat, event_date::text d, start_time::text t, all_day, participant_ids::text[] p, created_by::text cb, metadata from trip_timeline_events where trip_id=$1 and participant_ids = ARRAY[$2::uuid] and metadata->>'travel_details'='true' order by event_date, title`, [trip, U(u)])
  const hint = x => x.e?.hint
  const sk = o => Object.fromEntries(Object.entries(o).sort())   // jsonb returns keys in its own order
  const MSG = {
    not_participant: 'Only people who are coming on this trip can add travel.', bad_legs: 'Those travel details don\'t look right. Check them and try again.', too_many: 'You can have one arrival, one departure and up to 3 extra journeys each way.',
    bad_date: 'That date looks wrong. Check the year.', bad_time: 'That time doesn\'t look right. Use hours and minutes, like 21:30.', bad_ref: 'The flight or train number is too long (12 characters at most).',
    bad_airport: 'The airport code should be three letters, like LHR.', bad_title: 'Extra journeys need a name of 1 to 60 characters, like Flight to Tokyo.',
    bad_set_off: 'Setting off must be on or up to 3 days before arriving.', bad_home: 'Getting home must be on or up to 3 days after leaving.', bad_id: 'That travel entry isn\'t yours to change. Close this and try again.',
  }
  const refuses = async (label, x, h, code = '22023', msgs = MSG) => {
    ok(label + ' refused', !!x.e, x.r)
    if (x.e) { eq(label + ' hint', x.e.hint, h); eq(label + ' code', x.e.code, code); if (msgs[h] && h !== 'bad_title') eq(label + ' message', x.e.message, msgs[h]) }
  }

  // ---- 1. a plain confirmed member saves travel outside the trip dates (start-2, end+2) and the title comes from the first name
  let r = await TRAVEL(2, [arrival({ flight_ref: ' JL044 ', airport_code: 'lhr', set_off_date: '2026-12-07', set_off_time: '21:00' }), departure()])
  ok('1. member saves arrival start-2 and departure end+2', !!r.r?.j && r.r.j.legs.length === 2, r)
  let mine = await rowsOf(2)
  eq('1. two rows, participant_ids = [caller], created_by = caller, titles from the first name', mine.map(x => [x.title, x.p, x.cb]), [['Alice arrives', [U(2)], U(2)], ['Alice departs', [U(2)], U(2)]])
  eq('1. dates and times: 8 Dec 10:00 and 13 Dec 01:55, not all day', mine.map(x => [x.d, x.t, x.all_day]), [['2026-12-08', '10:00:00', false], ['2026-12-13', '01:55:00', false]])
  eq('1. categories: flight when there is a ref, transfer for a main leg without one', mine.map(x => x.cat), ['flight', 'transfer'])
  eq('1. metadata built on the server from validated fields (ref trimmed, airport upper-cased), nothing else', mine.map(x => sk(x.metadata)), [
    { travel_details: true, direction: 'arrival', leg: 'main', flight_ref: 'JL044', airport_code: 'LHR', set_off_date: '2026-12-07', set_off_time: '21:00' }, { travel_details: true, direction: 'departure', leg: 'main' }].map(sk))
  eq('1. the result lists {id, direction, leg} in the order sent', r.r.j.legs.map(l => [l.direction, l.leg, l.id === mine.find(m => m.title === (l.direction === 'arrival' ? 'Alice arrives' : 'Alice departs')).id]), [['arrival', 'main', true], ['departure', 'main', true]])
  const arrId = mine[0].id, depId = mine[1].id

  // ---- 2. an extra leg 6 days before the trip, ids kept
  r = await TRAVEL(2, [{ id: arrId, ...arrival({ flight_ref: 'JL044', airport_code: 'LHR', set_off_date: '2026-12-07', set_off_time: '21:00' }) }, { id: depId, ...departure() }, extra()])
  ok('2. extra leg start-6 saved', !!r.r?.j && r.r.j.legs.length === 3 && r.r.j.legs[0].id === arrId && r.r.j.legs[1].id === depId, r)
  mine = await rowsOf(2)
  const extId = mine.find(x => x.title === 'Flight to Tokyo')?.id
  eq('2. the extra leg: all day, category transport, its own title', mine.filter(x => x.title === 'Flight to Tokyo').map(x => [x.d, x.all_day, x.cat, x.metadata.leg]), [['2026-12-04', true, 'transport', 'extra']])
  eq('2. still exactly 3 own rows (the existing ids were updated, not duplicated)', mine.length, 3)

  // ---- 3. saving without the departure deletes it; saving only a changed arrival drops the cleared set-off
  r = await TRAVEL(2, [{ id: arrId, ...arrival({ flight_ref: 'JL044', airport_code: 'LHR' }) }, { id: extId, ...extra() }])
  mine = await rowsOf(2)
  ok('3. omitted departure is deleted', !!r.r?.j && mine.length === 2 && !mine.some(x => x.id === depId), r)
  ok('3. the cleared set-off is gone from the metadata', !('set_off_date' in mine.find(x => x.id === arrId).metadata))
  // a failing save changes nothing (atomic): one good leg, one bad one
  r = await TRAVEL(2, [{ id: arrId, ...arrival({ date: '2026-12-09' }) }, departure({ date: '2025-01-01' })])
  await refuses('3. a bad second leg', r, 'bad_date')
  eq('3. nothing was changed or deleted by the refused save', (await rowsOf(2)).map(x => [x.id, x.d]), mine.map(x => [x.id, x.d]))

  // ---- 4. other people's rows by id: bad_id, never touched
  const orgTravel = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-09','Org travel','transfer',ARRAY[$2::uuid],'{"travel_details":true,"direction":"arrival"}',$2) returning id`, [TR, U(1)])).id
  const group = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Group dinner','dining',ARRAY[$2::uuid,$3::uuid],'{}',$2) returning id`, [TR, U(1), U(2)])).id
  const groupAll = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Group ski','activity',NULL,'{}',$2) returning id`, [TR, U(1)])).id
  const groupTravel = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-08','Group shuttle','transfer',ARRAY[$2::uuid,$3::uuid],'{"travel_details":true}',$2) returning id`, [TR, U(1), U(2)])).id
  const orgPlan = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Org plan','dining',ARRAY[$2::uuid],'{}',$2) returning id`, [TR, U(1)])).id
  const snapOthers = async () => JSON.stringify(await qa(`select id, title, event_date::text, participant_ids::text[], metadata, created_by::text from trip_timeline_events where id = any($1::uuid[]) order by id`, [[orgTravel, group, groupAll, groupTravel, orgPlan]]))
  const others0 = await snapOthers()
  for (const [label, id] of [['an organiser\'s own travel row', orgTravel], ['an organiser-authored group event (participant_ids includes the caller)', group], ['an organiser-authored event for everyone', groupAll], ['a group travel row (the caller is one of several participants)', groupTravel], ['an organiser plan row', orgPlan]]) {
    await refuses('4. travel RPC by id: ' + label, await TRAVEL(2, [{ id, ...arrival() }]), 'bad_id', '22023')
  }
  await refuses('4. a made-up id', await TRAVEL(2, [{ id: '99999999-9999-9999-9999-999999999999', ...arrival() }]), 'bad_id')
  await refuses('4. an id that is not a uuid', await TRAVEL(2, [{ id: 'not-an-id', ...arrival() }]), 'bad_id')
  await refuses('4. the same id twice', await TRAVEL(2, [{ id: arrId, ...arrival() }, { id: arrId, ...arrival() }]), 'bad_id')
  await refuses('4. an id of another person\'s row in another trip the caller belongs to', await TRAVEL(2, [{ id: arrId, ...arrival() }], TR2), 'bad_id')
  eq('4. none of the others\' rows changed or was deleted (also by the successful saves above)', await snapOthers(), others0)
  r = await TRAVEL(2, [{ id: arrId, ...arrival(), participant_ids: [U(1)] }])
  await refuses('4. participant_ids in a leg (to hand a row to someone else)', r, 'bad_legs')
  r = await TRAVEL(2, [{ id: arrId, ...arrival(), user_id: U(1) }])
  await refuses('4. user_id in a leg', r, 'bad_legs')
  r = await TRAVEL(2, [{ id: arrId, ...arrival(), created_by: U(1) }])
  await refuses('4. created_by in a leg', r, 'bad_legs')
  r = await TRAVEL(2, [{ id: arrId, ...arrival(), metadata: { travel_details: false } }])
  await refuses('4. a metadata blob in a leg', r, 'bad_legs')
  r = await TRAVEL(2, [{ id: arrId, ...arrival(), category: 'accommodation' }])
  await refuses('4. a category in a leg', r, 'bad_legs')
  eq('4. every own row still has participant_ids = [caller]', (await rowsOf(2)).every(x => x.p.length === 1 && x.p[0] === U(2)), true)

  // ---- 5. dates: wrong year refused, anything within 366 days of the trip start accepted
  for (const [label, d] of [['the year before', '2025-12-08'], ['two years on', '2028-12-10'], ['a nonsense day', '2026-02-30'], ['US format', '12/08/2026'], ['no date', null], ['367 days before the start', '2025-12-08'], ['367 days after the start', '2027-12-12']]) {
    await refuses('5. ' + label, await TRAVEL(2, [arrival({ date: d })]), 'bad_date')
  }
  await refuses('5. a date as a number', await TRAVEL(2, [arrival({ date: 20261208 })]), 'bad_legs')
  for (const [label, d] of [['start-6', '2026-12-04'], ['start-7', '2026-12-03'], ['start-2', '2026-12-08'], ['end+2', '2026-12-13'], ['end+7', '2026-12-18'], ['end+8', '2026-12-19'], ['365 days after the start', '2027-12-10'], ['366 days before the start', '2025-12-09']]) {
    const x = await TRAVEL(2, [arrival({ date: d, set_off_date: undefined })])
    ok('5. accepted: ' + label, !!x.r?.j && x.r.j.legs.length === 1, x)
  }
  eq('5. a one-leg save replaced the whole set (the extra leg is gone)', (await rowsOf(2)).length, 1)

  // ---- 6. everything else in the shape table
  await refuses('6. p_legs null', await TRAVEL(2, null), 'bad_legs')
  await refuses('6. p_legs an object', await TRAVEL(2, { direction: 'arrival' }), 'bad_legs')
  await refuses('6. p_legs a string', await TRAVEL(2, 'arrival'), 'bad_legs')
  await refuses('6. 9 legs', await TRAVEL(2, Array.from({ length: 9 }, (_, i) => extra({ title: 'T' + i }))), 'bad_legs')
  await refuses('6. a leg that is not an object', await TRAVEL(2, ['arrival']), 'bad_legs')
  await refuses('6. unknown direction', await TRAVEL(2, [arrival({ direction: 'sideways' })]), 'bad_legs')
  await refuses('6. unknown leg kind', await TRAVEL(2, [arrival({ leg: 'side' })]), 'bad_legs')
  await refuses('6. a field of the wrong type', await TRAVEL(2, [arrival({ flight_ref: 5 })]), 'bad_legs')
  ok('6. 8 legs is the limit (and is allowed when the per-direction counts fit)', !!(await TRAVEL(2, [arrival(), departure(), ...[1, 2, 3].map(i => extra({ title: 'In ' + i })), ...[1, 2, 3].map(i => extra({ direction: 'departure', title: 'Out ' + i }))])).r?.j)
  await refuses('6. two main arrivals', await TRAVEL(2, [arrival(), arrival({ date: '2026-12-09' })]), 'too_many')
  await refuses('6. two main departures', await TRAVEL(2, [departure(), departure()]), 'too_many')
  await refuses('6. four extra legs one way', await TRAVEL(2, [1, 2, 3, 4].map(i => extra({ title: 'X' + i }))), 'too_many')
  ok('6. one main plus three extra each way is fine', !!(await TRAVEL(2, [arrival(), departure(), ...[1, 2, 3].map(i => extra({ title: 'A' + i })), ...[1, 2, 3].map(i => extra({ direction: 'departure', title: 'D' + i }))])).r?.j)
  await refuses('6. bad time 25:00', await TRAVEL(2, [arrival({ time: '25:00' })]), 'bad_time')
  await refuses('6. bad time 9:5', await TRAVEL(2, [arrival({ time: '9:5' })]), 'bad_time')
  await refuses('6. bad time with seconds', await TRAVEL(2, [arrival({ time: '10:00:00' })]), 'bad_time')
  ok('6. null and empty time mean all day', (await TRAVEL(2, [arrival({ time: null })])).r?.j && (await rowsOf(2))[0].all_day === true && !!(await TRAVEL(2, [arrival({ time: '' })])).r?.j)
  await refuses('6. a 13 character flight ref', await TRAVEL(2, [arrival({ flight_ref: 'ABCDEFGHIJKLM' })]), 'bad_ref')
  ok('6. a 12 character flight ref', !!(await TRAVEL(2, [arrival({ flight_ref: 'ABCDEFGHIJKL' })])).r?.j)
  for (const a of ['LH', 'LHRX', '123', 'L H', 'LH1']) await refuses('6. airport "' + a + '"', await TRAVEL(2, [arrival({ airport_code: a })]), 'bad_airport')
  ok('6. airport "  lgw " is trimmed and upper-cased', !!(await TRAVEL(2, [arrival({ airport_code: '  lgw ' })])).r?.j && (await rowsOf(2))[0].metadata.airport_code === 'LGW')
  await refuses('6. an extra leg without a title', await TRAVEL(2, [extra({ title: null })]), 'bad_title')
  await refuses('6. an extra leg with a blank title', await TRAVEL(2, [extra({ title: '   ' })]), 'bad_title')
  await refuses('6. an extra leg with a 61 character title', await TRAVEL(2, [extra({ title: 'x'.repeat(61) })]), 'bad_title')
  ok('6. an extra leg with a 60 character title', !!(await TRAVEL(2, [extra({ title: ' ' + 'x'.repeat(60) + ' ' })])).r?.j)
  await refuses('6. a main leg with a title', await TRAVEL(2, [arrival({ title: 'My arrival' })]), 'bad_title')
  await refuses('6. set-off 4 days before', await TRAVEL(2, [arrival({ set_off_date: '2026-12-04' })]), 'bad_set_off')
  await refuses('6. set-off after the arrival', await TRAVEL(2, [arrival({ set_off_date: '2026-12-09' })]), 'bad_set_off')
  await refuses('6. set-off time without a set-off date', await TRAVEL(2, [arrival({ set_off_time: '21:00' })]), 'bad_set_off')
  await refuses('6. set-off date that is not a date', await TRAVEL(2, [arrival({ set_off_date: 'yesterday' })]), 'bad_set_off')
  await refuses('6. set-off with a bad time', await TRAVEL(2, [arrival({ set_off_date: '2026-12-07', set_off_time: '7pm' })]), 'bad_time')
  for (const d of ['2026-12-08', '2026-12-07', '2026-12-05']) ok('6. set-off ' + d + ' (0 to 3 days before) accepted', !!(await TRAVEL(2, [arrival({ set_off_date: d })])).r?.j)
  await refuses('6. get-home 4 days after', await TRAVEL(2, [departure({ home_date: '2026-12-17' })]), 'bad_home')
  await refuses('6. get-home before the departure', await TRAVEL(2, [departure({ home_date: '2026-12-12' })]), 'bad_home')
  await refuses('6. get-home time without a date', await TRAVEL(2, [departure({ home_time: '09:00' })]), 'bad_home')
  for (const d of ['2026-12-13', '2026-12-14', '2026-12-16']) ok('6. get-home ' + d + ' (0 to 3 days after) accepted', !!(await TRAVEL(2, [departure({ home_date: d, home_time: '09:00' })])).r?.j)
  await refuses('6. set-off on a departure leg', await TRAVEL(2, [departure({ set_off_date: '2026-12-12' })]), 'bad_legs')
  await refuses('6. get-home on an arrival leg', await TRAVEL(2, [arrival({ home_date: '2026-12-09' })]), 'bad_legs')
  await refuses('6. an other end on an extra leg', await TRAVEL(2, [extra({ set_off_date: '2026-12-03' })]), 'bad_legs')
  r = await TRAVEL(2, [departure({ home_date: '2026-12-14', home_time: '09:00', flight_ref: 'BA1' })])
  eq('6. the metadata of a departure with a get-home end and a ref', [sk((await rowsOf(2))[0].metadata), (await rowsOf(2))[0].cat], [sk({ travel_details: true, direction: 'departure', leg: 'main', flight_ref: 'BA1', home_date: '2026-12-14', home_time: '09:00' }), 'flight'])
  eq('6. a leg with no leg key is a main leg', ((await TRAVEL(2, [{ direction: 'arrival', date: '2026-12-08' }])).r?.j.legs[0]).leg, 'main')
  eq('6. the title falls back to the first word of the full name, then to Someone', [
    ((await TRAVEL(3, [arrival()])).r?.j, (await rowsOf(3))[0].title), ((await TRAVEL(23, [departure()])).r?.j, (await rowsOf(23))[0].title)], ['Bob arrives', 'Someone departs'])
  ok('6. empty list on a person with no rows is fine', (await TRAVEL(24, [])).r?.j.legs.length === 0)

  // ---- 7. who may call
  await refuses('7. outsider (not on the trip)', await TRAVEL(9, [arrival()]), 'not_participant', '42501')
  await refuses('7. declined', await TRAVEL(4, [arrival()]), 'not_participant', '42501')
  await refuses('7. cancelled', await TRAVEL(22, [arrival()]), 'not_participant', '42501')
  await refuses('7. inactive', await TRAVEL(21, [arrival()]), 'not_participant', '42501')
  await refuses('7. site admin who is not on the roster', await TRAVEL(10, [arrival()]), 'not_participant', '42501')
  await refuses('7. the trip creator who is not on the roster', await TRAVEL(11, [arrival()]), 'not_participant', '42501')
  await refuses('7. on another trip only', await TRAVEL(1, [arrival()], TR2), 'not_participant', '42501')
  await refuses('7. an unknown trip', await TRAVEL(2, [arrival()], '99999999-9999-9999-9999-999999999999'), 'not_participant', '42501')
  r = await call('anon', `select set_my_travel($1, '[]'::jsonb, NULL::uuid[]) j`, [TR]); eq('7. anon has no execute right (42501)', r.e?.code, '42501')
  r = await call(null, `select set_my_travel($1, '[]'::jsonb, NULL::uuid[]) j`, [TR]); eq('7. no JWT at all: Not authenticated (42501, not_authenticated)', [r.e?.code, r.e?.hint, r.e?.message], ['42501', 'not_authenticated', 'Not authenticated'])
  eq('7. refused callers wrote nothing and deleted nothing', [(await rowsOf(4)).length, (await rowsOf(9)).length, (await rowsOf(22)).length, (await rowsOf(21)).length], [0, 0, 0, 0])
  for (const s of ['pending', 'interested', 'conditional', 'waitlist', 'confirmed']) {
    await db.query(`update trip_participants set confirmation_status=$2 where trip_id=$1 and user_id=$3`, [TR, s, U(24)])
    ok('7. status ' + s + ' may add travel', !!(await TRAVEL(24, [arrival()])).r?.j)
  }
  for (const s of ['declined', 'cancelled']) {
    await db.query(`update trip_participants set confirmation_status=$2 where trip_id=$1 and user_id=$3`, [TR, s, U(24)])
    await refuses('7. status ' + s + ' (after having rows) may not even clear them', await TRAVEL(24, []), 'not_participant', '42501')
  }
  ok('7. a pending person (U3) and a person with no status (U23) could save above', (await rowsOf(3)).length === 1 && (await rowsOf(23)).length === 1)
  await db.query(`update trip_participants set confirmation_status='confirmed' where trip_id=$1 and user_id=$2`, [TR, U(24)])
  await TRAVEL(24, [])

  // ---- 8. direct writes by a participant are still refused by RLS (the policies are the live ones)
  await TRAVEL(2, [arrival(), departure()])
  const myIds = (await rowsOf(2)).map(x => x.id)
  await fails('8. direct INSERT by a participant', 2, `insert into trip_timeline_events(trip_id,event_date,title,created_by,participant_ids) values ($1,'2026-12-10','Sneaky',$2,ARRAY[$2::uuid])`, [TR, U(2)], { code: '42501' })
  eq('8. direct UPDATE by a participant touches no row (own travel row, group event)', [(await exec(2, `update trip_timeline_events set title='hacked' where id = any($1::uuid[]) returning id`, [[...myIds, group, groupAll]])).rows.length, (await q1(`select count(*)::int n from trip_timeline_events where title='hacked'`)).n], [0, 0])
  eq('8. direct DELETE by a participant touches no row', [(await exec(2, `delete from trip_timeline_events where id = any($1::uuid[]) returning id`, [[...myIds, group, groupAll]])).rows.length, (await q1(`select count(*)::int n from trip_timeline_events where id = any($1::uuid[])`, [[...myIds, group, groupAll]])).n], [0, 4])
  await fails('8. direct INSERT by a non-participant', 9, `insert into trip_timeline_events(trip_id,event_date,title,created_by) values ($1,'2026-12-10','Sneaky',$2)`, [TR, U(9)], { code: '42501' })
  eq('8. the participant can still READ the plan (participants_view_timeline)', (await exec(2, `select count(*)::int n from trip_timeline_events where trip_id=$1`, [TR])).rows[0].n > 5, true)
  eq('8. an outsider reads nothing', (await exec(9, `select count(*)::int n from trip_timeline_events where trip_id=$1`, [TR])).rows[0].n, 0)

  // ---- 9. an organiser creates a travel row for the member directly; the member's RPC updates it and then clears it
  r = await exec(1, `insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-13','Made for Alice','flight',ARRAY[$2::uuid],'{"travel_details":true,"direction":"departure","weird":"x"}',$3) returning id`, [TR, U(2), U(1)])
  const madeId = r.rows[0].id
  ok('9. the organiser\'s direct insert works', !!madeId)
  r = await TRAVEL(2, [{ id: madeId, ...departure({ date: '2026-12-14' }) }])
  mine = await rowsOf(2)
  ok('9. the member\'s RPC updates the organiser-made row in place', !!r.r?.j && mine.length === 1 && mine[0].id === madeId && mine[0].d === '2026-12-14' && mine[0].title === 'Alice departs' && mine[0].cb === U(1) && !('weird' in mine[0].metadata), mine)
  r = await TRAVEL(2, [])
  eq('9. clearing deletes it', [r.r?.j, (await rowsOf(2)).length], [{ legs: [] }, 0])
  eq('9. clearing deleted nothing that is not the member\'s own', await snapOthers(), others0)
  ok('9. travel rows of other trips are not touched by a save here', (await q1(`select count(*)::int n from trip_timeline_events where trip_id = $1`, [TR2])).n === 0)

  // ---- 10. the member's own plan items: insert, update, delete
  r = await PLAN(2, null, { title: '  Dinner in Tokyo ', date: '2026-12-04', start_time: '19:30', notes: ' table for two ', category: 'dining', location: ' Shibuya ' })
  const itemId = r.r?.j?.id
  ok('10. insert returns {id}', !!itemId, r)
  eq('10. the inserted row: own, just me, trimmed, timed, no metadata', await qa(`select title, event_date::text d, start_time::text t, all_day, description, category::text c, location, participant_ids::text[] p, created_by::text cb, source_option_id, metadata from trip_timeline_events where id=$1`, [itemId]),
    [{ title: 'Dinner in Tokyo', d: '2026-12-04', t: '19:30:00', all_day: false, description: 'table for two', c: 'dining', location: 'Shibuya', p: [U(2)], cb: U(2), source_option_id: null, metadata: {} }])
  r = await PLAN(2, itemId, { title: 'Late dinner', date: '2026-12-05', start_time: '20:30', end_time: '22:00' })
  eq('10. update returns the same id and rewrites the row (omitted fields cleared)', [r.r?.j?.id, await qa(`select title, event_date::text d, end_time::text e, description, location, category::text c, participant_ids::text[] p, created_by::text cb from trip_timeline_events where id=$1`, [itemId])],
    [itemId, [{ title: 'Late dinner', d: '2026-12-05', e: '22:00:00', description: null, location: null, c: 'other', p: [U(2)], cb: U(2) }]])
  r = await PLAN(2, null, { title: 'All day thing', date: '2026-12-20' })
  eq('10. no start time = all day; dates outside the trip window are accepted', await qa(`select all_day, event_date::text d from trip_timeline_events where id=$1`, [r.r?.j?.id]), [{ all_day: true, d: '2026-12-20' }])
  const allDayId = r.r.j.id
  r = await PLAN(2, itemId, null)
  eq('10. delete (SQL null) returns {id: null} and removes the row', [r.r?.j, (await qa(`select 1 from trip_timeline_events where id=$1`, [itemId])).length], [{ id: null }, 0])
  r = await call(2, `select save_my_plan_item($1, $2, 'null'::jsonb) j`, [TR, allDayId])
  eq('10. delete (JSON null) works too', [r.r?.j, (await qa(`select 1 from trip_timeline_events where id=$1`, [allDayId])).length], [{ id: null }, 0])
  await refuses('10. delete without an id', await PLAN(2, null, null), 'bad_item')

  // ---- 11. not_yours: the organiser's rows, group events, travel rows, rows from options, other people's rows, other trips
  const yours = 'You can only change plans that you added for yourself.'
  const own = (await PLAN(2, null, { title: 'Mine', date: '2026-12-10' })).r.j.id
  const fromOption = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by,source_option_id) values ($1,'2026-12-10','From a decision','dining',ARRAY[$2::uuid],'{}',$2,gen_random_uuid()) returning id`, [TR, U(2)])).id
  const withOthers = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Mine and Bob''s','dining',ARRAY[$2::uuid,$3::uuid],'{}',$2) returning id`, [TR, U(2), U(3)])).id
  const ownTravel = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Own travel by hand','flight',ARRAY[$2::uuid],'{"travel_details":true}',$2) returning id`, [TR, U(2)])).id
  const othersAll = JSON.stringify(await qa(`select id, title, event_date::text, participant_ids::text[], metadata, source_option_id from trip_timeline_events where id = any($1::uuid[]) order by id`, [[orgPlan, group, groupAll, orgTravel, fromOption, withOthers, ownTravel, groupTravel]]))
  const tryAll = async (label, u, id, trip = TR) => {
    for (const item of [{ title: 'Taken over', date: '2026-12-10' }, null]) {
      const x = await PLAN(u, id, item, trip)
      ok(`11. ${label} (${item ? 'update' : 'delete'}) refused as not_yours`, !!x.e && x.e.hint === 'not_yours' && x.e.code === '42501' && x.e.message === yours, x)
    }
  }
  await tryAll('an organiser plan row', 2, orgPlan)
  await tryAll('an organiser-authored group event', 2, group)
  await tryAll('an organiser event for everyone', 2, groupAll)
  await tryAll('an organiser travel row', 2, orgTravel)
  await tryAll('a row that came from a decision (source_option_id)', 2, fromOption)
  await tryAll('a row the caller created but that lists other people', 2, withOthers)
  await tryAll('the caller\'s own travel row (travel is not a plan item)', 2, ownTravel)
  await tryAll('a group travel row', 2, groupTravel)
  await tryAll('someone else\'s own plan row', 3, own)
  await tryAll('own row, but the trip given is another trip', 2, own, TR2)
  await tryAll('a made-up id', 2, '99999999-9999-9999-9999-999999999999')
  eq('11. none of those rows changed', JSON.stringify(await qa(`select id, title, event_date::text, participant_ids::text[], metadata, source_option_id from trip_timeline_events where id = any($1::uuid[]) order by id`, [[orgPlan, group, groupAll, orgTravel, fromOption, withOthers, ownTravel, groupTravel]])), othersAll)
  eq('11. the organiser rows are all still there', (await qa(`select 1 from trip_timeline_events where id = any($1::uuid[])`, [[orgPlan, group, groupAll, orgTravel, groupTravel]])).length, 5)
  await refuses('11. unknown key participant_ids', await PLAN(2, null, { title: 'x', date: '2026-12-10', participant_ids: [U(1)] }), 'bad_item')
  await refuses('11. unknown key created_by', await PLAN(2, null, { title: 'x', date: '2026-12-10', created_by: U(1) }), 'bad_item')
  await refuses('11. unknown key metadata', await PLAN(2, null, { title: 'x', date: '2026-12-10', metadata: { travel_details: true } }), 'bad_item')
  await refuses('11. unknown key source_option_id', await PLAN(2, null, { title: 'x', date: '2026-12-10', source_option_id: group }), 'bad_item')
  await refuses('11. the item is not an object', await PLAN(2, null, ['x']), 'bad_item')
  await refuses('11. a non-text field', await PLAN(2, null, { title: 'x', date: '2026-12-10', notes: 5 }), 'bad_item')
  eq('11. nothing was inserted by the refused items', (await qa(`select 1 from trip_timeline_events where title in ('x','Taken over')`)).length, 0)

  // ---- 12. plan item validation and who may call
  const okItem = (o = {}) => ({ title: 'Walk', date: '2026-12-10', ...o })
  for (const [label, t] of [['empty', ''], ['blank', '   '], ['121 characters', 'x'.repeat(121)], ['missing', undefined]]) {
    const x = await PLAN(2, null, okItem({ title: t })); ok('12. title ' + label + ' -> bad_title', hint(x) === 'bad_title' && x.e.code === '22023' && x.e.message === 'Give it a short title (1 to 120 characters).', x)
  }
  ok('12. title of exactly 120 characters', !!(await PLAN(2, null, okItem({ title: 'y'.repeat(120) }))).r?.j?.id)
  await refuses('12. wrong year', await PLAN(2, null, okItem({ date: '2025-01-01' })), 'bad_date')
  await refuses('12. no date', await PLAN(2, null, okItem({ date: null })), 'bad_date')
  for (const d of ['2026-12-04', '2026-12-03', '2026-12-18', '2026-12-25', '2027-12-10']) ok('12. date ' + d + ' accepted', !!(await PLAN(2, null, okItem({ date: d }))).r?.j?.id)
  await refuses('12. bad start time', await PLAN(2, null, okItem({ start_time: '7pm' })), 'bad_time')
  await refuses('12. bad end time', await PLAN(2, null, okItem({ start_time: '19:00', end_time: '24:00' })), 'bad_time')
  const endOnly = await PLAN(2, null, okItem({ end_time: '19:00' })); ok('12. an end time with no start time -> bad_time', hint(endOnly) === 'bad_time', endOnly)
  const longNotes = await PLAN(2, null, okItem({ notes: 'n'.repeat(1001) })); ok('12. notes of 1001 characters -> bad_item', hint(longNotes) === 'bad_item' && longNotes.e.code === '22023', longNotes)
  ok('12. notes of exactly 1000 characters', !!(await PLAN(2, null, okItem({ notes: 'n'.repeat(1000) }))).r?.j?.id)
  const longLoc = await PLAN(2, null, okItem({ location: 'l'.repeat(201) })); ok('12. location of 201 characters -> bad_item', hint(longLoc) === 'bad_item', longLoc)
  ok('12. location of exactly 200 characters', !!(await PLAN(2, null, okItem({ location: 'l'.repeat(200) }))).r?.j?.id)
  const badCat = await PLAN(2, null, okItem({ category: 'party' })); ok('12. an unknown category -> bad_item', hint(badCat) === 'bad_item', badCat)
  for (const c of ['flight', 'accommodation', 'transport', 'activity', 'dining', 'transfer', 'meeting_point', 'free_time', 'other']) ok('12. category ' + c + ' accepted', !!(await PLAN(2, null, okItem({ category: c }))).r?.j?.id)
  const place = (await q1(`insert into places(trip_id,name) values ($1,'Here') returning id`, [TR])).id
  const placeElsewhere = (await q1(`insert into places(trip_id,name) values ($1,'There') returning id`, [TR2])).id
  ok('12. a place on this trip is accepted and stored', (await qa(`select place_id::text p from trip_timeline_events where id=$1`, [(await PLAN(2, null, okItem({ place_id: place }))).r.j.id]))[0].p === place)
  for (const [label, p] of [['a place on another trip', placeElsewhere], ['a made-up place', '99999999-9999-9999-9999-999999999999'], ['not a uuid', 'here']]) {
    const x = await PLAN(2, null, okItem({ place_id: p })); ok('12. ' + label + ' -> bad_place', hint(x) === 'bad_place' && x.e.code === '22023' && x.e.message === 'That place isn\'t on this trip.', x)
  }
  await refuses('12. outsider', await PLAN(9, null, okItem()), 'not_participant', '42501', { not_participant: 'Only people who are coming on this trip can add their own plans.' })
  for (const u of [4, 21, 22]) { const x = await PLAN(u, null, okItem()); ok('12. U' + u + ' (declined / inactive / cancelled) -> not_participant', hint(x) === 'not_participant' && x.e.code === '42501' && x.e.message === 'Only people who are coming on this trip can add their own plans.', x) }
  ok('12. pending (U3) may add a plan', !!(await PLAN(3, null, okItem())).r?.j?.id)
  r = await call('anon', `select save_my_plan_item($1, NULL, '{}'::jsonb) j`, [TR]); eq('12. anon has no execute right', r.e?.code, '42501')
  r = await call(null, `select save_my_plan_item($1, NULL, '{}'::jsonb) j`, [TR]); eq('12. no JWT: not_authenticated', [r.e?.code, r.e?.hint], ['42501', 'not_authenticated'])
  eq('12. refused plan callers wrote nothing', (await qa(`select 1 from trip_timeline_events where created_by = any($1::uuid[])`, [[U(9), U(4), U(21), U(22)]])).length, 0)

  // ---- 13. the organiser keeps direct access; no activity feed rows; the whole matrix leaves the policies as they were
  r = await exec(1, `insert into trip_timeline_events(trip_id,event_date,title,created_by) values ($1,'2026-12-10','Organiser direct',$2) returning id`, [TR, U(1)])
  ok('13. the organiser\'s direct insert still works', r.rows.length === 1)
  eq('13. and so do their direct update and delete', [(await exec(1, `update trip_timeline_events set title='Organiser direct 2' where id=$1 returning id`, [r.rows[0].id])).rows.length, (await exec(1, `delete from trip_timeline_events where id=$1 returning id`, [r.rows[0].id])).rows.length], [1, 1])
  eq('13. an organiser who is also a member can use the RPCs for their own rows', [!!(await TRAVEL(1, [arrival()])).r?.j, (await rowsOf(1)).map(x => x.title)], [true, ['Org arrives']])
  eq('13. no activity_feed rows were written by any of this', (await q1(`select count(*)::int n from activity_feed`)).n, afBefore)
  eq('13. the table policies are still exactly the four live ones', JSON.stringify(await qa(`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' and tablename='trip_timeline_events' order by policyname`)), policies0)
  eq('13. no CHECK constraint or trigger was added to the table', [(await qa(`select 1 from pg_constraint where conrelid='trip_timeline_events'::regclass and contype='c'`)).length, (await qa(`select 1 from pg_trigger where tgrelid='trip_timeline_events'::regclass and not tgisinternal`)).length], [0, 0])

  // ---- 14. hardening: strict "is travel", exact ownership, source_option rows, text hygiene, the 100-item cap, null trip, updated_at
  const mk = async (title, parts, meta, extraCols = '', extraVals = '') => (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by${extraCols}) values ($1,'2026-12-10',$2,'other',$3,$4::jsonb,$5${extraVals}) returning id`, [TR, title, parts, meta, U(2)])).id
  const dupTravel = await mk('dup travel', `{${U(2)},${U(2)}}`, '{"travel_details":true}')
  const nullTravel = await mk('null travel', null, '{"travel_details":true}')
  const srcTravel = await mk('decision travel', `{${U(2)}}`, '{"travel_details":true,"direction":"arrival"}', ',source_option_id', ',gen_random_uuid()')
  const strTravel = await mk('string travel', `{${U(2)}}`, '{"travel_details":"true"}')
  const orgForMe = (await q1(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-10','Org made for me','dining',ARRAY[$2::uuid],'{}',$3) returning id`, [TR, U(2), U(1)])).id
  const snap14 = async ids => JSON.stringify(await qa(`select id, title, event_date::text, participant_ids::text[], metadata, source_option_id, updated_at::text from trip_timeline_events where id = any($1::uuid[]) order by id`, [ids]))
  const odd = [dupTravel, nullTravel, srcTravel, orgForMe]
  const odd0 = await snap14(odd)
  for (const [label, id] of [['{x,x} participant_ids', dupTravel], ['NULL participant_ids', nullTravel], ['a row from a decision (source_option_id)', srcTravel], ['a string "true" flag', strTravel], ['an organiser row listing the member', orgForMe]]) {
    await refuses('14. travel RPC by id: ' + label, await TRAVEL(2, [{ id, ...arrival() }]), 'bad_id')
  }
  await TRAVEL(2, [])
  eq('14. clearing never deletes or changes those rows', await snap14(odd), odd0)
  ok('14. the string "true" row survives clearing too (it is not travel)', (await qa(`select 1 from trip_timeline_events where id=$1`, [strTravel])).length === 1)
  await tryAll('an organiser plan row that lists the member', 2, orgForMe)
  await tryAll('a {x,x} travel-tagged row', 2, dupTravel)
  await tryAll('a NULL-participants travel row', 2, nullTravel)
  await tryAll('a decision row tagged as travel', 2, srcTravel)
  eq('14. the plan RPC left those rows alone', await snap14(odd), odd0)
  r = await PLAN(2, strTravel, { title: 'String flag is a plan', date: '2026-12-10' })
  ok('14. a "true" string flag is a plan row for the plan RPC (not travel)', r.r?.j?.id === strTravel, r)
  await refuses('14. null trip (travel)', await TRAVEL(2, [], null), 'not_participant', '42501')
  await refuses('14. null trip (plan)', await PLAN(2, null, okItem(), null), 'not_participant', '42501', { not_participant: 'Only people who are coming on this trip can add their own plans.' })
  // updated_at moves on update
  await db.query(`update trip_timeline_events set updated_at = now() - interval '1 day' where id=$1`, [strTravel])
  const u0 = (await q1(`select updated_at u from trip_timeline_events where id=$1`, [strTravel])).u
  await PLAN(2, strTravel, { title: 'Again', date: '2026-12-10' })
  ok('14. updated_at advances on a plan update', (await q1(`select updated_at > $2::timestamptz as a from trip_timeline_events where id=$1`, [strTravel, u0])).a === true)
  await TRAVEL(2, [arrival()]); const tid = (await rowsOf(2))[0].id
  await db.query(`update trip_timeline_events set updated_at = now() - interval '1 day' where id=$1`, [tid])
  const u1 = (await q1(`select updated_at u from trip_timeline_events where id=$1`, [tid])).u
  await TRAVEL(2, [{ id: tid, ...arrival() }])
  ok('14. updated_at advances on a travel update', (await q1(`select updated_at > $2::timestamptz as a from trip_timeline_events where id=$1`, [tid, u1])).a === true)
  // text hygiene
  for (const [label, t] of [['a control character', 'a\u0001b'], ['whitespace only (NBSP, tab)', ' \t \n'], ['a newline inside', 'a\nb'], ['DEL', 'a\u007fb']]) {
    const x = await PLAN(2, null, okItem({ title: t })); ok('14. plan title with ' + label + ' -> bad_title', hint(x) === 'bad_title', x)
  }
  r = await PLAN(2, null, okItem({ title: '  Walk \r\n\t', notes: '\n line one\nline two  ', location: '\tTokyo ' }))
  eq('14. NBSP / tabs / CRLF trimmed; notes keep their inner newline', await qa(`select title, description, location from trip_timeline_events where id=$1`, [r.r?.j?.id]), [{ title: 'Walk', description: 'line one\nline two', location: 'Tokyo' }])
  { const x = await PLAN(2, null, okItem({ notes: 'a\u0001b' })); ok('14. notes with a control character -> bad_item', hint(x) === 'bad_item', x) }
  { const x = await PLAN(2, null, okItem({ location: 'a\nb' })); ok('14. location with a newline -> bad_item', hint(x) === 'bad_item', x) }
  await refuses('14. extra-leg title with a control character', await TRAVEL(2, [extra({ title: 'To\u0001kyo' })]), 'bad_title')
  await refuses('14. extra-leg title that is only NBSP', await TRAVEL(2, [extra({ title: '  ' })]), 'bad_title')
  await refuses('14. flight ref with a control character', await TRAVEL(2, [arrival({ flight_ref: 'JL\u000144' })]), 'bad_ref')
  const x14 = await TRAVEL(2, [arrival({ direction: ' arrival ', leg: ' main ', flight_ref: ' JL44\t', airport_code: '  lhr\n' }), extra({ title: ' Flight to Tokyo\n' })])
  ok('14. direction / leg are trimmed; ref, airport and title cleaned', !!x14.r?.j && JSON.stringify((await rowsOf(2)).filter(x => x.title !== 'Again' && x.title !== 'decision travel').map(x => [x.title, x.metadata.flight_ref ?? null, x.metadata.airport_code ?? null]).sort()) === JSON.stringify([['Alice arrives', 'JL44', 'LHR'], ['Flight to Tokyo', null, null]].sort()), JSON.stringify((await rowsOf(2)).map(x => [x.title, x.metadata])))
  { const x = await TRAVEL(2, [arrival({ title: 'My arrival' })]); eq('14. a main leg with a title gets its own message', [x.e?.hint, x.e?.code, x.e?.message], ['bad_title', '22023', 'Arrivals and departures don\'t take a name.']) }
  // the 100 own plan items cap (per person and trip)
  await db.query(`insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) select $1,'2026-12-10','bulk '||g,'other',ARRAY[$2::uuid],'{}',$2 from generate_series(1,100) g`, [TR, U(24)])
  { const x = await PLAN(24, null, okItem()); ok('14. the 101st own plan item -> too_many with its message', hint(x) === 'too_many' && x.e.code === '22023' && x.e.message === 'You\'ve added a lot of your own plans to this trip. Remove one before adding another.', x) }
  const bulkId = (await q1(`select id from trip_timeline_events where trip_id=$1 and title='bulk 1'`, [TR])).id
  ok('14. at the cap an update still works', (await PLAN(24, bulkId, okItem({ title: 'bulk renamed' }))).r?.j?.id === bulkId)
  ok('14. after a delete one more fits', !!(await PLAN(24, bulkId, null)).r?.j && !!(await PLAN(24, null, okItem())).r?.j?.id)
  ok('14. the cap is per person: another member still adds', !!(await PLAN(2, null, okItem())).r?.j?.id)
  eq('14. the cap is per trip: the same person adds on the other trip (TR2 needs a roster row)', hint(await PLAN(24, null, okItem(), TR2)), 'not_participant')

  // ---- 15. the stale guard (p_known_ids)
  await TRAVEL(24, [])
  const others15 = await snapOthers()
  const k0 = await TRAVEL(24, [arrival()], TR, null)
  ok('15. NULL known ids with no existing rows works', !!k0.r?.j, k0)
  const mineIds = await ownIds(24, TR)
  const before15 = JSON.stringify(await qa(`select id, event_date::text from trip_timeline_events where id = any($1::uuid[]) order by id`, [mineIds]))
  let x15 = await TRAVEL(24, [], TR, null)
  eq('15. NULL known ids while rows exist -> stale (55000), message, nothing deleted', [x15.e?.hint, x15.e?.code, x15.e?.message, JSON.stringify(await qa(`select id, event_date::text from trip_timeline_events where id = any($1::uuid[]) order by id`, [mineIds]))],
    ['stale', '55000', 'Your travel has changed since you opened this. Close it, open it again and check.', before15])
  x15 = await TRAVEL(24, [], TR, [])
  eq('15. empty known ids while rows exist -> stale, rows intact', [x15.e?.hint, (await ownIds(24, TR)).length], ['stale', 1])
  // the organiser adds a row after the member loaded: the member's older list is stale; a refreshed list works
  const loaded = await ownIds(24, TR)
  await exec(1, `insert into trip_timeline_events(trip_id,event_date,title,category,participant_ids,metadata,created_by) values ($1,'2026-12-12','Added by organiser','flight',ARRAY[$2::uuid],'{"travel_details":true,"direction":"departure"}',$3)`, [TR, U(24), U(1)])
  x15 = await TRAVEL(24, [{ id: loaded[0], ...arrival() }], TR, loaded)
  eq('15. a row added elsewhere after loading -> stale, and neither it nor the loaded one changed', [x15.e?.hint, (await ownIds(24, TR)).length, (await q1(`select event_date::text d from trip_timeline_events where id=$1`, [loaded[0]])).d], ['stale', 2, '2026-12-08'])
  x15 = await TRAVEL(24, [{ id: loaded[0], ...arrival({ date: '2026-12-09' }) }], TR, await ownIds(24, TR))
  eq('15. with the refreshed list the save works; the unlisted row is deleted (it was known)', [!!x15.r?.j, (await ownIds(24, TR)).length], [true, 1])
  // known ids that are foreign, unknown or already deleted are harmless
  x15 = await TRAVEL(24, [{ id: (await ownIds(24, TR))[0], ...arrival() }], TR, [...(await ownIds(24, TR)), orgTravel, group, '99999999-9999-9999-9999-999999999999', U(1)])
  ok('15. foreign / unknown ids in known ids are ignored', !!x15.r?.j, x15)
  eq('15. and the organiser\'s rows were not touched by that', await snapOthers(), others15)
  await refuses('15. a leg may not reference a foreign id even if it is "known"', await TRAVEL(24, [{ id: orgTravel, ...arrival() }], TR, [...(await ownIds(24, TR)), orgTravel]), 'bad_id')
  const gone = (await ownIds(24, TR))[0]
  await TRAVEL(24, [])
  x15 = await TRAVEL(24, [{ id: gone, ...arrival() }], TR, [gone])
  await refuses('15. a leg that references a row deleted elsewhere -> bad_id', x15, 'bad_id')
  ok('15. known ids that no longer exist are ignored when no leg uses them', !!(await TRAVEL(24, [arrival()], TR, [gone])).r?.j)
  ok('15. a stale refusal changes nothing for the same person on the other trip', (await ownIds(24, TR2)).length === 0)
  await TRAVEL(24, [])
}
