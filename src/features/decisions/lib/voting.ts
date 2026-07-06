/**
 * Poll voting mechanics (plan §7): tally by voting_method, deadline/quorum
 * auto-close detection (client computes, organizer confirms — we never
 * silently mutate section state from here), and hidden-until-close vote
 * visibility rules.
 */
import type { OptionVote } from '../../../lib/queries/usePlanning'

export type VotingMethod = 'single' | 'approval' | 'ranked'

export interface OptionTally {
  optionId: string
  /** Raw vote count (single/approval) or Borda-style score (ranked). */
  score: number
  voterIds: string[]
}

/**
 * Tally votes for a set of options under one section.
 * - single/approval: score = number of votes (a user can only have one row
 *   per option per the option_votes unique constraint; approval allows
 *   voting for multiple options, single is enforced client-side to one
 *   option at a time when casting).
 * - ranked: score = sum of (N - rank) per voter, i.e. a lower `rank` number
 *   (1st choice) is worth more — classic Borda count. Ties broken by raw
 *   first-place vote count.
 */
export function tallyVotes(optionIds: string[], votes: OptionVote[], method: VotingMethod): OptionTally[] {
  const byOption = new Map<string, OptionVote[]>(optionIds.map((id) => [id, []]))
  for (const v of votes) {
    if (byOption.has(v.option_id)) byOption.get(v.option_id)!.push(v)
  }

  if (method !== 'ranked') {
    return optionIds.map((optionId) => {
      const optionVotes = byOption.get(optionId) || []
      return { optionId, score: optionVotes.length, voterIds: optionVotes.map((v) => v.user_id) }
    })
  }

  // Ranked: need the max rank any voter used, to compute Borda weights per voter.
  const voterMaxRank = new Map<string, number>()
  for (const v of votes) {
    if (v.rank == null) continue
    voterMaxRank.set(v.user_id, Math.max(voterMaxRank.get(v.user_id) || 0, v.rank))
  }

  return optionIds.map((optionId) => {
    const optionVotes = byOption.get(optionId) || []
    let score = 0
    for (const v of optionVotes) {
      if (v.rank == null) continue
      const maxRank = voterMaxRank.get(v.user_id) || v.rank
      score += maxRank - v.rank + 1
    }
    return { optionId, score, voterIds: optionVotes.map((v) => v.user_id) }
  })
}

export function getWinner(tallies: OptionTally[]): OptionTally | null {
  if (tallies.length === 0) return null
  const sorted = [...tallies].sort((a, b) => b.score - a.score)
  if (sorted[0].score === 0) return null
  return sorted[0]
}

export interface AutoCloseCheck {
  shouldClose: boolean
  reason: 'deadline_passed' | 'quorum_met' | null
}

/**
 * Client-side computation of whether a poll is ready to auto-close.
 * Per plan §7: "auto-close and announce the winner; organizer can
 * override" — this function only reports readiness, it never mutates
 * anything. The UI surfaces a banner/action for the organizer to confirm.
 */
export function checkAutoClose(
  section: { vote_deadline: string | null; quorum: number | null },
  distinctVoterCount: number,
  now: number = Date.now()
): AutoCloseCheck {
  if (section.vote_deadline && new Date(section.vote_deadline).getTime() <= now) {
    return { shouldClose: true, reason: 'deadline_passed' }
  }
  if (section.quorum && distinctVoterCount >= section.quorum) {
    return { shouldClose: true, reason: 'quorum_met' }
  }
  return { shouldClose: false, reason: null }
}

/**
 * Vote visibility per plan §7 (hide_votes_until_close default true):
 * before close, a participant sees only their own vote + the total vote
 * count (not the breakdown); after close (deadline passed, organizer
 * closed, or hide_votes_until_close is false), full breakdown is visible.
 */
export function areVotesVisible(
  section: { vote_deadline: string | null; hide_votes_until_close: boolean },
  now: number = Date.now()
): boolean {
  if (!section.hide_votes_until_close) return true
  if (section.vote_deadline && new Date(section.vote_deadline).getTime() <= now) return true
  return false
}
