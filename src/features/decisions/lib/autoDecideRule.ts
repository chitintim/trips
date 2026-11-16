/**
 * TypeScript reference of `public.auto_decide_question` (migration
 * 20261118090000_decide_and_book.sql): WHAT the scheduled job decides on its
 * own. It exists so the SQL rule has an executable specification that is
 * checked against the client's one winner rule (resolveDecision.resolveWinner)
 * in autoDecideRule.test.ts. It is not used at runtime.
 *
 * The SQL is NARROWER than resolveWinner on purpose:
 *   - it never decides a tie (resolveWinner would apply tie-breaks and flag
 *     `tied`; the job leaves a tie to an organizer), so it needs no tie-break;
 *   - it never decides when nobody answered;
 *   - ranked questions with a NULL-rank vote are skipped ('ranked_null_rank');
 *   - Own-choice questions, the Ideas bucket, questions that already have a
 *     booked option, date polls, finished trips, questions with no deadline /
 *     a deadline in the future, and trips with chase_settings.auto_decide =
 *     false are skipped;
 *   - only answers from people still in scope (active, not declined or
 *     cancelled) count, and there must be enough of them: the question's own
 *     `quorum` when it has one, otherwise at least half of the people in scope
 *     (rounded up, never fewer than one). Fewer -> 'not_enough_answers'.
 * Whenever it DOES decide, resolveWinner returns the same option with
 * tied = false. The skip order below is the SQL's order (the reason reported
 * is the first rule that applies).
 *
 * The tally is written independently of voting.ts (it mirrors the SQL
 * question_vote_tally) so the test compares two implementations.
 */
import type { Json } from '../../../types/database.types'
import type { ResolverOption, ResolverVote } from './resolveDecision'
import { isIdeasBucket } from '../../../lib/ideasBucket'

export type AutoDecideSkip =
  | 'already_decided'
  | 'trip_finished'
  | 'auto_decide_off'
  | 'own_choice'
  | 'no_deadline'
  | 'deadline_not_passed'
  | 'no_options'
  | 'date_poll'
  | 'ranked_null_rank'
  | 'no_answers'
  | 'ideas_bucket'
  | 'already_booked'
  | 'not_enough_answers'

export type AutoDecideOutcome =
  | { decided: true; optionId: string }
  | { decided: false; tied: true; tiedOptionIds: string[] }
  | { decided: false; skipped: 'not_enough_answers'; answered: number; needed: number }
  | { decided: false; skipped: Exclude<AutoDecideSkip, 'not_enough_answers'> }

/** The columns of trip_participants the rule reads. */
export interface AutoDecidePerson {
  user_id: string
  active: boolean | null
  confirmation_status: string | null
}

/** In scope = active and not declined/cancelled (same as the SQL and answers.isAnswerer). */
export function isInScope(p: AutoDecidePerson): boolean {
  return p.active !== false && p.confirmation_status !== 'declined' && p.confirmation_status !== 'cancelled'
}

export interface AutoDecideInput {
  section: {
    title: string
    status: string
    metadata: Json | null
    voting_method: string | null
    vote_deadline: string | null
    /** planning_sections.quorum (people needed before it may decide). */
    quorum?: number | null
    options: ResolverOption[]
  }
  /** trip_participants of the trip (everyone, in or out of scope). */
  participants: AutoDecidePerson[]
  /** trips.status. */
  tripStatus: string
  /** trips.chase_settings (jsonb, nullable). */
  chaseSettings: Json | null
  /** option_votes rows of the question (any option; non-live ones are ignored). */
  votes: ResolverVote[]
  now: Date
}

const OFF_VALUES = new Set(['false', 'off', 'no', '0'])

/** chase_settings.auto_decide: ABSENT or anything but false/"false"/"off"/"no"/"0" is ON (owner default). */
export function isAutoDecideEnabled(chaseSettings: Json | null | undefined): boolean {
  if (!chaseSettings || typeof chaseSettings !== 'object' || Array.isArray(chaseSettings)) return true
  const v = (chaseSettings as Record<string, Json | undefined>).auto_decide
  if (v === undefined || v === null) return true
  return !OFF_VALUES.has(String(v).toLowerCase())
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Mirror of question_vote_tally: score per live option, plus the live NULL-rank vote count. */
export function sqlTally(
  liveOptionIds: string[],
  votes: ResolverVote[],
  method: string | null
): { scores: Map<string, number>; nullRankVotes: number } {
  const live = new Set(liveOptionIds)
  const lv = votes.filter((v) => live.has(v.option_id))
  const scores = new Map<string, number>(liveOptionIds.map((id) => [id, 0]))
  if (method !== 'ranked') {
    for (const v of lv) scores.set(v.option_id, (scores.get(v.option_id) ?? 0) + 1)
    return { scores, nullRankVotes: 0 }
  }
  const maxRank = new Map<string, number>()
  for (const v of lv) if (v.rank != null) maxRank.set(v.user_id, Math.max(maxRank.get(v.user_id) ?? 0, v.rank))
  for (const v of lv) {
    if (v.rank == null) continue
    scores.set(v.option_id, (scores.get(v.option_id) ?? 0) + (maxRank.get(v.user_id)! - v.rank + 1))
  }
  return { scores, nullRankVotes: lv.filter((v) => v.rank == null).length }
}

/** What auto_decide_question does for this input. */
export function autoDecideOutcome(input: AutoDecideInput): AutoDecideOutcome {
  const { section } = input
  if (section.status === 'completed') return { decided: false, skipped: 'already_decided' }
  if (input.tripStatus === 'trip_completed') return { decided: false, skipped: 'trip_finished' }
  if (!isAutoDecideEnabled(input.chaseSettings)) return { decided: false, skipped: 'auto_decide_off' }
  if (isObject(section.metadata) && section.metadata.decision_shape === 'personal') return { decided: false, skipped: 'own_choice' }
  if (isIdeasBucket(section)) return { decided: false, skipped: 'ideas_bucket' }
  if (section.options.some((o) => o.status === 'booked')) return { decided: false, skipped: 'already_booked' }
  if (!section.vote_deadline) return { decided: false, skipped: 'no_deadline' }
  if (new Date(section.vote_deadline).getTime() > input.now.getTime()) return { decided: false, skipped: 'deadline_not_passed' }

  const live = section.options.filter((o) => o.status !== 'cancelled')
  if (live.length === 0) return { decided: false, skipped: 'no_options' }
  const hasDateRange = (o: ResolverOption) => isObject(o.metadata) && isObject(o.metadata.date_range)
  if (section.title.trim().toLowerCase() === 'trip dates' || live.some(hasDateRange)) return { decided: false, skipped: 'date_poll' }

  const inScope = input.participants.filter(isInScope)
  const inScopeIds = new Set(inScope.map((p) => p.user_id))
  const votes = input.votes.filter((x) => inScopeIds.has(x.user_id))
  const { scores, nullRankVotes } = sqlTally(
    live.map((o) => o.id),
    votes,
    section.voting_method
  )
  if (nullRankVotes > 0) return { decided: false, skipped: 'ranked_null_rank' }
  const top = Math.max(...scores.values())
  if (!(top > 0)) return { decided: false, skipped: 'no_answers' }

  const liveIds = new Set(live.map((o) => o.id))
  const answered = new Set(votes.filter((x) => liveIds.has(x.option_id)).map((x) => x.user_id)).size
  const needed = section.quorum && section.quorum > 0 ? section.quorum : Math.max(1, Math.ceil(inScope.length / 2))
  if (answered < needed) return { decided: false, skipped: 'not_enough_answers', answered, needed }

  const leaders = [...scores.entries()].filter(([, s]) => s === top).map(([id]) => id)
  if (leaders.length > 1) return { decided: false, tied: true, tiedOptionIds: leaders }
  return { decided: true, optionId: leaders[0] }
}
