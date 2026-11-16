import { describe, expect, it } from 'vitest'
import { autoDecideOutcome, isAutoDecideEnabled, type AutoDecideInput, type AutoDecideOutcome, type AutoDecidePerson } from './autoDecideRule'
import { resolveWinner, type ResolverOption, type ResolverVote } from './resolveDecision'

const NOW = new Date('2026-11-18T12:00:00Z')
const PAST = '2026-11-10T00:00:00Z'

const opt = (id: string, extra: Partial<ResolverOption> = {}): ResolverOption => ({ id, status: 'available', order_index: 0, created_at: '2026-11-01T00:00:00Z', ...extra })
const v = (option_id: string, user_id: string, rank: number | null = null): ResolverVote => ({ option_id, user_id, rank })

const person = (user_id: string, confirmation_status: string | null = 'pending', active: boolean | null = true): AutoDecidePerson => ({ user_id, active, confirmation_status })

function input(over: Partial<AutoDecideInput['section']> & { votes?: ResolverVote[]; tripStatus?: string; chaseSettings?: AutoDecideInput['chaseSettings']; people?: AutoDecidePerson[] }): AutoDecideInput {
  const { votes = [], tripStatus = 'booking_details', chaseSettings = null, people, ...section } = over
  // Default: everyone who voted is in scope and nobody else is, so the minimum is always met.
  const participants = people ?? [...new Set(votes.map((x) => x.user_id))].map((u) => person(u))
  return {
    participants,
    section: { title: 'Where to stay', status: 'in_progress', metadata: null, voting_method: 'single', vote_deadline: PAST, options: [opt('a'), opt('b'), opt('c')], ...section },
    tripStatus,
    chaseSettings,
    votes,
    now: NOW,
  }
}

/** The client rule applied to the same input (open question, so the stamp is not consulted). */
function client(i: AutoDecideInput) {
  const inScope = new Set(i.participants.filter((p) => p.active !== false && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled').map((p) => p.user_id))
  return resolveWinner({ status: i.section.status, metadata: i.section.metadata, voting_method: i.section.voting_method, options: i.section.options }, i.votes.filter((x) => inScope.has(x.user_id)))
}

interface Fixture {
  name: string
  input: AutoDecideInput
  expected: AutoDecideOutcome
}

const fixtures: Fixture[] = [
  { name: 'clear leader (choose one)', input: input({ votes: [v('a', 'u1'), v('a', 'u2'), v('b', 'u3')] }), expected: { decided: true, optionId: 'a' } },
  { name: 'single answer', input: input({ votes: [v('c', 'u1')] }), expected: { decided: true, optionId: 'c' } },
  { name: 'tie at the top', input: input({ votes: [v('a', 'u1'), v('b', 'u2')] }), expected: { decided: false, tied: true, tiedOptionIds: ['a', 'b'] } },
  { name: 'three-way tie', input: input({ votes: [v('a', 'u1'), v('b', 'u2'), v('c', 'u3')] }), expected: { decided: false, tied: true, tiedOptionIds: ['a', 'b', 'c'] } },
  { name: 'nobody answered', input: input({ votes: [] }), expected: { decided: false, skipped: 'no_answers' } },
  { name: 'only "No preference" passes (passes are not votes)', input: input({ votes: [] }), expected: { decided: false, skipped: 'no_answers' } },
  {
    name: 'choose-any: leader by count',
    input: input({ voting_method: 'approval', votes: [v('a', 'u1'), v('b', 'u1'), v('b', 'u2'), v('c', 'u2'), v('b', 'u3')] }),
    expected: { decided: true, optionId: 'b' },
  },
  {
    name: 'choose-any: tie',
    input: input({ voting_method: 'approval', votes: [v('a', 'u1'), v('b', 'u1'), v('a', 'u2'), v('b', 'u2')] }),
    expected: { decided: false, tied: true, tiedOptionIds: ['a', 'b'] },
  },
  {
    name: 'ranked: clear Borda leader',
    input: input({ voting_method: 'ranked', votes: [v('a', 'u1', 1), v('b', 'u1', 2), v('c', 'u1', 3), v('b', 'u2', 1), v('a', 'u2', 2), v('a', 'u3', 1)] }),
    expected: { decided: true, optionId: 'a' },
  },
  {
    // a: 1st for u1 (2), 2nd for u2 (1) = 3 ; b: 2nd for u1 (1), 1st for u2 (2) = 3. Tied on score although each has one first choice.
    name: 'ranked: score tie (client would break it by first choices; the job leaves it)',
    input: input({ voting_method: 'ranked', options: [opt('a'), opt('b')], votes: [v('a', 'u1', 1), v('b', 'u1', 2), v('b', 'u2', 1), v('a', 'u2', 2)] }),
    expected: { decided: false, tied: true, tiedOptionIds: ['a', 'b'] },
  },
  {
    name: 'ranked: partial rankings use each voter\'s own max rank',
    input: input({ voting_method: 'ranked', votes: [v('a', 'u1', 1), v('b', 'u2', 1), v('c', 'u2', 2), v('b', 'u3', 1)] }),
    expected: { decided: true, optionId: 'b' },
  },
  { name: 'ranked with a NULL-rank vote is skipped', input: input({ voting_method: 'ranked', votes: [v('a', 'u1', null), v('b', 'u2', 1)] }), expected: { decided: false, skipped: 'ranked_null_rank' } },
  {
    name: 'option removed (cancelled) after answers: its votes no longer count',
    input: input({ options: [opt('a', { status: 'cancelled' }), opt('b'), opt('c')], votes: [v('a', 'u1'), v('a', 'u2'), v('a', 'u3'), v('b', 'u4')] }),
    // Their answers were for an option that is gone, so only u4 counts as answered (1 of 4 in scope, 2 needed).
    expected: { decided: false, skipped: 'not_enough_answers', answered: 1, needed: 2 },
  },
  {
    name: 'option removed, then enough people answered the rest',
    input: input({ options: [opt('a', { status: 'cancelled' }), opt('b'), opt('c')], votes: [v('a', 'u1'), v('b', 'u4'), v('b', 'u5')] }),
    expected: { decided: true, optionId: 'b' },
  },
  {
    name: 'option removed leaves only zero-vote options',
    input: input({ options: [opt('a', { status: 'cancelled' }), opt('b')], votes: [v('a', 'u1')] }),
    expected: { decided: false, skipped: 'no_answers' },
  },
  { name: 'all options cancelled', input: input({ options: [opt('a', { status: 'cancelled' })], votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'no_options' } },
  { name: 'already decided', input: input({ status: 'completed', votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'already_decided' } },
  { name: 'no deadline', input: input({ vote_deadline: null, votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'no_deadline' } },
  { name: 'deadline in the future', input: input({ vote_deadline: '2026-12-01T00:00:00Z', votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'deadline_not_passed' } },
  { name: 'own choice', input: input({ metadata: { decision_shape: 'personal' }, votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'own_choice' } },
  {
    name: 'dates poll (option date_range)',
    input: input({ options: [opt('a', { metadata: { date_range: { start: '2027-01-01', end: '2027-01-08' } } }), opt('b')], votes: [v('a', 'u1')] }),
    expected: { decided: false, skipped: 'date_poll' },
  },
  { name: 'dates poll (by title)', input: input({ title: ' Trip dates ', votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'date_poll' } },
  { name: 'trip finished', input: input({ tripStatus: 'trip_completed', votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'trip_finished' } },
  { name: 'auto_decide switched off for the trip', input: input({ chaseSettings: { auto_decide: false }, votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'auto_decide_off' } },
  { name: 'ideas bucket is never decided', input: input({ metadata: { ideas_bucket: true }, votes: [v('a', 'u1')] }), expected: { decided: false, skipped: 'ideas_bucket' } },
  { name: 'a booked option already is the outcome', input: input({ options: [opt('a', { status: 'booked' }), opt('b'), opt('c')], votes: [v('b', 'u1')] }), expected: { decided: false, skipped: 'already_booked' } },
  {
    name: 'one answer out of nine is not enough (half of nine = 5)',
    input: input({ votes: [v('a', 'u1')], people: Array.from({ length: 9 }, (_, k) => person(`u${k + 1}`)) }),
    expected: { decided: false, skipped: 'not_enough_answers', answered: 1, needed: 5 },
  },
  {
    name: 'half of nine rounded up is enough',
    input: input({ votes: [1, 2, 3, 4, 5].map((k) => v('a', `u${k}`)), people: Array.from({ length: 9 }, (_, k) => person(`u${k + 1}`)) }),
    expected: { decided: true, optionId: 'a' },
  },
  {
    name: 'half of four is two',
    input: input({ votes: [v('a', 'u1'), v('a', 'u2')], people: ['u1', 'u2', 'u3', 'u4'].map((u) => person(u)) }),
    expected: { decided: true, optionId: 'a' },
  },
  {
    name: 'quorum overrides the half rule (quorum 3, only 2 answered)',
    input: input({ quorum: 3, votes: [v('a', 'u1'), v('a', 'u2')], people: ['u1', 'u2', 'u3', 'u4'].map((u) => person(u)) }),
    expected: { decided: false, skipped: 'not_enough_answers', answered: 2, needed: 3 },
  },
  {
    name: 'quorum met with fewer than half',
    input: input({ quorum: 1, votes: [v('a', 'u1')], people: Array.from({ length: 9 }, (_, k) => person(`u${k + 1}`)) }),
    expected: { decided: true, optionId: 'a' },
  },
  {
    name: 'answers from declined or inactive people do not count',
    input: input({
      votes: [v('a', 'u1'), v('b', 'u2'), v('b', 'u3')],
      people: [person('u1'), person('u2', 'declined'), person('u3', 'pending', false), person('u4'), person('u5')],
    }),
    expected: { decided: false, skipped: 'not_enough_answers', answered: 1, needed: 2 },
  },
  {
    name: 'declined voters cannot swing the leader',
    input: input({ votes: [v('a', 'u1'), v('a', 'u4'), v('b', 'u2'), v('b', 'u3')], people: [person('u1'), person('u4'), person('u2', 'declined'), person('u3', 'cancelled')] }),
    expected: { decided: true, optionId: 'a' },
  },
  { name: 'tie with enough answers still goes to the organizer', input: input({ votes: [v('a', 'u1'), v('b', 'u2')] }), expected: { decided: false, tied: true, tiedOptionIds: ['a', 'b'] } },
  { name: 'auto_decide absent in other chase settings = on', input: input({ chaseSettings: { enabled: true }, votes: [v('a', 'u1')] }), expected: { decided: true, optionId: 'a' } },
]

describe('auto-decide rule (reference of public.auto_decide_question)', () => {
  it.each(fixtures)('$name', ({ input: i, expected }) => {
    const got = autoDecideOutcome(i)
    if ('tiedOptionIds' in expected && 'tiedOptionIds' in got) {
      expect(got).toEqual({ ...expected, tiedOptionIds: expect.arrayContaining(expected.tiedOptionIds) })
      expect(got.tiedOptionIds).toHaveLength(expected.tiedOptionIds.length)
    } else {
      expect(got).toEqual(expected)
    }
  })

  it('agrees with resolveWinner on every fixture the job acts on or classifies by tally', () => {
    for (const { name, input: i } of fixtures) {
      const out = autoDecideOutcome(i)
      const c = client(i)
      if (out.decided) {
        expect(c.optionId, name).toBe(out.optionId)
        expect(c.tied, name).toBe(false)
      } else if ('tied' in out) {
        expect(c.tied, name).toBe(true)
        expect([...c.tiedOptionIds].sort(), name).toEqual([...out.tiedOptionIds].sort())
      } else if (out.skipped === 'no_answers') {
        expect(c.optionId, name).toBeNull()
      }
    }
  })

  it('never decides something the client would call tied, and never differs from the client when it decides (randomised)', () => {
    let seed = 20261118
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    let decided = 0
    let tied = 0
    let enough = 0
    for (let n = 0; n < 600; n++) {
      const method = (['single', 'approval', 'ranked'] as const)[Math.floor(rnd() * 3)]
      const count = 2 + Math.floor(rnd() * 4)
      const options = Array.from({ length: count }, (_, k) => opt(`o${k}`, { order_index: k, status: rnd() < 0.15 ? 'cancelled' : 'available' }))
      const votes: ResolverVote[] = []
      for (let u = 0; u < 1 + Math.floor(rnd() * 7); u++) {
        const picks = options.filter(() => rnd() < (method === 'single' ? 0.3 : 0.5))
        const chosen = method === 'single' ? picks.slice(0, 1) : picks
        // Cancelled options can still carry votes cast before they were removed.
        chosen.forEach((o, idx) => votes.push(v(o.id, `u${u}`, method === 'ranked' ? idx + 1 : null)))
      }
      // Extra people who never answered, and some voters who are out.
      const voters = [...new Set(votes.map((x) => x.user_id))]
      const people = [
        ...voters.map((u) => person(u, rnd() < 0.15 ? 'declined' : 'pending', rnd() < 0.1 ? false : true)),
        ...Array.from({ length: Math.floor(rnd() * 6) }, (_, k) => person(`x${k}`)),
      ]
      const i = input({ voting_method: method, options, votes, people, quorum: rnd() < 0.2 ? 1 + Math.floor(rnd() * 3) : null })
      const out = autoDecideOutcome(i)
      const c = client(i)
      if (out.decided) {
        decided++
        expect(c.optionId).toBe(out.optionId)
        expect(c.tied).toBe(false)
      } else if ('tied' in out) {
        tied++
        expect(c.tied).toBe(true)
        expect([...c.tiedOptionIds].sort()).toEqual([...out.tiedOptionIds].sort())
      } else if (out.skipped === 'no_answers') {
        expect(c.optionId).toBeNull()
      } else if (out.skipped === 'no_options') {
        expect(c.optionId).toBeNull()
      } else if (out.skipped === 'not_enough_answers') {
        enough++
      } else {
        throw new Error(`unexpected skip ${out.skipped}`)
      }
    }
    expect(decided).toBeGreaterThan(50)
    expect(tied).toBeGreaterThan(5)
    expect(enough).toBeGreaterThan(20)
  })
})

describe('isAutoDecideEnabled', () => {
  it('defaults to on', () => {
    expect(isAutoDecideEnabled(null)).toBe(true)
    expect(isAutoDecideEnabled({})).toBe(true)
    expect(isAutoDecideEnabled([] as never)).toBe(true)
    expect(isAutoDecideEnabled({ auto_decide: true })).toBe(true)
    expect(isAutoDecideEnabled({ auto_decide: null })).toBe(true)
  })
  it('is off for false and "false"', () => {
    expect(isAutoDecideEnabled({ auto_decide: false })).toBe(false)
    expect(isAutoDecideEnabled({ auto_decide: 'false' })).toBe(false)
    expect(isAutoDecideEnabled({ auto_decide: 'Off' })).toBe(false)
  })
})
