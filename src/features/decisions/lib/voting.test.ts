import { describe, it, expect } from 'vitest'
import { tallyVotes, getWinner, checkAutoClose, areVotesVisible, votingInstruction, replaceableSiblingVoteIds } from './voting'
import type { OptionVote } from '../../../lib/queries/usePlanning'

function vote(overrides: Partial<OptionVote> & { option_id: string; user_id: string }): OptionVote {
  return { id: `${overrides.option_id}-${overrides.user_id}`, rank: null, created_at: new Date().toISOString(), ...overrides }
}

describe('tallyVotes', () => {
  it('tallies single/approval votes as raw counts', () => {
    const votes = [vote({ option_id: 'x', user_id: '1' }), vote({ option_id: 'x', user_id: '2' }), vote({ option_id: 'y', user_id: '3' })]
    const tallies = tallyVotes(['x', 'y'], votes, 'single')
    expect(tallies.find((t) => t.optionId === 'x')?.score).toBe(2)
    expect(tallies.find((t) => t.optionId === 'y')?.score).toBe(1)
  })

  it('tallies ranked votes with a Borda-style weighting (lower rank = more points)', () => {
    // voter 1 ranks x=1, y=2 (max rank 2) -> x gets 2 pts, y gets 1 pt
    const votes = [vote({ option_id: 'x', user_id: '1', rank: 1 }), vote({ option_id: 'y', user_id: '1', rank: 2 })]
    const tallies = tallyVotes(['x', 'y'], votes, 'ranked')
    expect(tallies.find((t) => t.optionId === 'x')?.score).toBe(2)
    expect(tallies.find((t) => t.optionId === 'y')?.score).toBe(1)
  })

  it('returns zero score for options with no votes', () => {
    const tallies = tallyVotes(['x'], [], 'single')
    expect(tallies).toEqual([{ optionId: 'x', score: 0, voterIds: [] }])
  })
})

describe('getWinner', () => {
  it('returns the highest-scoring option', () => {
    const winner = getWinner([
      { optionId: 'x', score: 2, voterIds: [] },
      { optionId: 'y', score: 5, voterIds: [] },
    ])
    expect(winner?.optionId).toBe('y')
  })

  it('returns null when every option has zero votes', () => {
    expect(getWinner([{ optionId: 'x', score: 0, voterIds: [] }])).toBeNull()
  })

  it('returns null for an empty tally list', () => {
    expect(getWinner([])).toBeNull()
  })
})

describe('checkAutoClose', () => {
  const now = new Date('2026-07-07T12:00:00Z').getTime()

  it('reports deadline_passed once the deadline is in the past', () => {
    const result = checkAutoClose({ vote_deadline: '2026-07-01T00:00:00Z', quorum: null }, 0, now)
    expect(result).toEqual({ shouldClose: true, reason: 'deadline_passed' })
  })

  it('reports quorum_met once distinct voters reach quorum', () => {
    const result = checkAutoClose({ vote_deadline: null, quorum: 3 }, 3, now)
    expect(result).toEqual({ shouldClose: true, reason: 'quorum_met' })
  })

  it('does not close when neither condition is met', () => {
    const result = checkAutoClose({ vote_deadline: '2026-08-01T00:00:00Z', quorum: 10 }, 2, now)
    expect(result).toEqual({ shouldClose: false, reason: null })
  })
})

describe('areVotesVisible', () => {
  const now = new Date('2026-07-07T12:00:00Z').getTime()

  it('is visible immediately when hide_votes_until_close is false', () => {
    expect(areVotesVisible({ vote_deadline: '2027-01-01T00:00:00Z', hide_votes_until_close: false }, now)).toBe(true)
  })

  it('is hidden before the deadline when hide_votes_until_close is true', () => {
    expect(areVotesVisible({ vote_deadline: '2027-01-01T00:00:00Z', hide_votes_until_close: true }, now)).toBe(false)
  })

  it('becomes visible after the deadline passes', () => {
    expect(areVotesVisible({ vote_deadline: '2026-01-01T00:00:00Z', hide_votes_until_close: true }, now)).toBe(true)
  })

  it('is hidden with no deadline set and hide_votes_until_close true', () => {
    expect(areVotesVisible({ vote_deadline: null, hide_votes_until_close: true }, now)).toBe(false)
  })
})

describe('votingInstruction', () => {
  it('spells out pick-one vs pick-multiple semantics per method', () => {
    expect(votingInstruction('single')).toBe('Choose one')
    expect(votingInstruction('approval')).toBe('Choose all that apply')
    expect(votingInstruction('ranked')).toContain('Rank')
  })
})

describe('replaceableSiblingVoteIds', () => {
  const votes = [
    vote({ option_id: 'a', user_id: 'me' }),
    vote({ option_id: 'b', user_id: 'me' }),
    vote({ option_id: 'a', user_id: 'other' }),
    vote({ option_id: 'z', user_id: 'me' }), // different section
  ]

  it("returns my votes on the section's other options for single-choice casts", () => {
    expect(replaceableSiblingVoteIds(['a', 'b', 'c'], votes, 'me', 'c', 'single')).toEqual(['a-me', 'b-me'])
  })

  it('never touches other voters or other sections', () => {
    const ids = replaceableSiblingVoteIds(['a', 'b'], votes, 'me', 'b', 'single')
    expect(ids).toEqual(['a-me'])
  })

  it('returns nothing for approval/ranked methods', () => {
    expect(replaceableSiblingVoteIds(['a', 'b'], votes, 'me', 'b', 'approval')).toEqual([])
    expect(replaceableSiblingVoteIds(['a', 'b'], votes, 'me', 'b', 'ranked')).toEqual([])
  })
})
