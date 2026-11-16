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
      passes: [{ section_id: 's1', user_id: 'passer', kind: 'none_for_me' as const }],
    }
    const a = answersFor(s, inputs)
    expect([...a.keys()].sort()).toEqual(['flat', 'passer', 'sel', 'voter'])
    expect(a.get('voter')?.ranks.get('o1')).toBe(2)
    expect(a.get('passer')?.passed).toBe(true)
    expect(a.get('passer')?.passKind).toBe('none_for_me')
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

describe('isTripFinished', () => {
  it('upgrades by dates, never downgrades', () => {
    const now = new Date(2026, 10, 16, 12)
    expect(isTripFinished({ status: 'booking_details', start_date: '2026-01-01', end_date: '2026-01-10' }, now)).toBe(true)
    expect(isTripFinished({ status: 'booking_details', start_date: '2027-01-01', end_date: '2027-01-10' }, now)).toBe(false)
    expect(isTripFinished({ status: 'trip_completed', start_date: '2027-01-01', end_date: '2027-01-10' }, now)).toBe(true)
  })
})
