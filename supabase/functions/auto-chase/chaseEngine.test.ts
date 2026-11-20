/**
 * Run with: deno test supabase/functions/auto-chase/
 *
 * Proves the engine bridge only ever REMOVES recipients relative to the old
 * auto-chase rules, and that every email link is the exact deep link.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  addPassesToSectionVoters,
  answerTodoId,
  claimChaseOpen,
  claimEmailLink,
  type ChaseSectionRow,
  DEEP_LINKS,
  emailLink,
  engineRsvpStandings,
  engineTodoIds,
  withinRsvpChaseWindow,
  isOwnChoiceSection,
  rsvpTodoId,
  toEngineSections,
  travelTodoId,
} from './chaseEngine.ts'
import type { AnswerPass } from '../_shared/answers/answers.ts'
import { outstandingTargets } from './outstandingTargets.ts'
import { buildSectionVoters } from '../_shared/actionCompletion/sectionVoters.ts'

const NOW = new Date('2026-11-16T10:00:00Z')
const BASE = 'https://trips.fontem.ai'

const trip = {
  id: 't1',
  name: 'Japow 2027',
  status: 'booking_details',
  start_date: '2027-01-20',
  end_date: '2027-01-27',
  confirmation_enabled: true,
  confirmation_deadline: '2026-11-18T12:00:00Z',
}
const person = (user_id: string, confirmation_status = 'confirmed', extra = {}) => ({ user_id, active: true, confirmation_status, ...extra })

const section = (over: Partial<ChaseSectionRow> = {}): ChaseSectionRow => ({
  id: 's1',
  title: 'Where are we staying?',
  status: 'in_progress',
  vote_deadline: '2026-11-17T10:00:00Z',
  voting_method: 'single',
  metadata: null,
  options: [
    { id: 'o1', status: 'proposed', option_votes: [], selections: [] },
    { id: 'o2', status: 'proposed', option_votes: [], selections: [] },
  ],
  ...over,
})

function owed(rows: ChaseSectionRow[], users: string[], t = trip, participants = users.map((u) => person(u))) {
  const { sections, votes } = toEngineSections(rows)
  return engineTodoIds({ trip: t, participants, sections, votes }, users, NOW)
}

Deno.test('links: exact deep links on top of APP_BASE_URL', () => {
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.question('s1')), `${BASE}/t1?open=question:s1`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.rsvp()), `${BASE}/t1?open=rsvp`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.todo('a1')), `${BASE}/t1?open=todo:a1`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.payment('p1')), `${BASE}/t1?open=payment:p1`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.claim('e1')), `${BASE}/t1?open=claim:e1`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.travelDetails()), `${BASE}/t1?open=travel-details`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.todos()), `${BASE}/t1?open=todos`)
  assertEquals(emailLink(BASE, 't1', DEEP_LINKS.settle()), `${BASE}/t1?open=settle`)
  assertEquals(emailLink(BASE, 't1'), `${BASE}/t1`)
})

Deno.test('answers: nobody has answered -> everyone in scope owes the answer', () => {
  const r = owed([section()], ['u1', 'u2'])
  assert(r.get('u1')!.has(answerTodoId('s1')))
  assert(r.get('u2')!.has(answerTodoId('s1')))
})

Deno.test('answers: a vote counts as answered', () => {
  const s = section()
  s.options![0].option_votes = [{ user_id: 'u1' }]
  const r = owed([s], ['u1', 'u2'])
  assert(!r.get('u1')!.has(answerTodoId('s1')))
  assert(r.get('u2')!.has(answerTodoId('s1')))
})

Deno.test('answers: a SELECTION counts as answered on a group question too (old rule would have chased u1)', () => {
  const s = section()
  s.options![1].selections = [{ user_id: 'u1' }]
  const r = owed([s], ['u1', 'u2'])
  assert(!r.get('u1')!.has(answerTodoId('s1')))
  assert(r.get('u2')!.has(answerTodoId('s1')))
})

Deno.test('answers: own-choice question answered by a selection is not chased', () => {
  const s = section({ metadata: { decision_shape: 'personal' } })
  s.options![0].selections = [{ user_id: 'u1' }]
  assert(isOwnChoiceSection(s.metadata))
  const r = owed([s], ['u1', 'u2'])
  assert(!r.get('u1')!.has(answerTodoId('s1')))
  assert(r.get('u2')!.has(answerTodoId('s1')))
})

Deno.test('answers: no live option -> nothing to answer; cancelled options do not count', () => {
  const s = section()
  s.options = [{ id: 'o1', status: 'cancelled', option_votes: [], selections: [] }]
  assert(!owed([s], ['u1']).get('u1')!.has(answerTodoId('s1')))
  assert(!owed([section({ options: [] })], ['u1']).get('u1')!.has(answerTodoId('s1')))
})

Deno.test('answers: a finished trip never needs an answer', () => {
  const finished = { ...trip, status: 'trip_completed' }
  assert(!owed([section()], ['u1'], finished).get('u1')!.has(answerTodoId('s1')))
  const pastEnd = { ...trip, start_date: '2026-10-01', end_date: '2026-10-10' }
  assert(!owed([section()], ['u1'], pastEnd).get('u1')!.has(answerTodoId('s1')))
})

Deno.test('answers: declined people owe nothing', () => {
  const r = owed([section()], ['u1'], trip, [person('u1', 'declined')])
  assert(!r.get('u1')!.has(answerTodoId('s1')))
})

Deno.test('rsvp: pending is chased; interested only because a deadline exists; RSVP tracking off -> nobody', () => {
  const users = ['p', 'i', 'c']
  const parts = [person('p', 'pending'), person('i', 'interested'), person('c', 'confirmed')]
  const r = engineTodoIds({ trip, participants: parts }, users, NOW)
  assert(r.get('p')!.has(rsvpTodoId('t1')))
  assert(r.get('i')!.has(rsvpTodoId('t1')))
  assert(!r.get('c')!.has(rsvpTodoId('t1')))

  const noDeadline = engineTodoIds({ trip: { ...trip, confirmation_deadline: null }, participants: parts }, users, NOW)
  assert(noDeadline.get('p')!.has(rsvpTodoId('t1')))
  assert(!noDeadline.get('i')!.has(rsvpTodoId('t1')))

  const off = engineTodoIds({ trip: { ...trip, confirmation_enabled: false }, participants: parts }, users, NOW)
  for (const u of users) assert(!off.get(u)!.has(rsvpTodoId('t1')))
})

Deno.test('rsvp: a conditional person whose date has arrived owes the RSVP', () => {
  const parts = [person('c', 'conditional', { conditional_date: '2026-11-16' }), person('f', 'conditional', { conditional_date: '2026-12-01' })]
  const r = engineTodoIds({ trip, participants: parts }, ['c', 'f'], NOW)
  assert(r.get('c')!.has(rsvpTodoId('t1')))
  assert(!r.get('f')!.has(rsvpTodoId('t1')))
})

Deno.test('travel: only confirmed people (RSVP on), only before the trip starts', () => {
  const soon = { ...trip, start_date: '2026-11-25', end_date: '2026-12-02' }
  const parts = [person('c', 'confirmed'), person('p', 'pending')]
  const r = engineTodoIds({ trip: soon, participants: parts }, ['c', 'p'], NOW)
  assert(r.get('c')!.has(travelTodoId('t1')))
  assert(!r.get('p')!.has(travelTodoId('t1')))

  const ongoing = { ...trip, start_date: '2026-11-10', end_date: '2026-11-20', status: 'trip_ongoing' }
  assert(!engineTodoIds({ trip: ongoing, participants: parts }, ['c'], NOW).get('c')!.has(travelTodoId('t1')))
})

Deno.test('travel: someone with arrival AND departure travel-details events is not chased', () => {
  const soon = { ...trip, start_date: '2026-11-25', end_date: '2026-12-02' }
  const ev = (direction: string) => ({ title: direction, participant_ids: ['c'], metadata: { travel_details: true, direction } })
  const r = engineTodoIds({ trip: soon, participants: [person('c')], travelEvents: [ev('arrival'), ev('departure')] }, ['c'], NOW)
  assert(!r.get('c')!.has(travelTodoId('t1')))
})

Deno.test('the bridge never produces organiser kinds, whatever the data', () => {
  const s = section()
  s.options![0].option_votes = [{ user_id: 'u1' }, { user_id: 'u2' }]
  const r = owed([s], ['u1', 'u2'])
  for (const ids of r.values()) for (const id of ids) assert(!id.startsWith('org_'), id)
})

Deno.test('action auto-tick: a selection in the linked question completes the action for that person', () => {
  const voters = buildSectionVoters(
    [{ id: 'o1', section_id: 's1' }],
    [{ option_id: 'o1', user_id: 'u1' }] // a selection row has the same option_id + user_id shape as a vote
  )
  assertEquals([...(voters.get('s1') ?? [])], ['u1'])
})

Deno.test('claim reminders: not once balances are frozen; no code falls back to the money tab, not a dead claim page', () => {
  assertEquals(claimChaseOpen(null), true)
  assertEquals(claimChaseOpen(undefined), true)
  assertEquals(claimChaseOpen({ transactions: [] }), false)
  assertEquals(claimEmailLink('https://app.test', 't1', 'abc'), 'https://app.test/claim/abc')
  assertEquals(claimEmailLink('https://app.test', 't1', undefined), 'https://app.test/t1?open=settle')
  assertEquals(claimEmailLink('https://app.test', 't1', ''), 'https://app.test/t1?open=settle')
})

// ---- passes ("No preference" / "None for me") count as answered ----

function owedWithPasses(rows: ChaseSectionRow[], users: string[], passes?: AnswerPass[]) {
  const { sections, votes } = toEngineSections(rows)
  return engineTodoIds({ trip, participants: users.map((u) => person(u)), sections, votes, passes }, users, NOW)
}

Deno.test('passes: unvoted_poll (group) - a person with a no_preference pass is not a recipient; others still are', () => {
  const r = owedWithPasses([section()], ['u1', 'u2'], [{ section_id: 's1', user_id: 'u1', kind: 'no_preference' }])
  assertEquals(r.get('u1')!.has(answerTodoId('s1')), false)
  assertEquals(r.get('u2')!.has(answerTodoId('s1')), true)
})

Deno.test('passes: unfilled_order (own choice) - a none_for_me pass removes the recipient', () => {
  const own = section({ metadata: { decision_shape: 'personal' } })
  const r = owedWithPasses([own], ['u1', 'u2'], [{ section_id: 's1', user_id: 'u1', kind: 'none_for_me' }])
  assertEquals(r.get('u1')!.has(answerTodoId('s1')), false)
  assertEquals(r.get('u2')!.has(answerTodoId('s1')), true)
})

Deno.test('passes: a pass of the wrong kind for the question shape does not count', () => {
  const own = section({ metadata: { decision_shape: 'personal' } })
  const wrongOnOwn = owedWithPasses([own], ['u1'], [{ section_id: 's1', user_id: 'u1', kind: 'no_preference' }])
  assertEquals(wrongOnOwn.get('u1')!.has(answerTodoId('s1')), true)
  const wrongOnGroup = owedWithPasses([section()], ['u1'], [{ section_id: 's1', user_id: 'u1', kind: 'none_for_me' }])
  assertEquals(wrongOnGroup.get('u1')!.has(answerTodoId('s1')), true)
})

Deno.test('passes: without passes (undefined, [] or other sections) the result is identical to before', () => {
  const rows = [section(), section({ id: 's2', metadata: { decision_shape: 'personal' }, options: [{ id: 'o9', status: 'proposed', option_votes: [], selections: [{ user_id: 'u2' }] }] })]
  const users = ['u1', 'u2', 'u3']
  const base = owedWithPasses(rows, users)
  const none = owedWithPasses(rows, users, [])
  const elsewhere = owedWithPasses(rows, users, [{ section_id: 'other', user_id: 'u1', kind: 'no_preference' }])
  for (const u of users) {
    assertEquals([...none.get(u)!].sort(), [...base.get(u)!].sort())
    assertEquals([...elsewhere.get(u)!].sort(), [...base.get(u)!].sort())
  }
})

Deno.test('passes: an own-choice question with no deadline is still not a to-do for email (conservative)', () => {
  const own = section({ metadata: { decision_shape: 'personal' }, vote_deadline: null })
  const r = owedWithPasses([own], ['u1'])
  assertEquals(r.get('u1')!.has(answerTodoId('s1')), false)
})

Deno.test('passes: section-linked action reminders skip people who passed on the linked question', () => {
  const voters = buildSectionVoters([{ id: 'o1', section_id: 's1' }], [{ option_id: 'o1', user_id: 'u1' }])
  const meta = new Map([['s1', null], ['s2', { decision_shape: 'personal' }]])
  const withPasses = addPassesToSectionVoters(
    voters,
    [
      { section_id: 's1', user_id: 'u2', kind: 'no_preference' },
      { section_id: 's1', user_id: 'u3', kind: 'none_for_me' }, // wrong kind for a group question: ignored
      { section_id: 's2', user_id: 'u3', kind: 'none_for_me' },
    ],
    meta
  )
  assertEquals(outstandingTargets(['u1', 'u2', 'u3'], 's1', new Set(), withPasses), ['u3'])
  assertEquals(outstandingTargets(['u1', 'u2', 'u3'], 's2', new Set(), withPasses), ['u1', 'u2'])
  // No passes: the very same map comes back untouched.
  assertEquals(addPassesToSectionVoters(voters, [], meta), voters)
  assertEquals(outstandingTargets(['u1', 'u2', 'u3'], 's1', new Set(), voters), ['u2', 'u3'])
})

// ---- "Maybe" rule: chase only people who can still change something ----
const full = { ...trip, capacity_limit: 2 }
const crowd = [person('g1'), person('g2'), person('m', 'interested'), person('p', 'pending')]

Deno.test('rsvp chase (c): no_place people are skipped inside the 72h window', () => {
  assert(withinRsvpChaseWindow(trip.confirmation_deadline, NOW))
  const st = engineRsvpStandings({ trip: full, participants: crowd }, NOW)
  assertEquals(st.get('m')!.kind, 'no_place')
  assertEquals(st.get('p')!.kind, 'no_place')
  assert(!st.get('m')!.chaseable)
  assert(!st.get('p')!.chaseable)
})

Deno.test('rsvp chase (c): open people are still chased when places are free', () => {
  const st = engineRsvpStandings({ trip: { ...trip, capacity_limit: 8 }, participants: crowd }, NOW)
  assert(st.get('m')!.chaseable)
  assert(st.get('p')!.chaseable)
  assert(!st.get('g1')!.chaseable)
})

Deno.test('rsvp chase (c): the window runs to the end of the deadline day (UTC)', () => {
  const d = '2026-11-18T09:00:00Z'
  assert(withinRsvpChaseWindow(d, new Date('2026-11-18T23:00:00Z'))) // same day, hours after the stored time
  assert(!withinRsvpChaseWindow(d, new Date('2026-11-19T00:00:00Z'))) // next day
  assert(withinRsvpChaseWindow(d, new Date('2026-11-16T00:01:00Z'))) // just under 72h before the end
  assert(!withinRsvpChaseWindow(d, new Date('2026-11-15T23:00:00Z'))) // 72h+ before the end
  assert(withinRsvpChaseWindow('2026-11-18', new Date('2026-11-18T23:00:00Z'))) // date-only value
})

Deno.test('rsvp chase (d): a stated date that arrived is not chased after the deadline or when full', () => {
  const cond = person('c', 'conditional', { conditional_type: 'date', conditional_date: '2026-11-10' })
  const open = engineRsvpStandings({ trip: { ...trip, confirmation_deadline: null }, participants: [cond] }, NOW)
  assert(open.get('c')!.chaseable)
  const after = engineRsvpStandings({ trip: { ...trip, confirmation_deadline: '2026-11-15T00:00:00Z' }, participants: [cond] }, NOW)
  assertEquals(after.get('c')!.kind, 'late')
  assert(!after.get('c')!.chaseable)
  const fullTrip = engineRsvpStandings({ trip: { ...trip, confirmation_deadline: null, capacity_limit: 1 }, participants: [person('g'), cond] }, NOW)
  assertEquals(fullTrip.get('c')!.kind, 'no_place')
  assert(!fullTrip.get('c')!.chaseable)
})

Deno.test('rsvp chase (d): still fires with no deadline and places free; users-only never', () => {
  const cond = person('c', 'conditional', { conditional_type: 'both', conditional_date: '2026-11-16' })
  const usersOnly = person('u', 'conditional', { conditional_type: 'users', conditional_date: '2026-11-01' })
  const st = engineRsvpStandings({ trip: { ...trip, confirmation_deadline: null, capacity_limit: 10 }, participants: [cond, usersOnly] }, NOW)
  assert(st.get('c')!.chaseable)
  assert(!st.get('u')!.chaseable)
})
