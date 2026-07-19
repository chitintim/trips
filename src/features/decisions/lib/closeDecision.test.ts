import { describe, it, expect } from 'vitest'
import {
  buildDecisionMetadata,
  followupActionTitle,
  readDecidedOptionId,
  readFollowupActionId,
  resolveDecidedOptionId,
  resolveTallyLeaderId,
  type ResolvableSection,
} from './closeDecision'
import type { OptionVote } from '../../../lib/queries/usePlanning'

function vote(overrides: Partial<OptionVote> & { option_id: string; user_id: string }): OptionVote {
  return { id: `${overrides.option_id}-${overrides.user_id}`, rank: null, created_at: new Date().toISOString(), ...overrides }
}

function section(overrides: Partial<ResolvableSection> = {}): ResolvableSection {
  return {
    status: 'completed',
    metadata: null,
    voting_method: 'single',
    options: [
      { id: 'a', status: 'available' },
      { id: 'b', status: 'available' },
    ],
    ...overrides,
  }
}

describe('buildDecisionMetadata', () => {
  it('merges the stamp without dropping existing keys (decision_shape survives a close)', () => {
    const merged = buildDecisionMetadata({ decision_shape: 'vote' }, { decided_option_id: 'a' })
    expect(merged).toEqual({ decision_shape: 'vote', decided_option_id: 'a' })
  })

  it('handles null/array/scalar existing metadata safely', () => {
    expect(buildDecisionMetadata(null, { decided_option_id: 'a' })).toEqual({ decided_option_id: 'a' })
    expect(buildDecisionMetadata([1, 2] as never, { decided_option_id: 'a' })).toEqual({ decided_option_id: 'a' })
  })
})

describe('readDecidedOptionId / readFollowupActionId', () => {
  it('reads the stamps back and returns null when absent or wrong-typed', () => {
    expect(readDecidedOptionId({ decided_option_id: 'a' })).toBe('a')
    expect(readDecidedOptionId({ decided_option_id: 7 } as never)).toBeNull()
    expect(readDecidedOptionId(null)).toBeNull()
    expect(readFollowupActionId({ followup_action_id: 'act-1' })).toBe('act-1')
    expect(readFollowupActionId({})).toBeNull()
  })
})

describe('resolveTallyLeaderId', () => {
  it('returns the leading option and ignores cancelled options', () => {
    const s = section({
      status: 'in_progress',
      options: [
        { id: 'a', status: 'available' },
        { id: 'b', status: 'cancelled' },
      ],
    })
    const votes = [vote({ option_id: 'a', user_id: 'u1' }), vote({ option_id: 'b', user_id: 'u2' }), vote({ option_id: 'b', user_id: 'u3' })]
    expect(resolveTallyLeaderId(s, votes)).toBe('a')
  })

  it('returns null when nobody has voted', () => {
    expect(resolveTallyLeaderId(section(), [])).toBeNull()
  })
})

describe('resolveDecidedOptionId', () => {
  it('returns null for open sections regardless of votes', () => {
    const s = section({ status: 'in_progress' })
    expect(resolveDecidedOptionId(s, [vote({ option_id: 'a', user_id: 'u1' })])).toBeNull()
  })

  it('prefers the explicit metadata stamp (organizer override) over the tally leader', () => {
    const s = section({ metadata: { decided_option_id: 'b' } })
    const votes = [vote({ option_id: 'a', user_id: 'u1' }), vote({ option_id: 'a', user_id: 'u2' })]
    expect(resolveDecidedOptionId(s, votes)).toBe('b')
  })

  it('ignores a stamp pointing at an option that no longer exists and falls back to the tally', () => {
    const s = section({ metadata: { decided_option_id: 'gone' } })
    expect(resolveDecidedOptionId(s, [vote({ option_id: 'a', user_id: 'u1' })])).toBe('a')
  })

  it('falls back to the tally leader for legacy closed sections with no stamp', () => {
    expect(resolveDecidedOptionId(section(), [vote({ option_id: 'b', user_id: 'u1' })])).toBe('b')
  })
})

describe('followupActionTitle', () => {
  it('quotes the winner title', () => {
    expect(followupActionTitle('Chalet Bergerie')).toBe('Book "Chalet Bergerie"')
  })
})
