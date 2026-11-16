import { describe, expect, it } from 'vitest'
import {
  answerCounts,
  answersFor,
  buildAnsweredSectionVoters,
  hasAnswered,
  hasAnsweredIn,
  indexAnswers,
  isAnswerer,
  isOwnChoice,
  isQuestionOpen,
  isTripFinished,
  isAnswerTodoCandidate,
  passKindFor,
  questionAnswerState,
  type AnswerSection,
} from './answers'

const section = (over: Partial<AnswerSection> = {}): AnswerSection => ({
  id: 's1',
  status: 'in_progress',
  metadata: null,
  options: [
    { id: 'o1', status: 'available', selections: [] },
    { id: 'o2', status: 'available', selections: [{ user_id: 'sel' }] },
    { id: 'o3', status: 'cancelled', selections: [] },
  ],
  ...over,
})

describe('answersFor / hasAnswered', () => {
  it('unions votes, nested selections, flat selections and passes', () => {
    const s = section()
    const inputs = {
      votes: [{ option_id: 'o1', user_id: 'voter', rank: 2 }],
      selections: [{ option_id: 'o1', user_id: 'flat' }],
      passes: [{ section_id: 's1', user_id: 'passer', kind: 'no_preference' as const }],
    }
    const a = answersFor(s, inputs)
    expect([...a.keys()].sort()).toEqual(['flat', 'passer', 'sel', 'voter'])
    expect(a.get('voter')?.ranks.get('o1')).toBe(2)
    expect(a.get('passer')?.passed).toBe(true)
    expect(a.get('passer')?.passKind).toBe('no_preference')
    expect(a.get('sel')?.sources.has('selection')).toBe(true)
    expect(hasAnswered(s, 'nobody', inputs)).toBe(false)
  })

  it('ignores votes on other questions and passes for other sections', () => {
    const s = section()
    const a = answersFor(s, {
      votes: [{ option_id: 'other', user_id: 'x' }],
      passes: [{ section_id: 'other', user_id: 'y', kind: 'no_preference' }],
    })
    expect(a.has('x')).toBe(false)
    expect(a.has('y')).toBe(false)
  })

  it('works without passes (Phase 1)', () => {
    expect(hasAnswered(section(), 'sel', { votes: [] })).toBe(true)
  })
})

describe('question state', () => {
  const index = (s: AnswerSection) => indexAnswers([s], { votes: [{ option_id: 'o1', user_id: 'me' }] })

  it('open / answered / needs_answer', () => {
    const s = section()
    expect(questionAnswerState(s, 'me', { index: index(s), tripFinished: false })).toBe('answered')
    expect(questionAnswerState(s, 'you', { index: index(s), tripFinished: false })).toBe('needs_answer')
  })

  it('finished trips never need an answer; completed is decided', () => {
    const s = section()
    expect(questionAnswerState(s, 'you', { index: index(s), tripFinished: true })).toBe('closed_no_decision')
    const done = section({ status: 'completed' })
    expect(questionAnswerState(done, 'you', { index: index(done), tripFinished: false })).toBe('decided')
  })

  it('no live options and out viewers', () => {
    const empty = section({ options: [{ id: 'o3', status: 'cancelled' }] })
    expect(isQuestionOpen(empty)).toBe(false)
    expect(questionAnswerState(empty, 'you', { index: index(empty), tripFinished: false })).toBe('no_options')
    const s = section()
    expect(questionAnswerState(s, 'you', { index: index(s), tripFinished: false, viewerOut: true })).toBe('not_applicable')
  })

  it('own choice comes from decision_shape', () => {
    expect(isOwnChoice(section({ metadata: { decision_shape: 'personal' } }))).toBe(true)
    expect(isOwnChoice(section())).toBe(false)
  })
})

describe('answerCounts: one denominator (asked = active and not declined/cancelled)', () => {
  const people = [
    { user_id: 'a', confirmation_status: 'confirmed' },
    { user_id: 'b', confirmation_status: 'confirmed' },
    { user_id: 'declined', confirmation_status: 'declined' },
    { user_id: 'maybe', confirmation_status: 'interested' },
    { user_id: 'pending', confirmation_status: 'pending' },
    { user_id: 'wait', confirmation_status: 'waitlist' },
    { user_id: 'left', confirmation_status: 'confirmed', active: false },
  ]

  it('counts everyone who is not out: pending, interested and waitlisted are still asked', () => {
    const s = section()
    const index = indexAnswers([s], { votes: [{ option_id: 'o1', user_id: 'a' }, { option_id: 'o1', user_id: 'declined' }] })
    const c = answerCounts('s1', index, people, true)
    expect(c.total).toBe(5)
    expect(c.answered).toBe(1)
    expect(c.waitingUserIds).toEqual(['b', 'maybe', 'pending', 'wait'])
    expect(hasAnsweredIn(index, 's1', 'a')).toBe(true)
  })

  it('does not depend on the confirmation flag', () => {
    const index = indexAnswers([section()], { votes: [] })
    expect(answerCounts('s1', index, people, false).total).toBe(answerCounts('s1', index, people, true).total)
  })

  it('isAnswerer is the exact complement of "out"', () => {
    expect(people.filter(isAnswerer).map((p) => p.user_id)).toEqual(['a', 'b', 'maybe', 'pending', 'wait'])
  })
})

describe('buildAnsweredSectionVoters', () => {
  it('includes selections and passes so linked to-dos auto-tick', () => {
    const s = section()
    const voters = buildAnsweredSectionVoters([s], {
      votes: [{ option_id: 'o1', user_id: 'v' }],
      passes: [{ section_id: 's1', user_id: 'p', kind: 'no_preference' }],
    })
    expect([...(voters.get('s1') ?? [])].sort()).toEqual(['p', 'sel', 'v'])
  })
})

describe('passes: real answer wins, and the pass kind follows the shape', () => {
  it('a person holding both an option answer and a pass row is answered, not passed', () => {
    const a = answersFor(section(), {
      votes: [{ option_id: 'o1', user_id: 'x' }],
      passes: [{ section_id: 's1', user_id: 'x', kind: 'no_preference' }],
    }).get('x')!
    expect(a.passed).toBe(false)
    expect(a.passKind).toBeNull()
    expect(a.sources.has('pass')).toBe(false)
    expect([...a.optionIds]).toEqual(['o1'])
  })

  it('a pass alone still counts as answered', () => {
    const s = section()
    expect(hasAnswered(s, 'p', { votes: [], passes: [{ section_id: 's1', user_id: 'p', kind: 'no_preference' }] })).toBe(true)
  })

  it('passKindFor: "No preference" on a Group choice, "None for me" on an Own choice', () => {
    expect(passKindFor({ metadata: null })).toBe('no_preference')
    expect(passKindFor({ metadata: { decision_shape: 'personal' } })).toBe('none_for_me')
  })

  it('isAnswerTodoCandidate: Own choice with no deadline is a to-do only when passes are available', () => {
    const own = { metadata: { decision_shape: 'personal' }, vote_deadline: null }
    expect(isAnswerTodoCandidate(own, false)).toBe(false)
    expect(isAnswerTodoCandidate(own, true)).toBe(true)
    // a deadline makes it a to-do either way
    expect(isAnswerTodoCandidate({ ...own, vote_deadline: '2026-12-01T00:00:00Z' }, false)).toBe(true)
    expect(isAnswerTodoCandidate({ ...own, vote_deadline: '2026-12-01T00:00:00Z' }, true)).toBe(true)
    // Group choices are always to-dos
    expect(isAnswerTodoCandidate({ metadata: null, vote_deadline: null }, false)).toBe(true)
  })
})

describe('answered is derived from the current shape of the question', () => {
  const own = { decision_shape: 'personal' }
  const noSel = (over: Partial<AnswerSection> = {}) =>
    section({ options: [{ id: 'o1', status: 'available', selections: [] }, { id: 'o2', status: 'available', selections: [] }], ...over })

  it('a vote left on a question that is now Own choice does not count', () => {
    const s = noSel({ metadata: own })
    expect(hasAnswered(s, 'u', { votes: [{ option_id: 'o1', user_id: 'u' }] })).toBe(false)
    expect(buildAnsweredSectionVoters([s], { votes: [{ option_id: 'o1', user_id: 'u' }] }).has('s1')).toBe(false)
  })

  it('an Own choice counts selections and its own-kind pass', () => {
    const s = noSel({ metadata: own })
    expect(hasAnswered(s, 'u', { votes: [], selections: [{ option_id: 'o1', user_id: 'u' }] })).toBe(true)
    expect(hasAnswered(s, 'u', { votes: [], passes: [{ section_id: 's1', user_id: 'u', kind: 'none_for_me' }] })).toBe(true)
  })

  it('a pass of the wrong kind does not count, on either shape', () => {
    expect(hasAnswered(noSel({ metadata: own }), 'u', { votes: [], passes: [{ section_id: 's1', user_id: 'u', kind: 'no_preference' }] })).toBe(false)
    expect(hasAnswered(noSel(), 'u', { votes: [], passes: [{ section_id: 's1', user_id: 'u', kind: 'none_for_me' }] })).toBe(false)
  })

  it('a Group choice counts votes and its group-kind pass', () => {
    expect(hasAnswered(noSel(), 'u', { votes: [{ option_id: 'o1', user_id: 'u' }] })).toBe(true)
    expect(hasAnswered(noSel(), 'u', { votes: [], passes: [{ section_id: 's1', user_id: 'u', kind: 'no_preference' }] })).toBe(true)
  })

  it('legacy: a selection left on a Group choice still counts (the answer model shows it as an approval)', () => {
    expect(hasAnswered(noSel(), 'u', { votes: [], selections: [{ option_id: 'o1', user_id: 'u' }] })).toBe(true)
  })
})

describe('isTripFinished', () => {
  it('upgrades by dates, never downgrades', () => {
    const now = new Date(2026, 10, 16, 12)
    expect(isTripFinished({ status: 'booking_details', start_date: '2026-01-01', end_date: '2026-01-10' }, now)).toBe(true)
    expect(isTripFinished({ status: 'booking_details', start_date: '2027-01-01', end_date: '2027-01-10' }, now)).toBe(false)
    expect(isTripFinished({ status: 'trip_completed', start_date: '2027-01-01', end_date: '2027-01-10' }, now)).toBe(true)
  })
})
