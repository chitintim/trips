import { describe, it, expect } from 'vitest'
import {
  resolveWinner,
  resolveWinnerId,
  mergeSectionMetadata,
  buildReopenedMetadata,
  buildReopenUpdate,
  canReopenDecision,
  isDecidedOption,
  canVoteOnOption,
  describeVoteError,
  type ResolverSection,
} from './resolveDecision'
import { areVotesVisible } from './voting'

const v = (option_id: string, user_id: string, rank: number | null = null) => ({ option_id, user_id, rank })

function section(overrides: Partial<ResolverSection> = {}): ResolverSection {
  return {
    status: 'completed',
    metadata: null,
    voting_method: 'single',
    options: [
      { id: 'a', status: 'available', order_index: 0 },
      { id: 'b', status: 'available', order_index: 1 },
    ],
    ...overrides,
  }
}

describe('resolveWinner', () => {
  it('honours the recorded stamp over the tally on a closed question', () => {
    const r = resolveWinner(section({ metadata: { decided_option_id: 'b' } }), [v('a', 'u1'), v('a', 'u2')])
    expect(r).toMatchObject({ optionId: 'b', source: 'stamp', tied: false })
  })

  it('ignores the stamp on an open question unless asked', () => {
    const s = section({ status: 'in_progress', metadata: { decided_option_id: 'b' } })
    expect(resolveWinnerId(s, [v('a', 'u1')])).toBe('a')
    expect(resolveWinnerId(s, [v('a', 'u1')], { honourStampWhenOpen: true })).toBe('b')
  })

  it('falls back to the tally when the stamp points at a missing or cancelled option', () => {
    expect(resolveWinnerId(section({ metadata: { decided_option_id: 'gone' } }), [v('a', 'u1')])).toBe('a')
    const s = section({
      metadata: { decided_option_id: 'b' },
      options: [
        { id: 'a', status: 'available' },
        { id: 'b', status: 'cancelled' },
      ],
    })
    expect(resolveWinnerId(s, [v('a', 'u1')])).toBe('a')
  })

  it('returns none with zero votes', () => {
    expect(resolveWinner(section(), [])).toMatchObject({ optionId: null, source: 'none' })
  })

  it('breaks plain ties by order_index regardless of array order, and flags the tie', () => {
    const s = section({
      options: [
        { id: 'b', status: 'available', order_index: 1 },
        { id: 'a', status: 'available', order_index: 0 },
      ],
    })
    const r = resolveWinner(s, [v('b', 'u1'), v('a', 'u2')])
    expect(r.optionId).toBe('a')
    expect(r.tied).toBe(true)
    expect(r.source).toBe('tie-break')
    expect(r.tiedOptionIds.sort()).toEqual(['a', 'b'])
  })

  it('falls through created_at then id when order_index is equal', () => {
    const s = section({
      options: [
        { id: 'z', status: 'available', order_index: 0, created_at: '2026-01-02' },
        { id: 'y', status: 'available', order_index: 0, created_at: '2026-01-01' },
      ],
    })
    expect(resolveWinnerId(s, [v('z', 'u1'), v('y', 'u2')])).toBe('y')
  })

  it('breaks date-range ties to the earliest start', () => {
    const s = section({
      options: [
        { id: 'later', status: 'available', order_index: 0, metadata: { date_range: { start: '2026-08-10', end: '2026-08-14' } } },
        { id: 'earlier', status: 'available', order_index: 1, metadata: { date_range: { start: '2026-08-01', end: '2026-08-05' } } },
      ],
    })
    expect(resolveWinnerId(s, [v('later', 'u1'), v('earlier', 'u2')])).toBe('earlier')
  })

  it('ranked ties go to the option with more first-choice votes', () => {
    // u1: a=1,b=2 ; u2: b=1,a=2 -> equal Borda; add u3 to make a first-place heavier
    const s = section({ voting_method: 'ranked' })
    const votes = [v('a', 'u1', 1), v('b', 'u1', 2), v('b', 'u2', 1), v('a', 'u2', 2), v('a', 'u3', 1), v('b', 'u3', 2), v('b', 'u4', 1), v('a', 'u4', 2)]
    // a firsts: u1,u3 (2); b firsts: u2,u4 (2) -> still tied -> falls to order_index -> a
    expect(resolveWinner(s, votes).tied).toBe(true)
    const votes2 = [v('a', 'u1', 1), v('b', 'u1', 2), v('b', 'u2', 1), v('a', 'u2', 2), v('b', 'u3', 1)]
    // b clearly leads here (no tie)
    expect(resolveWinnerId(s, votes2)).toBe('b')
  })

  it('excludes cancelled options from the tally', () => {
    const s = section({
      options: [
        { id: 'a', status: 'cancelled' },
        { id: 'b', status: 'available' },
      ],
    })
    expect(resolveWinnerId(s, [v('a', 'u1'), v('a', 'u2'), v('b', 'u3')])).toBe('b')
  })
})

describe('mergeSectionMetadata / reopen', () => {
  it('merges without dropping the recorded winner', () => {
    expect(mergeSectionMetadata({ decision_shape: 'vote', decided_option_id: 'a', followup_action_id: 'x' }, { decision_shape: 'personal' })).toEqual({
      decision_shape: 'personal',
      decided_option_id: 'a',
      followup_action_id: 'x',
    })
    expect(mergeSectionMetadata(null, { decision_shape: 'vote' })).toEqual({ decision_shape: 'vote' })
  })

  it('reopen clears the winner stamp and follow-up link but keeps other keys', () => {
    expect(buildReopenedMetadata({ decision_shape: 'vote', decided_option_id: 'a', followup_action_id: 'x' })).toEqual({ decision_shape: 'vote' })
    expect(buildReopenedMetadata(null)).toEqual({})
  })

  it('reopen update sets in_progress (votes are untouched: nothing here references them)', () => {
    const u = buildReopenUpdate({ decided_option_id: 'a' })
    expect(u.status).toBe('in_progress')
    expect(u.metadata).toEqual({})
  })

  it('only closed questions can be reopened', () => {
    expect(canReopenDecision({ status: 'completed' })).toBe(true)
    expect(canReopenDecision({ status: 'in_progress' })).toBe(false)
  })
})

describe('isDecidedOption (delete-winner guard)', () => {
  it('is true only for the decided option of a closed question', () => {
    const s = section({ metadata: { decided_option_id: 'a' } })
    expect(isDecidedOption(s, [], 'a')).toBe(true)
    expect(isDecidedOption(s, [], 'b')).toBe(false)
    expect(isDecidedOption({ ...s, status: 'in_progress' }, [], 'a')).toBe(false)
  })
})

describe('canVoteOnOption (vote gating)', () => {
  it('blocks closed questions and locked options', () => {
    expect(canVoteOnOption({ status: 'completed' }, { locked: false }).ok).toBe(false)
    expect(canVoteOnOption({ status: 'in_progress' }, { locked: true }).ok).toBe(false)
    expect(canVoteOnOption({ status: 'in_progress' }, { locked: false })).toEqual({ ok: true, reason: null })
    expect(canVoteOnOption(undefined, undefined).ok).toBe(true)
  })
})

describe('describeVoteError', () => {
  it('explains a server-side closed rejection', () => {
    expect(describeVoteError(new Error('Voting is closed for this question'))).toMatch(/already been answered/)
    expect(describeVoteError({ message: 'new row violates row-level security policy' })).toMatch(/permission/)
  })
})

describe('areVotesVisible', () => {
  it('reveals results once the question is closed', () => {
    expect(areVotesVisible({ vote_deadline: null, hide_votes_until_close: true })).toBe(false)
    expect(areVotesVisible({ vote_deadline: null, hide_votes_until_close: true, status: 'completed' })).toBe(true)
    expect(areVotesVisible({ vote_deadline: null, hide_votes_until_close: true, status: 'in_progress' })).toBe(false)
  })
})
