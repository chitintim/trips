import { describe, it, expect } from 'vitest'
import {
  computeQuestionStates,
  computeGroupProgress,
  estimateAnswerMinutes,
  formatEntryCardLabel,
  type QuestionStateInput,
} from './responseState'

const trip = {
  status: 'booking_details' as const,
  start_date: '2099-08-01',
  end_date: '2099-08-10',
  confirmation_enabled: true as boolean | null,
}

const people = [
  { user_id: 'me', active: true, confirmation_status: 'confirmed' },
  { user_id: 'bob', active: true, confirmation_status: 'confirmed' },
  { user_id: 'dec', active: true, confirmation_status: 'declined' },
  { user_id: 'can', active: true, confirmation_status: 'cancelled' },
  { user_id: 'gone', active: false, confirmation_status: 'confirmed' },
]

const group = {
  id: 'g',
  status: 'open',
  metadata: null,
  options: [
    { id: 'g1', status: 'available', selections: [] },
    { id: 'g2', status: 'available', selections: [] },
  ],
}

function run(overrides: Partial<QuestionStateInput> = {}) {
  return computeQuestionStates({ sections: [group], votes: [], userId: 'me', trip, participants: people, ...overrides })
}

describe('computeQuestionStates', () => {
  it('shows "Needs your answer" until the viewer answers', () => {
    const s = run().get('g')!
    expect(s.state).toBe('needs_answer')
    expect(s.label).toBe('Needs your answer')
    expect(s.shape).toBe('group')
  })

  it('a vote shows "Answered ✓"', () => {
    const s = run({ votes: [{ option_id: 'g1', user_id: 'me' }] }).get('g')!
    expect(s.label).toBe('Answered ✓')
  })

  it('a selection-only answer on a group-choice question shows "Answered ✓" (grid path)', () => {
    const withSelection = { ...group, options: [{ id: 'g1', status: 'available', selections: [{ user_id: 'me' }] }, group.options[1]] }
    const s = run({ sections: [withSelection] }).get('g')!
    expect(s.state).toBe('answered')
    expect(s.label).toBe('Answered ✓')
    expect(s.answered).toBe(1)
  })

  it('own-choice selections show "Answered ✓"', () => {
    const own = { id: 'o', status: 'open', metadata: { decision_shape: 'personal' }, options: [{ id: 'o1', status: 'available', selections: [{ user_id: 'me' }] }] }
    const s = run({ sections: [own] }).get('o')!
    expect(s.shape).toBe('own')
    expect(s.label).toBe('Answered ✓')
  })

  it('a finished trip never says "Needs your answer"', () => {
    const finished = { ...trip, status: 'trip_completed' as const, start_date: '2020-01-01', end_date: '2020-01-05' }
    const s = run({ trip: finished }).get('g')!
    expect(s.state).toBe('closed_no_decision')
    expect(s.label).toBe('Closed — no decision')
    expect(s.label).not.toBe('Needs your answer')
  })

  it('a trip whose dates have passed counts as finished even if the stored status lags', () => {
    const lagging = { ...trip, start_date: '2020-01-01', end_date: '2020-01-05' }
    expect(run({ trip: lagging }).get('g')!.state).toBe('closed_no_decision')
  })

  it('decided questions say "Decided"', () => {
    const s = run({ sections: [{ ...group, status: 'completed' }] }).get('g')!
    expect(s.label).toBe('Decided')
  })

  it('count denominator excludes declined, cancelled and removed people', () => {
    const s = run({
      votes: [
        { option_id: 'g1', user_id: 'bob' },
        { option_id: 'g1', user_id: 'dec' },
        { option_id: 'g1', user_id: 'gone' },
      ],
    }).get('g')!
    expect(s.total).toBe(2)
    expect(s.answered).toBe(1)
    expect(s.countLabel).toBe('1 of 2 answered')
  })

  it('shows no chip when the viewer has declined', () => {
    const s = run({ userId: 'dec' }).get('g')!
    expect(s.state).toBe('not_applicable')
    expect(s.label).toBeNull()
  })

  it('shows no chip for a question with no live options', () => {
    const s = run({ sections: [{ ...group, options: [{ id: 'x', status: 'cancelled', selections: [] }] }] }).get('g')!
    expect(s.label).toBeNull()
  })
})

describe('computeGroupProgress', () => {
  it('counts answered vs total', () => {
    expect(computeGroupProgress([{ state: 'answered' }, { state: 'needs_answer' }])).toEqual({ answered: 1, total: 2, label: '1 of 2 answered' })
  })

  it('handles an empty list', () => {
    expect(computeGroupProgress([])).toEqual({ answered: 0, total: 0, label: '0 of 0 answered' })
  })
})

describe('estimateAnswerMinutes', () => {
  it('is 0 for no open questions', () => {
    expect(estimateAnswerMinutes(0)).toBe(0)
  })

  it('rounds 30s-per-question to the nearest minute, minimum 1', () => {
    expect(estimateAnswerMinutes(1)).toBe(1)
    expect(estimateAnswerMinutes(2)).toBe(1)
    expect(estimateAnswerMinutes(3)).toBe(2)
    expect(estimateAnswerMinutes(4)).toBe(2)
  })
})

describe('formatEntryCardLabel', () => {
  it('shows an all-caught-up message when nothing is open', () => {
    expect(formatEntryCardLabel(0)).toBe("You're all set ✓")
  })

  it('pluralises correctly', () => {
    expect(formatEntryCardLabel(1)).toBe('1 question needs your answer · ~1 min')
    expect(formatEntryCardLabel(3)).toBe('3 questions need your answer · ~2 min')
  })
})
