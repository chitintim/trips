/**
 * Phase 4D: auto-decide windows + fail-soft, "We have an answer" scope/dedupe,
 * stage sync. Run with: npx -y deno test supabase/functions/auto-chase/
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  AUTO_DECIDE_WINDOW_HOURS,
  autoDecideDeadlineBounds,
  buildDecisionAnnouncement,
  DECISION_ANNOUNCE_WINDOW_HOURS,
  decisionDedupeKey,
  decisionPriceLine,
  decisionRecipients,
  interpretAutoDecideResult,
  isAutoDecideCandidate,
  lastHumanStatusChange,
  isRpcMissingError,
  recentDecisionsFromActivity,
  runAutoDecide,
  stageSyncTarget,
  tripAutoDecideOn,
} from './autoDecide.ts'
import { parseChaseSettings } from './chaseSettings.ts'

const NOW = new Date('2026-11-18T09:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const quiet = { warn: () => {} }

const section = (over = {}) => ({
  id: 's1', title: 'Where to stay', status: 'in_progress', vote_deadline: hoursAgo(5), metadata: null, ...over,
})
const openTrip = { status: 'booking_details', end_date: '2027-02-01', chase_settings: { enabled: true } }

// ---- windows -------------------------------------------------------------

Deno.test('constants: auto-decide window is 48h, announcements 26h', () => {
  assertEquals(AUTO_DECIDE_WINDOW_HOURS, 48)
  assertEquals(DECISION_ANNOUNCE_WINDOW_HOURS, 26)
  const b = autoDecideDeadlineBounds(NOW)
  assertEquals(b.to, NOW.toISOString())
  assertEquals(b.from, hoursAgo(48))
})

Deno.test('isAutoDecideCandidate: deadline passed within 48h yes; older, future, none no', () => {
  assert(isAutoDecideCandidate(section({ vote_deadline: hoursAgo(1) }), openTrip, NOW))
  assert(isAutoDecideCandidate(section({ vote_deadline: hoursAgo(47.9) }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section({ vote_deadline: hoursAgo(48.1) }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section({ vote_deadline: hoursAgo(24 * 30) }), openTrip, NOW)) // first-run restraint
  assertFalse(isAutoDecideCandidate(section({ vote_deadline: hoursAgo(-1) }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section({ vote_deadline: null }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section({ vote_deadline: 'nonsense' }), openTrip, NOW))
})

Deno.test('isAutoDecideCandidate: closed, Own choice, finished trip, switched off are never candidates', () => {
  assertFalse(isAutoDecideCandidate(section({ status: 'completed' }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section({ metadata: { decision_shape: 'personal' } }), openTrip, NOW))
  assertFalse(isAutoDecideCandidate(section(), { ...openTrip, status: 'trip_completed' }, NOW))
  assertFalse(isAutoDecideCandidate(section(), { ...openTrip, end_date: '2026-11-01' }, NOW))
  assertFalse(isAutoDecideCandidate(section(), { ...openTrip, chase_settings: { auto_decide: false } }, NOW))
  assert(isAutoDecideCandidate(section(), { ...openTrip, chase_settings: { enabled: true } }, NOW)) // auto_decide absent = ON
  assertFalse(isAutoDecideCandidate(section(), { ...openTrip, chase_settings: { enabled: false } }, NOW)) // reminders off: decisions would be silent
  assertFalse(isAutoDecideCandidate(section(), { ...openTrip, chase_settings: null }, NOW))
  assertFalse(isAutoDecideCandidate(section({ metadata: { ideas_bucket: true } }), openTrip, NOW))
})

Deno.test('auto_decide switch: absent = on; false/"false"/"off"/"no"/"0" = off (same as SQL)', () => {
  // only on trips where chasing (the announcement switch) is enabled
  assertFalse(tripAutoDecideOn(null))
  assertFalse(tripAutoDecideOn({}))
  assertFalse(tripAutoDecideOn({ auto_decide: true }))
  assert(tripAutoDecideOn({ enabled: true }))
  assert(tripAutoDecideOn({ enabled: true, auto_decide: true }))
  for (const off of [false, 'false', 'off', 'No', '0', 0]) assertFalse(tripAutoDecideOn({ enabled: true, auto_decide: off }))
  assertEquals(parseChaseSettings(null).auto_decide, true)
  assertEquals(parseChaseSettings({ enabled: true }).auto_decide, true)
  assertEquals(parseChaseSettings({ auto_decide: false }).auto_decide, false)
})

// ---- rpc handling --------------------------------------------------------

Deno.test('interpretAutoDecideResult: decided / tied / skipped / junk', () => {
  const d = interpretAutoDecideResult('s1', { decided: true, trip_id: 't', title: 'Q', option_id: 'o', option_title: 'Kumo' })
  assertEquals(d.kind, 'decided')
  assertEquals(interpretAutoDecideResult('s1', { decided: false, tied: true }).kind, 'tied')
  assertEquals(interpretAutoDecideResult('s1', { decided: false, skipped: 'no_answers' }), { kind: 'skipped', sectionId: 's1', reason: 'no_answers' })
  assertEquals(interpretAutoDecideResult('s1', null).kind, 'invalid')
  assertEquals(interpretAutoDecideResult('s1', {}).kind, 'invalid')
})

Deno.test('isRpcMissingError: PostgREST/Postgres missing-function shapes only', () => {
  assert(isRpcMissingError({ code: 'PGRST202' }, 'auto_decide_question'))
  assert(isRpcMissingError({ code: '42883' }, 'auto_decide_question'))
  assert(isRpcMissingError({ message: 'Could not find the function public.auto_decide_question(p_section_id) in the schema cache' }, 'auto_decide_question'))
  assertFalse(isRpcMissingError({ code: '42501', message: 'permission denied' }, 'auto_decide_question'))
  assertFalse(isRpcMissingError(null, 'auto_decide_question'))
})

Deno.test('runAutoDecide: fail-soft when the RPC is missing (stops after one call, no throw)', async () => {
  let calls = 0
  const client = { rpc: () => { calls++; return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'nope' } }) } }
  const r = await runAutoDecide(client, ['a', 'b', 'c'], quiet)
  assertEquals(calls, 1)
  assert(r.rpcMissing)
  assertEquals(r.decided, 0)
})

Deno.test('runAutoDecide: one error or throw does not stop the next question; tie writes nothing', async () => {
  const results: Record<string, () => unknown> = {
    a: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }),
    b: () => { throw new Error('network') },
    c: () => ({ data: { decided: false, tied: true }, error: null }),
    d: () => ({ data: { decided: true, trip_id: 't', title: 'Q', option_id: 'o', option_title: 'W' }, error: null }),
    e: () => ({ data: { decided: false, skipped: 'ranked_null_rank' }, error: null }),
  }
  const fnsCalled: string[] = []
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      fnsCalled.push(fn) // the ONLY database call is the RPC: a tie performs no other write
      return Promise.resolve(results[args.p_section_id as string]() as never)
    },
  }
  const r = await runAutoDecide(client, ['a', 'b', 'c', 'd', 'e'], quiet)
  assertEquals(r, { attempted: 5, decided: 1, tied: 1, skipped: 1, errors: 2, rpcMissing: false })
  assertEquals(fnsCalled, Array(5).fill('auto_decide_question'))
})

// ---- announcements -------------------------------------------------------

const act = (id: string, hrs: number, meta: { [k: string]: string | boolean } | null, actor: string | null = null) => ({
  actor, created_at: hoursAgo(hrs), entity: { type: 'section', id }, metadata: meta,
})

Deno.test('recentDecisionsFromActivity: 26h window, needs a winner, one per question+winner, never retroactive', () => {
  const rows = [
    act('s1', 2, { decided_option_id: 'o1', auto: true }),
    act('s2', 25.9, { decided_option_id: 'o2' }, 'org'),
    act('s3', 26.1, { decided_option_id: 'o3' }, 'org'), // too old
    act('s4', 3, null), // Own choice close: no winner
    act('s5', 3, { decided_option_id: 'o5' }, 'org'),
    act('s5', 1, { decided_option_id: 'o6' }, 'org'), // re-decided: latest wins, still one
    act('s6', 24 * 30, { decided_option_id: 'o' }), // first run after deploy: old decision sends nothing
  ]
  const got = recentDecisionsFromActivity(rows, NOW)
  // s5 was decided as o5 then o6: both claims are kept (the section decides which is real)
  assertEquals(got.map((g) => `${g.sectionId}:${g.optionId}`).sort(), ['s1:o1', 's2:o2', 's5:o5', 's5:o6'])
  assertEquals(got.find((g) => g.optionId === 'o6')!.decidedAt, hoursAgo(1))
})

const decidedSection = (over = {}) => ({
  id: 's1', title: 'Where to stay', status: 'completed', metadata: { decided_option_id: 'o1' },
  options: [
    { id: 'o1', title: 'Hotel Kumo', status: 'proposed', price: 120, currency: 'GBP', price_type: 'per_person_fixed' },
    { id: 'o2', title: 'Ryokan', status: 'proposed', price: 80, currency: 'GBP', price_type: 'per_person_fixed' },
  ],
  ...over,
})

Deno.test('buildDecisionAnnouncement: headline, price, booker and the exact deep link', () => {
  const a = buildDecisionAnnouncement(decidedSection(), 'https://trips.fontem.ai', 't1', 'Sam')!
  assertEquals(a.headline, '"Where to stay" — it\'s Hotel Kumo')
  assertEquals(a.details, ['£120 per person', 'Sam is booking it'])
  assertEquals(a.link, 'https://trips.fontem.ai/t1?open=question:s1')
  assertEquals(buildDecisionAnnouncement(decidedSection(), 'https://x', 't1', null)!.details, ['£120 per person'])
})

Deno.test('buildDecisionAnnouncement: not announced when open, Own choice, unstamped, or winner removed', () => {
  assertEquals(buildDecisionAnnouncement(decidedSection({ status: 'in_progress' }), 'u', 't', null), null)
  assertEquals(buildDecisionAnnouncement(decidedSection({ metadata: { decision_shape: 'personal', decided_option_id: 'o1' } }), 'u', 't', null), null)
  assertEquals(buildDecisionAnnouncement(decidedSection({ metadata: {} }), 'u', 't', null), null)
  assertEquals(buildDecisionAnnouncement(decidedSection({ metadata: { decided_option_id: 'gone' } }), 'u', 't', null), null)
  const cancelled = decidedSection({ options: [{ id: 'o1', title: 'X', status: 'cancelled' }] })
  assertEquals(buildDecisionAnnouncement(cancelled, 'u', 't', null), null)
})

Deno.test('decisionPriceLine: only a stated, single, honest figure', () => {
  assertEquals(decisionPriceLine({ price: 480, currency: 'GBP', price_type: 'total_split' }), '£480 in total')
  assertEquals(decisionPriceLine({ price: 100, currency: 'GBP', price_type: 'per_person_tiered' }), null)
  assertEquals(decisionPriceLine({ price: null, currency: 'GBP', price_type: 'per_person_fixed' }), null)
  assertEquals(decisionPriceLine({ price: 0, currency: 'GBP', price_type: 'per_person_fixed' }), null)
})

Deno.test('recipients: asked people minus the person who decided; dedupe key is the existing format with seq 1', () => {
  assertEquals(decisionRecipients(['a', 'b', 'c'], 'b'), ['a', 'c'])
  assertEquals(decisionRecipients(['a', 'b'], null), ['a', 'b'])
  assertEquals(decisionDedupeKey('S', 'O', 'U'), 'chase:decision:S:O:U:1')
  // a different decision after a Reopen is a different key; the same decision is the same key
  assert(decisionDedupeKey('S', 'O1', 'U') !== decisionDedupeKey('S', 'O2', 'U'))
  assertEquals(decisionDedupeKey('S', 'O1', 'U'), decisionDedupeKey('S', 'O1', 'U'))
})

Deno.test('buildDecisionAnnouncement: carries the stored winner; forged claims, Ideas list never announced', () => {
  const a = buildDecisionAnnouncement(decidedSection(), 'u', 't', null, 'o1')!
  assertEquals(a.optionId, 'o1')
  // forged poll_closed row naming a different (or any) option than the section really holds
  assertEquals(buildDecisionAnnouncement(decidedSection(), 'u', 't', null, 'o2'), null)
  // section not actually completed (forged row on an open question)
  assertEquals(buildDecisionAnnouncement(decidedSection({ status: 'in_progress' }), 'u', 't', null, 'o1'), null)
  // reopen then decide differently: the new winner is announced under a new key
  const b = buildDecisionAnnouncement(decidedSection({ metadata: { decided_option_id: 'o2' } }), 'u', 't', null, 'o2')!
  assert(decisionDedupeKey('s1', a.optionId, 'U') !== decisionDedupeKey('s1', b.optionId, 'U'))
  assertEquals(buildDecisionAnnouncement(decidedSection({ metadata: { decided_option_id: 'o1', ideas_bucket: true } }), 'u', 't', null, 'o1'), null)
})

// ---- stage sync ----------------------------------------------------------

Deno.test('stageSyncTarget: forward only, by dates', () => {
  const trip = (status: string, start: string | null, end: string | null) => ({ status, start_date: start, end_date: end })
  const today = '2026-11-18'
  // finished by date, stored lagging (the two live trips)
  assertEquals(stageSyncTarget(trip('booking_details', '2026-10-01', '2026-10-10'), today), 'trip_completed')
  assertEquals(stageSyncTarget(trip('booked_awaiting_departure', '2026-10-01', '2026-10-10'), today), 'trip_completed')
  // started, not finished
  assertEquals(stageSyncTarget(trip('booked_awaiting_departure', '2026-11-18', '2026-11-25'), today), 'trip_ongoing')
  assertEquals(stageSyncTarget(trip('booking_details', '2026-11-10', '2026-11-18'), today), 'trip_ongoing') // end day still ongoing
  // never backwards / already there
  assertEquals(stageSyncTarget(trip('trip_completed', '2026-11-18', '2026-11-25'), today), null)
  assertEquals(stageSyncTarget(trip('trip_ongoing', '2026-11-01', '2026-11-25'), today), null)
  assertEquals(stageSyncTarget(trip('trip_completed', '2026-10-01', '2026-10-10'), today), null)
  // not started yet
  assertEquals(stageSyncTarget(trip('booking_details', '2026-12-01', '2026-12-10'), today), null)
})

Deno.test('stageSyncTarget: missing, malformed, inverted dates or unknown status are never touched', () => {
  const today = '2026-11-18'
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: null, end_date: '2026-10-10' }, today), null)
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: '2026-10-01', end_date: null }, today), null)
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: 'TBD', end_date: '2026-10-10' }, today), null)
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: '2026-10-10', end_date: '2026-10-01' }, today), null)
  assertEquals(stageSyncTarget({ status: 'weird', start_date: '2026-10-01', end_date: '2026-10-10' }, today), null)
  assertEquals(stageSyncTarget({ status: null, start_date: '2026-10-01', end_date: '2026-10-10' }, today), null)
})

Deno.test('stageSyncTarget: never overrides a human status change after the date boundary', () => {
  const t = (status: string) => ({ status, start_date: '2026-10-01', end_date: '2026-10-10' })
  const today = '2026-11-18'
  // organiser set it back after the trip ended (postponed): leave it
  assertEquals(stageSyncTarget(t('booking_details'), today, '2026-10-20T10:00:00Z'), null)
  // a human change BEFORE the end boundary does not block completion
  assertEquals(stageSyncTarget(t('booking_details'), today, '2026-10-05T10:00:00Z'), 'trip_completed')
  // ongoing: human change after the start blocks, before it does not
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: '2026-11-10', end_date: '2026-11-25' }, today, '2026-11-12T00:00:00Z'), null)
  assertEquals(stageSyncTarget({ status: 'booking_details', start_date: '2026-11-10', end_date: '2026-11-25' }, today, '2026-11-01T00:00:00Z'), 'trip_ongoing')
})

Deno.test('stageSyncTarget: completed only from the day after end_date (UTC)', () => {
  const t = { status: 'trip_ongoing', start_date: '2026-11-10', end_date: '2026-11-18' }
  assertEquals(stageSyncTarget(t, '2026-11-18'), null)
  assertEquals(stageSyncTarget(t, '2026-11-19'), 'trip_completed')
})

Deno.test('lastHumanStatusChange: ignores the job\'s own auto rows', () => {
  assertEquals(lastHumanStatusChange([]), null)
  assertEquals(lastHumanStatusChange([{ actor: null, created_at: '2026-11-01T00:00:00Z', metadata: { auto: true } }]), null)
  assertEquals(lastHumanStatusChange([
    { actor: 'u1', created_at: '2026-11-01T00:00:00Z', metadata: {} },
    { actor: 'u2', created_at: '2026-11-05T00:00:00Z', metadata: null },
    { actor: null, created_at: '2026-11-09T00:00:00Z', metadata: { auto: true } },
  ]), '2026-11-05T00:00:00Z')
})
