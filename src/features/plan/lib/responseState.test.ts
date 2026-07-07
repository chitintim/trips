import { describe, it, expect } from 'vitest'
import {
  computeVoteQuestionState,
  computePersonalQuestionState,
  computeQuestionState,
  computeGroupProgress,
  estimateAnswerMinutes,
  formatEntryCardLabel,
} from './responseState'
import type { OptionVote, OptionWithSelections } from '../../../lib/queries/usePlanning'

function vote(overrides: Partial<OptionVote> & { option_id: string; user_id: string }): OptionVote {
  return { id: `${overrides.option_id}-${overrides.user_id}`, rank: null, created_at: new Date().toISOString(), ...overrides }
}

function option(overrides: Partial<OptionWithSelections> & { id: string; title: string }): OptionWithSelections {
  return {
    section_id: 's1',
    created_at: '',
    updated_at: '',
    currency: 'GBP',
    description: null,
    locked: false,
    metadata: null,
    order_index: 0,
    place_id: null,
    price: null,
    price_type: 'per_person_fixed',
    status: 'available',
    selections: [],
    ...overrides,
  }
}

describe('computeVoteQuestionState', () => {
  const section = { id: 's1', metadata: null, options: [{ id: 'o1' }, { id: 'o2' }] }

  it('needs_you when the viewer has not voted', () => {
    const votes = [vote({ option_id: 'o1', user_id: 'someone-else' })]
    const state = computeVoteQuestionState(section, votes, 5, 'me')
    expect(state.state).toBe('needs_you')
    expect(state.label).toBe('Needs you')
    expect(state.respondedCount).toBe(1)
  })

  it('done when the viewer has voted on any option in the section', () => {
    const votes = [vote({ option_id: 'o2', user_id: 'me' })]
    const state = computeVoteQuestionState(section, votes, 5, 'me')
    expect(state.state).toBe('done')
    expect(state.label).toBe("You're done ✓")
  })

  it('needs_you when there is no current user', () => {
    const state = computeVoteQuestionState(section, [], 5, null)
    expect(state.state).toBe('needs_you')
  })

  it('only counts votes for this section\'s own options', () => {
    const votes = [vote({ option_id: 'other-section-option', user_id: 'me' })]
    const state = computeVoteQuestionState(section, votes, 5, 'me')
    expect(state.state).toBe('needs_you')
    expect(state.respondedCount).toBe(0)
  })
})

describe('computePersonalQuestionState', () => {
  it('needs_you (fill in your order) when the viewer has no selections', () => {
    const section = { id: 's1', metadata: { decision_shape: 'personal' as const }, options: [option({ id: 'o1', title: 'Skis', metadata: { pricing: { flat: 40 } } })] }
    const state = computePersonalQuestionState(section, 5, 'me', 'GBP')
    expect(state.state).toBe('needs_you')
    expect(state.label).toBe('Fill in your order')
  })

  it('done with the live order total when the viewer has selections', () => {
    const section = {
      id: 's1',
      metadata: { decision_shape: 'personal' as const },
      options: [
        option({
          id: 'o1',
          title: 'Skis',
          currency: 'GBP',
          metadata: { pricing: { per_day: 10 } },
          selections: [{ id: 'sel-1', option_id: 'o1', user_id: 'me', selected_at: '', metadata: { start_date: '2026-08-01', end_date: '2026-08-05' } }] as never,
        }),
      ],
    }
    const state = computePersonalQuestionState(section, 5, 'me', 'GBP')
    expect(state.state).toBe('done')
    expect(state.label).toBe('Your order: £50 ✓')
  })

  it('done (own-state fix) when the viewer has a bare legacy selection with no metadata and the option has no catalog pricing at all', () => {
    // Models a pre-v3 trip stamped decision_shape:'personal' by the
    // 20260707160000_legacy_sections_to_personal migration: `selections`
    // rows there carry no {start_date,end_date,variant,quantity} metadata
    // and options carry no metadata.pricing, since neither concept existed
    // in the legacy app. The viewer still committed a pick and must read
    // as done, not "Fill in your order".
    const section = {
      id: 's1',
      metadata: { decision_shape: 'personal' as const, legacy_migrated: true },
      options: [
        option({
          id: 'o1',
          title: 'Le Refuge (restaurant)',
          metadata: null,
          selections: [{ id: 'sel-1', option_id: 'o1', user_id: 'me', selected_at: '', metadata: null }] as never,
        }),
      ],
    }
    const state = computePersonalQuestionState(section, 5, 'me', 'GBP')
    expect(state.state).toBe('done')
    expect(state.label).toBe("You're done ✓")
  })

  it('counts consistent: respondedCount matches distinct pickers across a legacy multi-select section with no pricing anywhere (e.g. Meribel\'s "Ski Equipment Rental")', () => {
    const section = {
      id: 'ski',
      metadata: { decision_shape: 'personal' as const, legacy_migrated: true },
      options: [
        option({
          id: 'ski-adult',
          title: 'Adult skis',
          metadata: null,
          selections: [
            { id: 's1', option_id: 'ski-adult', user_id: 'alex', selected_at: '', metadata: null },
            { id: 's2', option_id: 'ski-adult', user_id: 'sarah', selected_at: '', metadata: null },
          ] as never,
        }),
        option({
          id: 'ski-own',
          title: 'I have my own skis',
          metadata: null,
          selections: [{ id: 's3', option_id: 'ski-own', user_id: 'pat', selected_at: '', metadata: null }] as never,
        }),
      ],
    }
    const state = computePersonalQuestionState(section, 10, 'alex', 'GBP')
    expect(state.respondedCount).toBe(3)
    expect(state.state).toBe('done')
  })

  it('counts respondedCount across all participants, not just the viewer', () => {
    const section = {
      id: 's1',
      metadata: { decision_shape: 'personal' as const },
      options: [
        option({
          id: 'o1',
          title: 'Skis',
          metadata: { pricing: { flat: 40 } },
          selections: [
            { id: 'sel-1', option_id: 'o1', user_id: 'alice', selected_at: '', metadata: null },
            { id: 'sel-2', option_id: 'o1', user_id: 'bob', selected_at: '', metadata: null },
          ] as never,
        }),
      ],
    }
    const state = computePersonalQuestionState(section, 5, 'me', 'GBP')
    expect(state.respondedCount).toBe(2)
    expect(state.state).toBe('needs_you') // viewer ("me") has no selection of their own
  })
})

describe('computeQuestionState dispatch', () => {
  it('dispatches to vote logic by default', () => {
    const section = { id: 's1', metadata: null, options: [{ id: 'o1' } as OptionWithSelections] }
    const state = computeQuestionState(section, [], 5, 'me', 'GBP')
    expect(state.shape).toBe('vote')
  })

  it('dispatches to personal logic when decision_shape is personal', () => {
    const section = { id: 's1', metadata: { decision_shape: 'personal' as const }, options: [] }
    const state = computeQuestionState(section, [], 5, 'me', 'GBP')
    expect(state.shape).toBe('personal')
  })
})

describe('computeGroupProgress', () => {
  it('counts done vs total', () => {
    const states = [
      { sectionId: 'a', shape: 'vote' as const, state: 'done' as const, label: '', respondedCount: 1, totalParticipants: 5 },
      { sectionId: 'b', shape: 'vote' as const, state: 'needs_you' as const, label: '', respondedCount: 0, totalParticipants: 5 },
    ]
    expect(computeGroupProgress(states)).toEqual({ answered: 1, total: 2, label: '1 of 2 answered' })
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
    expect(estimateAnswerMinutes(1)).toBe(1) // 30s -> rounds up to 1
    expect(estimateAnswerMinutes(2)).toBe(1) // 60s -> 1 min
    expect(estimateAnswerMinutes(3)).toBe(2) // 90s -> rounds to 2
    expect(estimateAnswerMinutes(4)).toBe(2) // 120s -> 2 min
  })
})

describe('formatEntryCardLabel', () => {
  it('shows an all-caught-up message when nothing is open', () => {
    expect(formatEntryCardLabel(0)).toBe("You're all caught up")
  })

  it('pluralises correctly for one open question', () => {
    expect(formatEntryCardLabel(1)).toBe('1 thing needs you · ~1 min')
  })

  it('pluralises correctly for multiple open questions', () => {
    expect(formatEntryCardLabel(3)).toBe('3 things need you · ~2 min')
  })
})
